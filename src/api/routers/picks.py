"""CRUD de picks de señal (Fase 5 de analiticas-profesionales-senal).

Autorización por ownership (no por rol), patrón walls.py: el service filtra
por user_id en el WHERE; acá sólo se exige sesión y se mapean excepciones a
HTTP. El 404 de un pick ajeno es idéntico al de uno inexistente a propósito.
"""

from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response

from src.api.deps import get_current_user
from src.models.signal_pick import SignalPickCreate, SignalPickPublic
from src.models.user import CurrentUser
from src.services.signal_picks import (
    SignalPickNotFoundError,
    SignalPickService,
    build_picks_csv,
    compute_measurements,
)

router = APIRouter(prefix="/stations/{channel}/picks", tags=["picks"])


def _get_pick_service(request: Request) -> SignalPickService:
    return request.app.state.signal_pick_service


def _as_utc(value: datetime | None) -> datetime | None:
    """Normaliza en el BORDE: un datetime naive se interpreta como UTC."""
    if value is None or value.tzinfo is not None:
        return value
    return value.replace(tzinfo=timezone.utc)


# Estática ANTES que la paramétrica /{pick_id} (gotcha documentado en walls.py:
# /walls/global va antes de /walls/{wall_id})
@router.get("/export.csv")
async def export_picks_csv(
    channel: str,
    start: datetime | None = Query(None, description="Inicio de ventana (ISO-8601)"),
    end: datetime | None = Query(None, description="Fin de ventana (ISO-8601)"),
    current_user: CurrentUser = Depends(get_current_user),
    pick_service: SignalPickService = Depends(_get_pick_service),
) -> Response:
    """CSV de mediciones, armado server-side (las derivadas salen de las
    fórmulas de Python, no de la copia TS: el artefacto y la pantalla tienen
    que coincidir)."""
    picks = await pick_service.list_for_window(
        current_user.id, channel, _as_utc(start), _as_utc(end)
    )
    filename = f"picks-{channel}.csv"
    return Response(
        content=build_picks_csv(picks),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("")
async def list_picks(
    channel: str,
    start: datetime | None = Query(None, description="Inicio de ventana (ISO-8601)"),
    end: datetime | None = Query(None, description="Fin de ventana (ISO-8601)"),
    current_user: CurrentUser = Depends(get_current_user),
    pick_service: SignalPickService = Depends(_get_pick_service),
) -> dict:
    picks = await pick_service.list_for_window(
        current_user.id, channel, _as_utc(start), _as_utc(end)
    )
    return {
        "picks": [pick.model_dump(mode="json") for pick in picks],
        "measurements": compute_measurements(picks).model_dump(mode="json"),
    }


@router.post("", response_model=SignalPickPublic, status_code=201)
async def create_pick(
    channel: str,
    payload: SignalPickCreate,
    current_user: CurrentUser = Depends(get_current_user),
    pick_service: SignalPickService = Depends(_get_pick_service),
) -> SignalPickPublic:
    return await pick_service.create(
        current_user.id,
        channel,
        payload.phase,
        _as_utc(payload.pick_time),
        payload.note,
    )


@router.put("/{pick_id}", response_model=SignalPickPublic)
async def update_pick(
    channel: str,
    pick_id: UUID,
    payload: SignalPickCreate,
    current_user: CurrentUser = Depends(get_current_user),
    pick_service: SignalPickService = Depends(_get_pick_service),
) -> SignalPickPublic:
    try:
        return await pick_service.update(
            pick_id,
            current_user.id,
            payload.phase,
            _as_utc(payload.pick_time),
            payload.note,
        )
    except SignalPickNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# OJO: sin anotación de retorno — un `-> None` con 204 aborta el arranque
@router.delete("/{pick_id}", status_code=204)
async def delete_pick(
    channel: str,
    pick_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    pick_service: SignalPickService = Depends(_get_pick_service),
):
    try:
        await pick_service.delete(pick_id, current_user.id)
    except SignalPickNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
