#!/bin/sh
# Starts every process the demo needs inside one container (Render free plan).
set -e

redis-server --daemonize yes --save "" --appendonly no --bind 127.0.0.1
temporal server start-dev --ip 127.0.0.1 --headless --log-level warn &

export SUPPLIER_BASE_URL="http://127.0.0.1:${PORT:-10000}"
node dist/worker.js &

# The API is the main process; Render routes traffic to $PORT.
exec node dist/server.js
