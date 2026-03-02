.PHONY: help proto infra infra-down services services-down all clean otp-service

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Protobuf ──
proto: ## Generate protobuf code for all languages
	@bash scripts/proto-gen.sh

# ── Infrastructure ──
infra: ## Start all infrastructure (databases, Kafka, Consul, Jaeger)
	docker compose -f infra/docker-compose.yml up -d

infra-down: ## Stop all infrastructure
	docker compose -f infra/docker-compose.yml down

infra-logs: ## Show infrastructure logs
	docker compose -f infra/docker-compose.yml logs -f

# ── Services ──
build: ## Build all service Docker images
	docker compose -f infra/docker-compose.yml build user-service content-service social-service chat-service payment-service otp-service

all: ## Start everything (infra + services + gateway)
	docker compose -f infra/docker-compose.yml up -d

down: ## Stop everything
	docker compose -f infra/docker-compose.yml down

logs: ## Show all logs
	docker compose -f infra/docker-compose.yml logs -f

# ── Individual Services ──
user-service: ## Start User Service (Go)
	docker compose -f infra/docker-compose.yml up -d user-service

content-service: ## Start Content Service (Rust)
	docker compose -f infra/docker-compose.yml up -d content-service

social-service: ## Start Social Service (NestJS)
	docker compose -f infra/docker-compose.yml up -d social-service

chat-service: ## Start Chat Service (Elixir)
	docker compose -f infra/docker-compose.yml up -d chat-service

payment-service: ## Start Payment Service (Python)
	docker compose -f infra/docker-compose.yml up -d payment-service

otp-service: ## Start OTP Service (Go)
	docker compose -f infra/docker-compose.yml up -d otp-service

# ── Development ──
setup: ## One-command dev environment setup
	@bash scripts/setup-dev.sh

clean: ## Remove all containers, volumes, and generated code
	docker compose -f infra/docker-compose.yml down -v --remove-orphans
	@echo "Cleaned up all containers and volumes"
