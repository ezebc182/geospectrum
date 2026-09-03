"""Reportes de feedback de beta con tablero Kanban (patrón WindowCommentService:
pool prestado, el lifespan lo abre y lo cierra).

Contrato (design Decision 2): la LECTURA es de cualquier autenticado y trae
TODOS los reportes con el email del autor; el `user_id` nunca sale del
service. La idempotencia de mover y comentar vive en el SQL (`CASE`), no en
un SELECT previo: un solo round-trip y ninguna ventana de carrera.
"""

from typing import Any, Optional
from uuid import UUID

import asyncpg

from src.models.feedback import FeedbackReportCreate, FeedbackReportItem

# Proyección compartida por las cuatro operaciones: el item completo del
# tablero. Sin `user_id` (del autor solo viaja el email).
_ITEM_COLUMNS = """
    r.id, r.type, r.body, r.route, r.url, r.user_agent, r.created_at,
    r.status, r.status_changed_at, r.admin_comment, r.admin_comment_updated_at,
    u.email AS author_email
"""


class FeedbackReportNotFoundError(Exception):
    """No hay reporte con ese id."""


def _row_to_item(row: asyncpg.Record) -> FeedbackReportItem:
    return FeedbackReportItem(
        id=row["id"],
        type=row["type"],
        body=row["body"],
        route=row["route"],
        url=row["url"],
        user_agent=row["user_agent"],
        author_email=row["author_email"],
        created_at=row["created_at"],
        status=row["status"],
        status_changed_at=row["status_changed_at"],
        admin_comment=row["admin_comment"],
        admin_comment_updated_at=row["admin_comment_updated_at"],
    )


class FeedbackService:
    def __init__(self, pool: Any) -> None:
        self._pool = pool

    async def create(self, user_id: UUID, payload: FeedbackReportCreate) -> asyncpg.Record:
        """INSERT sin `status` ni timestamps: los pone la base (DEFAULT 'new',
        `now()`). El reloj del cliente no manda. Devuelve `{id, created_at}`."""
        async with self._pool.acquire() as conn:
            return await conn.fetchrow(
                """
                INSERT INTO feedback_reports (user_id, type, body, route, url, user_agent)
                VALUES ($1, $2, $3, $4, $5, $6)
                RETURNING id, created_at
                """,
                user_id,
                payload.type,
                payload.body,
                payload.route,
                payload.url,
                payload.user_agent,
            )

    async def list_all(self) -> list[FeedbackReportItem]:
        """Todo el tablero, lo más nuevo primero. Sin filtros ni paginación
        (decenas de filas como techo)."""
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT {_ITEM_COLUMNS}
                  FROM feedback_reports r
                  JOIN users u ON u.id = r.user_id
                 ORDER BY r.created_at DESC
                """
            )
        return [_row_to_item(row) for row in rows]

    async def set_status(self, report_id: UUID, status: str) -> FeedbackReportItem:
        """Mueve la tarjeta. El "desde cuándo" solo avanza si CAMBIA de
        columna: soltarla en la misma es un no-op idempotente."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                WITH updated AS (
                    UPDATE feedback_reports
                       SET status = $2,
                           status_changed_at = CASE WHEN status <> $2 THEN now() ELSE status_changed_at END
                     WHERE id = $1
                 RETURNING *
                )
                SELECT {_ITEM_COLUMNS}
                  FROM updated r
                  JOIN users u ON u.id = r.user_id
                """,
                report_id,
                status,
            )
        if row is None:
            raise FeedbackReportNotFoundError(f"reporte {report_id} no encontrado")
        return _row_to_item(row)

    async def set_admin_comment(
        self, report_id: UUID, comment: Optional[str]
    ) -> FeedbackReportItem:
        """Reemplaza el único comentario del admin. `comment` llega ya
        normalizado por Pydantic (strip; vacío ⇒ None). None borra el par;
        mismo texto ⇒ el timestamp queda intacto."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                WITH updated AS (
                    UPDATE feedback_reports
                       SET admin_comment = $2::text,
                           admin_comment_updated_at = CASE
                               WHEN $2::text IS NULL THEN NULL
                               WHEN admin_comment IS DISTINCT FROM $2::text THEN now()
                               ELSE admin_comment_updated_at
                           END
                     WHERE id = $1
                 RETURNING *
                )
                SELECT {_ITEM_COLUMNS}
                  FROM updated r
                  JOIN users u ON u.id = r.user_id
                """,
                report_id,
                comment,
            )
        if row is None:
            raise FeedbackReportNotFoundError(f"reporte {report_id} no encontrado")
        return _row_to_item(row)
