"""Hilo de conversación por ventana analizada (patrón picks.py).

La lectura es COLABORATIVA (sin filtro por user en el WHERE, a diferencia de
los picks): decisión del 2026-08-26. El ownership vive solo en el DELETE.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request

from src.api.deps import get_current_user
from src.models.user import CurrentUser
from src.models.window_comment import WindowCommentCreate, WindowCommentPublic
from src.services.window_comments import (
    WindowCommentNotFoundError,
    WindowCommentService,
)

router = APIRouter(prefix="/stations/{channel}/comments", tags=["comments"])


def _get_comment_service(request: Request) -> WindowCommentService:
    return request.app.state.window_comment_service


def _as_utc(value: datetime) -> datetime:
    """Normaliza en el BORDE: un datetime naive se interpreta como UTC."""
    if value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


@router.get("")
async def list_comments(
    channel: str,
    start: datetime = Query(..., description="Inicio de la ventana (ISO-8601)"),
    end: datetime = Query(..., description="Fin de la ventana (ISO-8601)"),
    current_user: CurrentUser = Depends(get_current_user),
    comment_service: WindowCommentService = Depends(_get_comment_service),
) -> dict:
    comments = await comment_service.list_for_window(channel, _as_utc(start), _as_utc(end))
    return {"comments": [c.model_dump(mode="json") for c in comments]}


@router.post("", response_model=WindowCommentPublic, status_code=201)
async def create_comment(
    channel: str,
    payload: WindowCommentCreate,
    current_user: CurrentUser = Depends(get_current_user),
    comment_service: WindowCommentService = Depends(_get_comment_service),
) -> WindowCommentPublic:
    return await comment_service.create(
        current_user.id,
        channel,
        _as_utc(payload.window_start),
        _as_utc(payload.window_end),
        payload.body,
        _as_utc(payload.anchor_time) if payload.anchor_time else None,
    )


# OJO: sin anotación de retorno — un `-> None` con 204 aborta el arranque
@router.delete("/{comment_id}", status_code=204)
async def delete_comment(
    channel: str,
    comment_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    comment_service: WindowCommentService = Depends(_get_comment_service),
):
    try:
        await comment_service.delete(comment_id, current_user.id)
    except WindowCommentNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
