"""CRUD de muros SPECTRONET (PR-W2).

Autorización por ownership (no por rol): el service filtra por user_id en el
WHERE; acá solo se exige sesión y se mapean excepciones a HTTP. El 404 de un
muro ajeno es idéntico al de uno inexistente a propósito.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from src.api.deps import get_current_user
from src.models.user import CurrentUser
from src.models.wall import WallCreate, WallPublic, WallUpdate
from src.services.wall_service import (
    InvalidWallLayoutError,
    WallNameConflictError,
    WallNotFoundError,
    WallService,
    build_global_wall,
)

router = APIRouter(prefix="/walls", tags=["walls"])


def _get_wall_service(request: Request) -> WallService:
    return request.app.state.wall_service


# Estática ANTES que la paramétrica /{wall_id} (gotcha documentado en areas.py)
@router.get("/global")
async def get_global_wall() -> dict:
    """Muro default "Global" (público: la cartelera funciona sin login)."""
    return build_global_wall()


@router.get("", response_model=list[WallPublic])
async def list_walls(
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> list[WallPublic]:
    return await wall_service.list_for_user(current_user.id)


@router.post("", response_model=WallPublic, status_code=201)
async def create_wall(
    payload: WallCreate,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> WallPublic:
    try:
        return await wall_service.create(current_user.id, payload.name, payload.layout)
    except WallNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidWallLayoutError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{wall_id}", response_model=WallPublic)
async def update_wall(
    wall_id: UUID,
    payload: WallUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> WallPublic:
    try:
        return await wall_service.update(wall_id, current_user.id, payload.name, payload.layout)
    except WallNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except WallNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidWallLayoutError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# OJO: sin anotación de retorno — un `-> None` con 204 aborta el arranque
@router.delete("/{wall_id}", status_code=204)
async def delete_wall(
    wall_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
):
    try:
        await wall_service.delete(wall_id, current_user.id)
    except WallNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
