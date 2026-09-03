"""Modelos del feedback de beta testers (tablero Kanban de cinco estados).

Contrato de la Decision 2 del design de `feedback-beta-testers`, con las dos
correcciones de la reconciliación specs ↔ design:

* `user_agent` es OBLIGATORIO (ausente ⇒ 422) pero admite `""` — los tres
  campos de contexto los adjunta siempre el widget; un cliente que no los
  manda es un payload inválido, no uno "sin navegador".
* `status_changed_at` es `Optional`: nace `null` y el primer movimiento lo
  setea. "Nadie la movió todavía" es un estado observable del tablero.

Los límites (2000 / 300 / 2000 / 400) son espejo de los CHECK de la
migración 019: la validación de forma ADELANTA el error a un 422 legible, no
reemplaza a la base (criterio de `window_comment.py`).
"""

from datetime import datetime
from typing import Literal, Optional
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

FeedbackType = Literal["bug", "suggestion"]
# Mismo orden que las columnas del tablero; `discarded` es terminal aparte de `done`.
FeedbackStatus = Literal["new", "in_analysis", "in_progress", "done", "discarded"]


class FeedbackReportCreate(BaseModel):
    """Payload de POST /feedback. SIN user_id (sale de la sesión), SIN
    timestamp (lo pone la base) y SIN status (siempre nace en 'new')."""

    type: FeedbackType
    body: str = Field(min_length=1, max_length=2000)  # NUNCA se trunca: 422
    route: str = Field(min_length=1, max_length=300)
    url: str = Field(min_length=1, max_length=2000)
    user_agent: str = Field(max_length=400)

    @field_validator("body")
    @classmethod
    def _body_not_blank(cls, value: str) -> str:
        # Un reporte de solo espacios no es un reporte. Se RECHAZA sin alterar
        # el texto: `min_length` solo no lo caza y un `strip` cambiaría lo que
        # el tester escribió (la spec prohíbe tocar el body).
        if not value.strip():
            raise ValueError("body must not be blank")
        return value


class FeedbackReportCreated(BaseModel):
    """Ack mínimo del POST. El estado inicial es 'new' por contrato."""

    id: UUID
    created_at: datetime


class FeedbackReportItem(BaseModel):
    """Tarjeta del tablero: la ve CUALQUIER usuario autenticado. Sin `user_id`:
    del autor solo viaja el email."""

    id: UUID
    type: FeedbackType
    body: str
    route: str
    url: str
    user_agent: str
    author_email: str
    created_at: datetime
    status: FeedbackStatus
    status_changed_at: Optional[datetime] = None
    admin_comment: Optional[str] = None
    admin_comment_updated_at: Optional[datetime] = None


class FeedbackStatusUpdate(BaseModel):
    """Body de PUT /feedback/{id}/status. Un valor fuera del Literal ⇒ 422."""

    status: FeedbackStatus


class FeedbackAdminCommentUpdate(BaseModel):
    """Body de PUT /feedback/{id}/comment. `null`, "" o solo espacios BORRAN
    el comentario; el texto se persiste recortado."""

    comment: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("comment", mode="before")
    @classmethod
    def _empty_is_none(cls, value: object) -> object:
        if isinstance(value, str):
            stripped = value.strip()
            return stripped or None
        return value
