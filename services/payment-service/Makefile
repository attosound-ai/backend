.PHONY: setup run test lint migrate docker-build proto

setup:
	pip install -r requirements.txt

run:
	uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload

test:
	pytest tests/ -v

lint:
	ruff check app/

migrate:
	alembic upgrade head

docker-build:
	docker build -t atto-payment-service:latest .

proto:
	python -m grpc_tools.protoc \
		-I../../proto \
		--python_out=app/grpc \
		--grpc_python_out=app/grpc \
		../../proto/payment.proto
