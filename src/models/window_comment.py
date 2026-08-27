"""Modelos del hilo de conversación por ventana analizada."""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field, model_validator


class WindowCommentCreate(BaseModel):
    """Payload del POST. La ventana viaja en el body y no en la query para
    que el comentario quede anclado EXACTAMENTE a lo que el usuario miraba."""

    body: str = Field(min_length=1, max_length=500)
    window_start: datetime
    window_end: datetime

    @model_validator(mode="after")
    def _window_valida(self) -> "WindowCommentCreate":
        # Mismo criterio que el CHECK de la tabla: la validación de forma no
        # reemplaza a la de la base, la ADELANTA a un 422 legible.
        if self.window_end <= self.window_start:
            raise ValueError("window_end debe ser posterior a window_start")
        return self


class WindowCommentPublic(BaseModel):
    id: UUID
    channel: str
    window_start: datetime
    window_end: datetime
    body: str
    # El email identifica al autor en el hilo (colaborativo: todos ven todo).
    author_email: str
    created_at: datetime
