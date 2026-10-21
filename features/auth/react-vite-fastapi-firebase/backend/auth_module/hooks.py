"""Extension points so the module can plug into your own database without editing it.

    from auth_module import configure

    async def save_user(user):          # sync or async, both work
        db.users.upsert(user.uid, user.model_dump())

    configure(on_register=save_user)
"""

import inspect
from typing import Any, Awaitable, Callable, Optional, Union

Hook = Callable[[Any], Union[None, Awaitable[None]]]

_on_register: Optional[Hook] = None


def configure(on_register: Optional[Hook] = None) -> None:
    """Set the callbacks. Call once at startup."""
    global _on_register
    _on_register = on_register


async def run_on_register(user: Any) -> None:
    if _on_register is None:
        return
    result = _on_register(user)
    if inspect.isawaitable(result):
        await result
