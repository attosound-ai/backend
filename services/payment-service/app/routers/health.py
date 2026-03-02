from fastapi import APIRouter
from sqlalchemy import text

from app.database import async_session

router = APIRouter(tags=["health"])


@router.get("/health")
async def health_check() -> dict:
    """Health check endpoint for load balancers and orchestrators."""
    db_ok = False
    try:
        async with async_session() as session:
            await session.execute(text("SELECT 1"))
            db_ok = True
    except Exception:
        pass

    return {
        "status": "ok" if db_ok else "degraded",
        "service": "payment-service",
        "database": "connected" if db_ok else "disconnected",
    }
