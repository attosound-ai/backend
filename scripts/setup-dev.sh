#!/usr/bin/env bash
set -euo pipefail

echo "╔═══════════════════════════════════════════╗"
echo "║   Atto Sound - Development Environment    ║"
echo "╚═══════════════════════════════════════════╝"
echo ""

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${ROOT_DIR}"

# ── Check prerequisites ──
echo "Checking prerequisites..."

check_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "  ✗ $1 is not installed. $2"
    return 1
  else
    echo "  ✓ $1 found: $(command -v "$1")"
    return 0
  fi
}

MISSING=0
check_cmd docker "Install from https://docs.docker.com/get-docker/" || MISSING=1
check_cmd docker "Docker Compose is included with Docker Desktop" || MISSING=1
check_cmd go "Install from https://go.dev/dl/" || MISSING=1
check_cmd cargo "Install from https://rustup.rs/" || MISSING=1
check_cmd node "Install from https://nodejs.org/" || MISSING=1
check_cmd python3 "Install from https://python.org/" || MISSING=1
check_cmd elixir "Install from https://elixir-lang.org/install.html" || MISSING=1

if [ $MISSING -eq 1 ]; then
  echo ""
  echo "⚠ Some prerequisites are missing. Install them and re-run this script."
  echo "  You can still start infrastructure without all languages installed."
  echo ""
fi

# ── Make scripts executable ──
echo ""
echo "Making scripts executable..."
chmod +x scripts/*.sh
echo "  ✓ Done"

# ── Start infrastructure ──
echo ""
echo "Starting infrastructure (databases, Kafka, Consul, Jaeger)..."
docker compose -f infra/docker-compose.yml up -d \
  postgres-user postgres-social postgres-payment \
  mongodb redis cassandra \
  zookeeper kafka kafka-ui \
  consul jaeger

echo ""
echo "Waiting for services to be healthy..."
sleep 5

# Wait for health checks
echo "  Checking PostgreSQL (user)..."
until docker exec atto-postgres-user pg_isready -U atto -d atto_users &>/dev/null; do sleep 1; done
echo "    ✓ PostgreSQL (user) ready"

echo "  Checking PostgreSQL (social)..."
until docker exec atto-postgres-social pg_isready -U atto -d atto_social &>/dev/null; do sleep 1; done
echo "    ✓ PostgreSQL (social) ready"

echo "  Checking PostgreSQL (payment)..."
until docker exec atto-postgres-payment pg_isready -U atto -d atto_payments &>/dev/null; do sleep 1; done
echo "    ✓ PostgreSQL (payment) ready"

echo "  Checking MongoDB..."
until docker exec atto-mongodb mongosh --eval "db.adminCommand('ping')" &>/dev/null; do sleep 1; done
echo "    ✓ MongoDB ready"

echo "  Checking Redis..."
until docker exec atto-redis redis-cli -a atto_dev ping &>/dev/null; do sleep 1; done
echo "    ✓ Redis ready"

echo "  Checking Kafka..."
until docker exec atto-kafka kafka-broker-api-versions --bootstrap-server localhost:9092 &>/dev/null; do sleep 2; done
echo "    ✓ Kafka ready"

echo "  Checking Cassandra (this may take a minute)..."
until docker exec atto-cassandra cqlsh -e "describe cluster" &>/dev/null; do sleep 3; done
echo "    ✓ Cassandra ready"

# ── Create Cassandra keyspace ──
echo ""
echo "Setting up Cassandra keyspace..."
docker exec atto-cassandra cqlsh -e "
  CREATE KEYSPACE IF NOT EXISTS atto_chat
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
" 2>/dev/null || true
echo "  ✓ Cassandra keyspace 'atto_chat' ready"

# ── Summary ──
echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║             Infrastructure is ready!                      ║"
echo "╠═══════════════════════════════════════════════════════════╣"
echo "║                                                           ║"
echo "║  PostgreSQL (user):    localhost:5432                     ║"
echo "║  PostgreSQL (social):  localhost:5433                     ║"
echo "║  PostgreSQL (payment): localhost:5434                     ║"
echo "║  MongoDB:              localhost:27017                    ║"
echo "║  Redis:                localhost:6379                     ║"
echo "║  Cassandra:            localhost:9042                     ║"
echo "║  Kafka:                localhost:9092                     ║"
echo "║                                                           ║"
echo "║  UIs:                                                     ║"
echo "║  Kafka UI:   http://localhost:8090                        ║"
echo "║  Jaeger UI:  http://localhost:16686                       ║"
echo "║  Consul UI:  http://localhost:8500                        ║"
echo "║                                                           ║"
echo "╚═══════════════════════════════════════════════════════════╝"
echo ""
echo "Next steps:"
echo "  1. cd services/user-service && go run cmd/server/main.go"
echo "  2. Or use: make all (to start everything with Docker)"
