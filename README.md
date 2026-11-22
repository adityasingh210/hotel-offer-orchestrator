# Hotel Offer Orchestrator

Gets hotel offers from two suppliers, removes duplicate hotels by name, keeps the best price for each hotel, and filters the list by price range in Redis. **Temporal** runs the steps.

**Stack:** Node.js 20 (TypeScript), Express, Temporal, Redis, Docker Compose

---

## Architecture

```
                 ┌──────────────────────── api (Express) ────────────────────────┐
 Client ───────► │ GET /api/hotels      GET /health      GET /supplierA|B/hotels │
                 └───────┬──────────────────────┬────────────────────▲──────────┘
                         │ start workflow       │ ZRANGE BYSCORE     │ HTTP
                         ▼                      ▼                    │
                   ┌──────────┐            ┌─────────┐        ┌──────┴──────┐
                   │ Temporal │◄──────────►│  Redis  │◄───────│   worker    │
                   │  server  │ task queue └─────────┘ ZADD   │ (workflow + │
                   └──────────┘                               │ activities) │
                                                              └─────────────┘
```

| Service | What it does |
|---|---|
| `api` | Public endpoints, the two mock supplier endpoints and `/health`. Starts the Temporal workflow. |
| `worker` | Temporal worker. Runs `hotelOffersWorkflow` and its activities. |
| `temporal` + `postgresql` | Temporal server (`auto-setup` image) |
| `temporal-ui` | Web UI for workflow history: http://localhost:8080 |
| `redis` | Stores the deduplicated list and does the price filtering |

### Workflow: `hotelOffersWorkflow({ city })`

1. **Parallel fetch.** Calls the `fetchSupplierHotels` activity for Supplier A and Supplier B with `Promise.allSettled`. Each activity has its own retry policy: 3 attempts with exponential backoff and a 5s timeout. A 5xx response or network error is retried. A 4xx response or invalid payload is not retried.
2. **Partial failure.** If one supplier still fails after its retries, the workflow logs it and continues with the other supplier's hotels. If both fail, it throws the non-retryable `AllSuppliersUnavailable` error and the API returns `502`.
3. **Dedupe and pick the best offer** (`src/domain/selectBestOffers.ts`). This is a pure function, so it is deterministic and safe to run inside the workflow.
   - Hotels are matched by name, ignoring case and extra spaces.
   - If both suppliers list a hotel, the cheaper offer wins. If the prices are equal, the higher `commissionPct` wins.
   - If only one supplier lists a hotel, that offer is kept.
   - The result is sorted by price, lowest first.
4. **Save to Redis.** The `cacheHotels` activity saves the list.
   - A full result is cached for `CACHE_TTL_SECONDS`.
   - A partial result (one supplier was down) is cached for only `PARTIAL_CACHE_TTL_SECONDS`, so incomplete data expires quickly.
   - If this step fails, the workflow logs it and still returns the list.

### Request coalescing

Each city has one workflow ID, `hotel-offers-<city>`, and the workflow is started with the `USE_EXISTING` conflict policy. If many requests for the same city arrive while a run is in progress, they all attach to that run. The suppliers are called once instead of once per request. After the run finishes, the next request starts a new run.

### Redis layout and price filtering

```
hotels:{city}        ZSET    score = price, member = JSON offer
hotels:{city}:meta   STRING  { updatedAt, count }   ← marks the city as cached (even with 0 hotels)
```

- Both keys are written in one `MULTI` transaction and share the same TTL (`CACHE_TTL_SECONDS`, default 300).
- Price filtering runs in Redis with `ZRANGE hotels:{city} <min> <max> BYSCORE`. When a bound is missing, `-inf` or `+inf` is used.

### Request flow

| Request | Behaviour |
|---|---|
| `GET /api/hotels?city=delhi` | Always runs the workflow, so the data is fresh and the Redis cache is refreshed. |
| `GET /api/hotels?city=delhi&minPrice=..&maxPrice=..` | Filters in Redis. On a cache miss, it runs the workflow first and then filters in Redis. |

Response headers:

- `X-Data-Source: workflow | cache`
- `X-Degraded-Suppliers: Supplier B`. This header is only sent when a supplier failed and the result is partial.
- `X-Request-Id`. Taken from the incoming `X-Request-Id` header or generated. It is also included in the logs, in error bodies and in the workflow memo, so one request can be traced across the API, logs and Temporal UI.

---

## API

### `GET /api/hotels?city=delhi`

```json
[
  { "name": "Bloomrooms", "price": 2800, "supplier": "Supplier B", "commissionPct": 9 },
  { "name": "Lemon Tree", "price": 3200, "supplier": "Supplier A", "commissionPct": 8 },
  { "name": "Holtin",     "price": 5340, "supplier": "Supplier B", "commissionPct": 20 },
  { "name": "Radison",    "price": 5900, "supplier": "Supplier A", "commissionPct": 13 }
]
```

The list above is shortened. Delhi returns 8 hotels.

### `GET /api/hotels?city=delhi&minPrice=5000&maxPrice=8000`

Returns the same format, filtered by price. Both `minPrice` and `maxPrice` are optional.

### Errors

| Status | When |
|---|---|
| `400` | `city` is missing or invalid, a price is not a non-negative number, or `minPrice` is greater than `maxPrice` |
| `502` | All suppliers are unavailable |
| `503` | Temporal is not connected yet |

A city with no hotels (for example `goa`) returns `200 []`.

### Mock suppliers

- `GET /supplierA/hotels` and `GET /supplierB/hotels` return static JSON. You can add `?city=delhi` to filter by city.
- Hotels exist for `delhi`, `mumbai` and `bangalore`. Several hotel names, such as Holtin, Radison, Taj Palace and The Leela, appear in both suppliers.
- To simulate an outage, call `POST /admin/suppliers/{supplierA|supplierB}/{down|up}`. The supplier then returns `503`. You can also start a supplier down with the env vars `SUPPLIER_A_DOWN=true` or `SUPPLIER_B_DOWN=true`.

### `GET /health` (bonus)

`GET /health/live` is a simple liveness probe that only checks the process is serving HTTP. Docker Compose uses it as the API container's healthcheck.

`GET /health` probes both supplier endpoints over HTTP and checks Redis and Temporal. Returns `200` when everything is up and `503` when anything is down.

```json
{
  "status": "degraded",
  "suppliers": [
    { "name": "Supplier A", "status": "up",   "httpStatus": 200, "latencyMs": 17 },
    { "name": "Supplier B", "status": "down", "httpStatus": 503, "latencyMs": 7 }
  ],
  "dependencies": { "redis": "up", "temporal": "up" }
}
```

---

## Run with Docker (recommended)

Requirements: Docker with Docker Compose v2.

```bash
git clone <repo-url> && cd hotel-offer-orchestrator
docker compose up -d --build
```

Temporal needs about 20–30 seconds to set up its database on the first start. The API and the worker keep retrying until it is ready. Check the status with:

```bash
curl http://localhost:3000/health
curl "http://localhost:3000/api/hotels?city=delhi"
curl "http://localhost:3000/api/hotels?city=delhi&minPrice=5000&maxPrice=8000"
```

- Temporal UI: http://localhost:8080. Every request shows up there as a `hotel-offers-<city>-<uuid>` workflow.
- Logs: `docker compose logs -f api worker`
- Stop: `docker compose down`. Add `-v` to also delete the Temporal database.

## Run locally without Docker

Requirements: Node 20+, a Redis server and the [Temporal CLI](https://docs.temporal.io/cli).

```bash
npm install
cp .env.example .env              # optional, the defaults work locally
temporal server start-dev         # terminal 1 (Temporal at :7233, UI at :8233)
redis-server                      # terminal 2
npm run build
npm run start:api                 # terminal 3
npm run start:worker              # terminal 4
```

For development with auto-reload, use `npm run dev:api` and `npm run dev:worker`.

## Tests

```bash
redis-server &          # integration tests use a real Redis (REDIS_URL); they are skipped if it is not reachable
npm test                # 21 tests
TEMPORAL_TESTS=1 npm test   # also runs the workflow tests (downloads Temporal's test server once)
```

| Suite | What it covers |
|---|---|
| `domain/selectBestOffers.test.ts` | Dedupe, cheaper offer wins, single-supplier hotels, case and spacing in names, price tie broken by commission, invalid entries |
| `temporal/activities.test.ts` | Runs with Temporal's `MockActivityEnvironment`. Correct supplier URL and city filter, 5xx is retryable, 4xx and bad payloads are non-retryable, partial results get the short TTL |
| `temporal/workflows.test.ts` | Runs on Temporal's time-skipping test server with mocked activities. Best offer per hotel, partial result when one supplier fails, `AllSuppliersUnavailable` when both fail, hotels still returned when caching fails |
| `app.test.ts` | Express and real Redis with a fake Temporal client. Response format, request coalescing ID, Redis filter (cache hit and miss), empty city, partial result, `502`, validation, `503` while Temporal is down, `/health` |

GitHub Actions (`.github/workflows/ci.yml`) runs every suite, including the workflow tests, against a Redis service. It also builds the Docker image.

### Postman

Import `postman/hotel-offer-orchestrator.postman_collection.json` and run the folders in order with the Collection Runner. The `baseUrl` variable defaults to `http://localhost:3000`. The collection covers:
  1. health
  2. mock suppliers
  3. `delhi` with overlaps, price-range filters, a city with no results (`goa`) and validation errors
  4. Supplier B down (partial result and degraded header), both suppliers down (`502`), then restoring both

## Configuration

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | API port |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend |
| `TEMPORAL_NAMESPACE` | `default` | |
| `TASK_QUEUE` | `hotel-offers` | |
| `REDIS_URL` | `redis://localhost:6379` | |
| `SUPPLIER_BASE_URL` | `http://localhost:3000` | Where the worker reaches the mock suppliers |
| `SUPPLIER_TIMEOUT_MS` | `3000` | Timeout for each supplier HTTP call |
| `CACHE_TTL_SECONDS` | `300` | TTL for the Redis keys |
| `PARTIAL_CACHE_TTL_SECONDS` | `30` | TTL when a supplier was down (partial result) |
| `LOG_LEVEL` | `info` | pino log level |

## Logging and error handling (bonus)

- **Structured JSON logs** with pino. Each line is tagged with the service name (`api` or `worker`). Every HTTP request is logged with its status and latency.
- **Workflow and activity logs** use Temporal's built-in loggers (`log` and `Context.current().log`). They record each supplier call, the attempt number, retries, failures, the result count and the cache result.
- **Retries:**
  - Transient supplier errors (5xx, timeout, network) are retried.
  - Permanent errors (4xx, bad payload) fail fast with `ApplicationFailure.nonRetryable`.
- **Graceful degradation:**
  - If one supplier is down, the API still returns a partial result and sets a header saying so.
  - If Redis is down, the workflow still returns hotels and the price filter falls back to filtering in memory.
- **Graceful shutdown** on SIGINT and SIGTERM for both the API and the worker.
- **Request IDs** appear in every log line, error response and workflow memo.

## Project structure

```
src/
  app.ts                      Express routes: /api/hotels, /health, error handling
  server.ts                   API entry point (connects to Temporal and Redis)
  worker.ts                   Temporal worker entry point
  config.ts, logger.ts, types.ts
  domain/selectBestOffers.ts  Dedupe and best-price logic
  cache/hotelCache.ts         Redis sorted-set save and price-range query
  suppliers/                  Mock supplier data, routes and the outage toggle
  temporal/workflows.ts       hotelOffersWorkflow
  temporal/activities.ts      fetchSupplierHotels, cacheHotels
  **/*.test.ts                 Unit, activity, workflow and API tests
postman/                      Postman collection
.github/workflows/ci.yml      CI: tests + Docker build
Dockerfile, docker-compose.yml
```

## Design notes

- **One image, two processes.** The API and the worker are built from the same image and started with different commands. This lets the worker scale on its own.
- **Mock suppliers run inside the API service**, as the assignment asks. The worker calls them over HTTP, the same way it would call real suppliers.
- **The partial result is a deliberate choice.** Losing one supplier should not hide the other supplier's inventory. The partial list gets a short TTL so complete data comes back quickly.
- **Unfiltered requests always run the workflow, and filtered requests read from Redis.** The full list is always fresh, while price filtering, which is the read-heavy path, is served from Redis.
