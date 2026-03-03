"""Payment Service -- FastAPI application entry point.

Starts the HTTP server (FastAPI + Uvicorn), the gRPC server, and the
Kafka consumer.  On shutdown each subsystem is torn down gracefully.
"""

import logging
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.database import engine
from app.grpc.server import serve_grpc, stop_grpc
from app.kafka.consumer import start_consumer, stop_consumer
from app.kafka.producer import stop_producer
from app.middleware.auth import AuthMiddleware
from app.models import Base
from app.routers.health import router as health_router
from app.routers.payments import router as payments_router
from app.routers.subscriptions import router as subscriptions_router
from app.routers.transactions import router as transactions_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("payment-service")


# ── Lifespan ──────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Manage startup and shutdown of ancillary services."""
    # Startup
    logger.info("Starting payment-service (env=%s)", settings.app_env)

    # Create database tables (for development convenience)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    logger.info("Database tables ensured")

    # Start gRPC server
    await serve_grpc()

    # Start Kafka consumer
    try:
        start_consumer()
    except Exception as exc:
        logger.warning("Kafka consumer failed to start: %s", exc)

    logger.info(
        "payment-service ready  (HTTP=:%d  gRPC=:%d)",
        settings.http_port,
        settings.grpc_port,
    )

    yield

    # Shutdown
    logger.info("Shutting down payment-service...")
    await stop_consumer()
    await stop_producer()
    await stop_grpc()
    await engine.dispose()
    logger.info("payment-service stopped")


# ── FastAPI application ───────────────────────────────────────────

app = FastAPI(
    title="Atto Payment Service",
    version="0.1.0",
    description="Handles transactions and subscriptions for Atto Sound",
    lifespan=lifespan,
)

# Middleware
app.add_middleware(AuthMiddleware)

# Routers
app.include_router(health_router)
app.include_router(payments_router)
app.include_router(transactions_router)
app.include_router(subscriptions_router)


# ── Global exception handler ─────────────────────────────────────

@app.exception_handler(Exception)
async def global_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    logger.error("Unhandled exception: %s", exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "success": False,
            "data": None,
            "error": "Internal server error",
        },
    )


# ── Entrypoint ────────────────────────────────────────────────────

if __name__ == "__main__":
    uvicorn.run(
        "app.main:app",
        host="::",
        port=settings.http_port,
        log_level="info",
    )
