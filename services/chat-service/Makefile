.PHONY: setup run test lint docker-build

setup:
	mix deps.get

run:
	mix phx.server

test:
	mix test

lint:
	mix format --check-formatted

docker-build:
	docker build -t atto-chat-service:latest .
