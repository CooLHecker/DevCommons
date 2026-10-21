from fastapi import APIRouter, Depends

from .deps import AuthUser, get_current_user
from .hooks import run_on_register

router = APIRouter(prefix="/auth", tags=["auth"])


@router.get("/me", response_model=AuthUser)
async def me(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """Return the authenticated user's profile from their verified token."""
    return user


@router.post("/register", response_model=AuthUser)
async def register(user: AuthUser = Depends(get_current_user)) -> AuthUser:
    """Called by the frontend right after a new account is created.

    Firebase already created the account; this lets your backend create its own
    user record (via configure(on_register=...)). It should be idempotent, since
    the client may retry.
    """
    await run_on_register(user)
    return user
