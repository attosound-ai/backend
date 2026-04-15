#!/usr/bin/env bash
# ============================================================
# Start all ATTO SOUND backend services locally
# pointing to PRODUCTION databases (Railway).
#
# Services run natively; Kafka, Cassandra & Kong run in Docker.
# Each service reads its .env which already has prod DB URLs.
# ============================================================
set -eo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SERVICES="$ROOT/services"
INFRA="$ROOT/infra"
LOG_DIR="$ROOT/.logs"
mkdir -p "$LOG_DIR"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $1"; }
err()   { echo -e "${RED}[ERR]${NC}   $1"; }

# ── Cleanup on exit ──
PIDS=()
cleanup() {
  echo ""
  warn "Shutting down services..."
  for pid in "${PIDS[@]+"${PIDS[@]}"}"; do
    kill "$pid" 2>/dev/null || true
  done
  info "Stopping Docker containers..."
  docker compose -f "$INFRA/docker-compose.yml" stop kafka zookeeper cassandra 2>/dev/null || true
  docker stop atto-kong-local 2>/dev/null || true
  docker rm atto-kong-local 2>/dev/null || true
  ok "All stopped."
}
trap cleanup EXIT INT TERM

# ── 1. Start Docker infrastructure ──
info "Starting Kafka + Zookeeper + Cassandra..."
docker compose -f "$INFRA/docker-compose.yml" up -d zookeeper kafka cassandra

info "Starting Kong gateway (routes to host.docker.internal)..."
docker rm -f atto-kong-local 2>/dev/null || true
docker run -d \
  --name atto-kong-local \
  -p 8088:8000 \
  -p 8089:8001 \
  -v "$ROOT/gateway/kong-local.yml:/kong/kong.yml:ro" \
  -e KONG_DATABASE=off \
  -e KONG_DECLARATIVE_CONFIG=/kong/kong.yml \
  -e KONG_PROXY_LISTEN="0.0.0.0:8000" \
  -e KONG_ADMIN_LISTEN="0.0.0.0:8001" \
  -e KONG_LOG_LEVEL=info \
  -e KONG_PLUGINS=bundled \
  kong:3.5

info "Waiting for Kafka to be ready..."
until docker compose -f "$INFRA/docker-compose.yml" exec -T kafka \
  kafka-broker-api-versions --bootstrap-server localhost:9092 >/dev/null 2>&1; do
  sleep 2
done
ok "Kafka ready."

# ── 2. Start native services ──

# Helper: start a service in the background
# Sources the service's .env before executing so Go/Python/Rust services
# (which do not auto-load dotenv) see DATABASE_URL, STRIPE_SECRET_KEY, etc.
start_service() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local logfile="$LOG_DIR/$name.log"

  info "Starting $name..."
  cd "$dir"
  (
    set -a
    [ -f .env ] && . ./.env
    set +a
    eval "$cmd"
  ) > "$logfile" 2>&1 &
  local pid=$!
  PIDS+=("$pid")
  ok "$name started (PID $pid, log: .logs/$name.log)"
}

# ── user-service (Go, port 8080) ──
start_service "user-service" "$SERVICES/user-service" \
  "go run ./cmd/server"

# ── social-service (NestJS, port 3100 — shifted from 3000 to avoid imagiq-frontend) ──
if [ ! -d "$SERVICES/social-service/node_modules" ]; then
  info "Installing social-service deps..."
  (cd "$SERVICES/social-service" && npm install --silent)
fi
start_service "social-service" "$SERVICES/social-service" \
  "PORT=3100 npx nest start --watch"

# ── content-service (Rust, port 8081) ──
start_service "content-service" "$SERVICES/content-service" \
  "HTTP_PORT=8081 cargo run"

# ── chat-service (Elixir/Phoenix, port 4000) ──
if [ ! -d "$SERVICES/chat-service/deps" ]; then
  info "Installing chat-service deps..."
  (cd "$SERVICES/chat-service" && mix deps.get)
fi
start_service "chat-service" "$SERVICES/chat-service" \
  "mix phx.server"

# ── payment-service (Python/FastAPI, port 8000) ──
if [ ! -d "$SERVICES/payment-service/.venv" ]; then
  info "Creating payment-service venv..."
  (cd "$SERVICES/payment-service" && python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt)
fi
start_service "payment-service" "$SERVICES/payment-service" \
  ".venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100 --reload"

# ── otp-service (Go, port 8001 to avoid conflict with payment) ──
start_service "otp-service" "$SERVICES/otp-service" \
  "HTTP_PORT=8001 go run main.go"

# ── telephony-service (NestJS, port 3109 — shifted from 3009 to avoid imagiq addresses-ms) ──
if [ ! -d "$SERVICES/telephony-service/node_modules" ]; then
  info "Installing telephony-service deps..."
  (cd "$SERVICES/telephony-service" && npm install --silent)
fi
start_service "telephony-service" "$SERVICES/telephony-service" \
  "PORT=3109 npx nest start --watch"

# ── email-service (NestJS, port 3005) ──
if [ ! -d "$SERVICES/email-service/node_modules" ]; then
  info "Installing email-service deps..."
  (cd "$SERVICES/email-service" && npm install --silent)
fi
start_service "email-service" "$SERVICES/email-service" \
  "npx nest start --watch"

# ── 3. Done ──
echo ""
echo "============================================"
ok "All services started with PRODUCTION databases"
echo "============================================"
echo ""
echo "  Gateway:      http://localhost:8088/api/v1/"
echo "  Kong Admin:   http://localhost:8089"
echo ""
echo "  Services:"
echo "    user-service       :8080  (Go)"
echo "    social-service     :3100  (NestJS)  [shifted: was 3000]"
echo "    content-service    :8081  (Rust)"
echo "    chat-service       :4000  (Elixir)"
echo "    payment-service    :8100  (Python)  [shifted: was 8000]"
echo "    otp-service        :8001  (Go)"
echo "    telephony-service  :3109  (NestJS)  [shifted: was 3009]"
echo "    email-service      :3005  (NestJS)"
echo ""
echo "  Logs: $LOG_DIR/"
echo ""
echo "  Press Ctrl+C to stop all services."
echo ""

# Keep script alive, watching for dead processes
while true; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      err "A service (PID ${PIDS[$i]}) died. Check logs in $LOG_DIR/"
    fi
  done
  sleep 5
done
