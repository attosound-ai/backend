.PHONY: build run test clean docker-build docker-run tidy lint

APP_NAME := user-service
DOCKER_IMAGE := atto-sound/$(APP_NAME)

## build: Compile the service binary
build:
	go build -o bin/$(APP_NAME) ./cmd/server

## run: Build and run the service locally
run: build
	./bin/$(APP_NAME)

## test: Run all tests
test:
	go test -v -race ./...

## clean: Remove build artifacts
clean:
	rm -rf bin/

## tidy: Tidy and verify Go modules
tidy:
	go mod tidy
	go mod verify

## lint: Run golangci-lint
lint:
	golangci-lint run ./...

## docker-build: Build the Docker image
docker-build:
	docker build -t $(DOCKER_IMAGE):latest .

## docker-run: Run the Docker container
docker-run:
	docker run --rm -p 8080:8080 -p 50051:50051 $(DOCKER_IMAGE):latest

## proto: Generate Go code from proto definitions (requires protoc)
proto:
	protoc \
		--go_out=. --go_opt=paths=source_relative \
		--go-grpc_out=. --go-grpc_opt=paths=source_relative \
		../../proto/user.proto ../../proto/common.proto

## help: Show this help message
help:
	@grep -E '^## ' $(MAKEFILE_LIST) | sed 's/## //' | column -t -s ':'
