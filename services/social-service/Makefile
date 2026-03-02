.PHONY: dev build test lint docker-build docker-run prisma-generate prisma-migrate

dev:
	npm run start:dev

build:
	npm run build

test:
	npm run test

lint:
	npm run lint

docker-build:
	docker build -t atto-social-service .

docker-run:
	docker run -p 3000:3000 -p 50053:50053 \
		-e DATABASE_URL=postgresql://atto:atto_dev@host.docker.internal:5433/atto_social \
		-e REDIS_URL=redis://:atto_dev@host.docker.internal:6379 \
		-e KAFKA_BROKERS=host.docker.internal:9092 \
		-e USER_SERVICE_GRPC=host.docker.internal:50051 \
		-e CONTENT_SERVICE_GRPC=host.docker.internal:50052 \
		atto-social-service

prisma-generate:
	npx prisma generate

prisma-migrate:
	npx prisma migrate dev

prisma-deploy:
	npx prisma migrate deploy

prisma-studio:
	npx prisma studio
