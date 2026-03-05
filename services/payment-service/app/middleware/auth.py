import jwt
from fastapi import Request, HTTPException

from app.config import settings


def _extract_user_id_from_token(authorization: str) -> str:
    """Decode a Bearer JWT and return the 'sub' claim (user_id)."""
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="Invalid authorization header format")

    try:
        payload = jwt.decode(
            parts[1],
            settings.jwt_secret,
            algorithms=["HS256"],
            issuer="atto-sound-user-service",
        )
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Token missing subject")
    return user_id


async def get_current_user_id(request: Request) -> str:
    """Extract user ID from JWT Authorization header or X-User-ID fallback."""
    # Try JWT first (frontend sends Bearer tokens)
    authorization = request.headers.get("Authorization")
    if authorization:
        return _extract_user_id_from_token(authorization)

    # Fallback: X-User-ID header (internal service-to-service calls)
    user_id = request.headers.get("X-User-ID")
    if user_id:
        return user_id

    raise HTTPException(status_code=401, detail="Missing authentication")


async def get_current_user_role(request: Request) -> str:
    """Extract X-User-Role from request headers."""
    return request.headers.get("X-User-Role", "user")


class AuthMiddleware:
    """ASGI middleware that validates authentication on payment routes.

    Non-payment routes (e.g. /health) and the Stripe webhook are allowed
    through without authentication.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            from starlette.requests import Request as StarletteRequest

            req = StarletteRequest(scope, receive)
            path = req.url.path

            # Enforce auth on payment routes (skip webhook, plans listing, and health)
            needs_auth = (
                path.startswith("/payments/")
                and not path.endswith("/webhook")
                and path != "/payments/subscriptions/plans"
            )
            if needs_auth:
                authorization = req.headers.get("Authorization")
                user_id = req.headers.get("X-User-ID")

                if not authorization and not user_id:
                    from starlette.responses import JSONResponse

                    response = JSONResponse(
                        status_code=401,
                        content={
                            "success": False,
                            "data": None,
                            "error": "Missing authentication",
                        },
                    )
                    await response(scope, receive, send)
                    return

        await self.app(scope, receive, send)
