"""Hilo de conversación por ventana analizada (patrón WallService: pool
prestado, el lifespan lo abre y lo cierra).

Contrato colaborativo (decisión 2026-08-26): la LECTURA es de todos — el
análisis sísmico es trabajo de equipo — y el ownership aplica solo al DELETE.
El 404 de un comentario ajeno es idéntico al de uno inexistente: no filtra
la existencia de contenido de otros.
"""

from datetime import datetime
from typing import Any
from uuid import UUID

import asyncpg

from src.models.window_comment import WindowCommentPublic


class WindowCommentNotFoundError(Exception):
    """El comentario no existe o no es del usuario (indistinguibles adrede)."""


def _row_to_public(row: asyncpg.Record) -> WindowCommentPublic:
    return WindowCommentPublic(
        id=row["id"],
        channel=row["channel"],
        window_start=row["window_start"],
        window_end=row["window_end"],
        body=row["body"],
        anchor_time=row["anchor_time"],
        author_email=row["author_email"],
        created_at=row["created_at"],
    )


class WindowCommentService:
    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def list_for_window(
        self, channel: str, start: datetime, end: datetime
    ) -> list[WindowCommentPublic]:
        """Los comentarios cuyo anclaje SOLAPA la ventana pedida, en orden de
        llegada. Solapamiento y no igualdad exacta: un zoom que corre la
        ventana unos segundos no puede hacer desaparecer el hilo."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT c.id, c.channel, c.window_start, c.window_end, c.body,
                       c.anchor_time, c.created_at, u.email AS author_email
                  FROM window_comments c
                  JOIN users u ON u.id = c.user_id
                 WHERE c.channel = $1
                   AND c.window_start < $3
                   AND c.window_end > $2
                 ORDER BY c.created_at ASC
                """,
                channel,
                start,
                end,
            )
        return [_row_to_public(row) for row in rows]

    async def create(
        self,
        user_id: UUID,
        channel: str,
        start: datetime,
        end: datetime,
        body: str,
        anchor_time: datetime | None = None,
    ) -> WindowCommentPublic:
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                """
                WITH inserted AS (
                    INSERT INTO window_comments
                        (channel, window_start, window_end, user_id, body,
                         anchor_time)
                    VALUES ($1, $2, $3, $4, $5, $6)
                    RETURNING id, channel, window_start, window_end, body,
                              anchor_time, user_id, created_at
                )
                SELECT i.id, i.channel, i.window_start, i.window_end, i.body,
                       i.anchor_time, i.created_at, u.email AS author_email
                  FROM inserted i
                  JOIN users u ON u.id = i.user_id
                """,
                channel,
                start,
                end,
                user_id,
                body,
                anchor_time,
            )
        return _row_to_public(row)

    async def delete(self, comment_id: UUID, user_id: UUID) -> None:
        """Ownership en el WHERE, patrón walls: borrar lo ajeno ni siquiera
        llega a distinguirse de borrar lo inexistente."""
        async with self._pool.acquire() as conn:
            deleted = await conn.fetchval(
                "DELETE FROM window_comments WHERE id = $1 AND user_id = $2 RETURNING id",
                comment_id,
                user_id,
            )
        if deleted is None:
            raise WindowCommentNotFoundError(f"comentario {comment_id} no encontrado")
