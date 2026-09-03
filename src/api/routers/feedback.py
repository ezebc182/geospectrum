"""Feedback de beta testers con tablero Kanban (patrón comments.py).

Cuatro endpoints y cero código de auth nuevo (design Decision 2 y 3):
crear y leer con `get_current_user` (cualquier autenticado, viewer incluido,
lee TODO el tablero con el email del autor); mover y comentar con
`require_min_role(UserRole.ADMIN)` — jerárquico, el superadmin también pasa.
El rol se lee fresco de la base en cada request: promover a alguien en
/admin/users habilita mover y comentar en el request siguiente.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from src.api.deps import get_current_user, require_min_role
from src.models.feedback import (
    FeedbackAdminCommentUpdate,
    FeedbackReportCreate,
    FeedbackReportCreated,
    FeedbackReportItem,
    FeedbackStatusUpdate,
)
from src.models.user import CurrentUser, UserRole
from src.services.feedback_service import (
    FeedbackReportNotFoundError,
    FeedbackService,
)

router = APIRouter(prefix="/feedback", tags=["feedback"])


def _get_feedback_service(request: Request) -> FeedbackService:
    return request.app.state.feedback_service


@router.post("", response_model=FeedbackReportCreated, status_code=201)
async def create_report(
    payload: FeedbackReportCreate,
    current_user: CurrentUser = Depends(get_current_user),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportCreated:
    # El autor es la SESIÓN: el payload no tiene user_id y si el body trae uno
    # Pydantic lo descarta. Ack mínimo; `status = new` es contrato.
    row = await feedback_service.create(current_user.id, payload)
    return FeedbackReportCreated(id=row["id"], created_at=row["created_at"])


@router.get("")
async def list_reports(
    current_user: CurrentUser = Depends(get_current_user),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> dict:
    reports = await feedback_service.list_all()
    return {"reports": [item.model_dump(mode="json") for item in reports]}


@router.put("/{report_id}/status", response_model=FeedbackReportItem)
async def set_status(
    report_id: UUID,
    payload: FeedbackStatusUpdate,
    current_user: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportItem:
    try:
        return await feedback_service.set_status(report_id, payload.status)
    except FeedbackReportNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.put("/{report_id}/comment", response_model=FeedbackReportItem)
async def set_admin_comment(
    report_id: UUID,
    payload: FeedbackAdminCommentUpdate,
    current_user: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    feedback_service: FeedbackService = Depends(_get_feedback_service),
) -> FeedbackReportItem:
    try:
        return await feedback_service.set_admin_comment(report_id, payload.comment)
    except FeedbackReportNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
