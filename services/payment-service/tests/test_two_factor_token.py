"""The 2FA temporary token is not a session (Nov 12 2026).

It is issued after the password alone, before the second factor, and is
signed with the shared secret. The payment auth decoded it as a session, so
the password alone reached every payment route.
"""

import time

import jwt
import pytest
from fastapi import HTTPException

from app.config import settings
from app.middleware.auth import _decode_token


def _sign(claims):
    body = {"iat": int(time.time()), "exp": int(time.time()) + 300, **claims}
    return "Bearer " + jwt.encode(body, settings.jwt_secret, algorithm="HS256")


@pytest.mark.parametrize(
    "claims",
    [
        {"sub": "281", "iss": "atto-sound-2fa"},
        {"sub": "2fa:281", "iss": "atto-sound-2fa", "scope": "2fa_pending"},
    ],
)
def test_two_factor_token_is_401(claims):
    with pytest.raises(HTTPException) as exc:
        _decode_token(_sign(claims))
    assert exc.value.status_code == 401


def test_session_token_still_works():
    payload = _decode_token(_sign({"sub": "281", "iss": "atto-sound-user-service", "scope": "user"}))
    assert payload["sub"] == "281"
