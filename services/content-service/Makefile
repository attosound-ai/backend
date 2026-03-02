.PHONY: build run test clean docker-build docker-run proto fmt clippy

SERVICE_NAME = content-service
DOCKER_TAG = $(SERVICE_NAME):latest

# Build the service
build:
	cargo build --release

# Run the service locally
run:
	RUST_LOG=info cargo run

# Run in debug mode
run-debug:
	RUST_LOG=debug cargo run

# Run tests
test:
	cargo test

# Clean build artifacts
clean:
	cargo clean

# Format code
fmt:
	cargo fmt

# Run clippy linter
clippy:
	cargo clippy -- -D warnings

# Build Docker image
docker-build:
	docker build -t $(DOCKER_TAG) .

# Run Docker container
docker-run:
	docker run --rm -p 8081:8081 -p 50052:50052 \
		-e MONGO_URI=mongodb://atto:atto_dev@host.docker.internal:27017/atto_content?authSource=admin \
		-e KAFKA_BROKERS=host.docker.internal:9092 \
		-e RUST_LOG=info \
		$(DOCKER_TAG)

# Compile protobuf files (handled by build.rs, but can be triggered manually)
proto:
	cargo build --release

# Check everything
check: fmt clippy test
	@echo "All checks passed."
