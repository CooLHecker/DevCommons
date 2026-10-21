"""FastAPI dependencies that turn a Bearer token into an authenticated user."""

import logging
import os
from typing import Optional

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from firebase_admin import auth as fb_auth
from pydantic import BaseModel

from .firebase_client import verify_id_token

logger = logging.getLogger("auth_module")
if not logger.handlers and not logging.getLogger().handlers:
    logging.basicConfig(level=logging.INFO)  # so warnings show up under plain `uvicorn main:app`

_DEBUG = os.getenv("AUTH_DEBUG", "false").lower() == "true"
_bearer = HTTPBearer(auto_error=False)


class AuthUser(BaseModel):
    uid: str
    email: Optional[str] = None
    email_verified: bool = False
    name: Optional[str] = None
    picture: Optional[str] = None
    provider: Optional[str] = None


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def _to_user(claims: dict) -> AuthUser:
    return AuthUser(
        uid=claims["uid"],
        email=claims.get("email"),
        email_verified=bool(claims.get("email_verified", False)),
        name=claims.get("name"),
        picture=claims.get("picture"),
        provider=(claims.get("firebase") or {}).get("sign_in_provider"),
    )


def _decode(token: str) -> AuthUser:
    try:
        return _to_user(verify_id_token(token))
    except fb_auth.ExpiredIdTokenError as exc:
        logger.warning("Token rejected (expired): %s", exc)
        raise _unauthorized("Token expired")
    except fb_auth.RevokedIdTokenError as exc:
        logger.warning("Token rejected (revoked): %s", exc)
        raise _unauthorized("Token revoked")
    except (fb_auth.InvalidIdTokenError, fb_auth.CertificateFetchError, ValueError) as exc:
        # The real reason (wrong project, clock skew, can't reach Google, ...) goes to the
        # server log. Set AUTH_DEBUG=true to also return it in the response while developing.
        logger.warning("Token rejected (%s): %s", type(exc).__name__, exc)
        raise _unauthorized(f"Invalid token: {exc}" if _DEBUG else "Invalid token")


def get_current_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> AuthUser:
    """Require a valid Firebase ID token; 401 otherwise."""
    if creds is None or not creds.credentials:
        raise _unauthorized("Missing bearer token")
    return _decode(creds.credentials)


def get_optional_user(
    creds: Optional[HTTPAuthorizationCredentials] = Depends(_bearer),
) -> Optional[AuthUser]:
    """Return the user if a valid token is present, otherwise None."""
    if creds is None or not creds.credentials:
        return None
    return _decode(creds.credentials)


def require_verified_email(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """Like get_current_user, but 403 unless the user's email is verified."""
    if not user.email_verified:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email not verified")
    return user
