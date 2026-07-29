"""Endpoints de áreas de interés (AOI-1).

PRIMER APIRouter del proyecto. Los ~30 endpoints existentes están con `@app.get`
directo en src/main.py, que ya pasa las 1400 líneas; este grupo se monta aparte
para no seguir engordándolo. Los existentes NO se migran acá: sería un refactor
de toda la superficie de la API, con su propio riesgo, ajeno a AOI-1.

AUTORIZACIÓN POR OWNERSHIP, NO POR ROL. Todos los endpoints piden sesión válida
(`get_current_user`) pero ninguno exige un rol mínimo: un viewer tiene derecho a
crear y editar sus propias áreas. La autorización real —"¿es tuya?"— la hace
AreaService filtrando por owner_id. `require_min_role` queda reservado para un
futuro endpoint de creación de presets del sistema (is_system=true), fuera de
AOI-1.

Mapeo de errores del service a HTTP (ver src/services/area_service.py):

    AreaNotFoundError          -> 404  no existe, o es de otro usuario
    SystemAreaNotEditableError -> 403  es un preset del sistema
    InvalidGeometryError       -> 422  GeoJSON no interpretable
    DefaultAreaMissingError    -> 500  falta correr el seed (error del servidor)

El 404 unificado para "no existe" y "es de otro" es deliberado y viene del
service: distinguirlos filtraría la existencia de áreas ajenas por diferencia
de código de estado.

DefaultAreaMissingError es el único que sale como 5xx, y con razón: no es una
condición del cliente sino una base sin seed
(scripts/seed_areas_of_interest.py). Se deja propagar en vez de atraparse, para
que llegue a los logs y a GlitchTip como el error de configuración que es.
"""
from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, status

from src.models.area import (
    ActiveAreaResponse,
    ActiveAreaUpdate,
    AreaCreate,
    AreaPublic,
    AreaUpdate,
)
from src.models.user import CurrentUser
from src.api.deps import get_current_user
from src.services.area_service import (
    AreaNotFoundError,
    AreaService,
    SystemAreaNotEditableError,
)
from src.services.geo_filter import InvalidGeometryError

router = APIRouter(prefix="/areas", tags=["areas"])


def _get_area_service(request: Request) -> AreaService:
    """Resuelve AreaService desde app.state, igual que _get_auth_service().

    Si no existe es un error de configuración del servidor (el lifespan no
    corrió), no una condición de request: se propaga como AttributeError -> 500
    en vez de disfrazarse de 404/503. Mismo criterio que documenta
    src/api/deps.py para auth_service.
    """
    return request.app.state.area_service


@router.get("", response_model=list[AreaPublic])
async def list_areas(
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> list[AreaPublic]:
    """Presets del sistema + áreas propias del usuario.

    El orden lo fija la query (presets primero, después las propias, ambos por
    nombre) para que el frontend pueda renderizar la lista tal cual llega.
    """
    return await area_service.list_for_user(current_user.id)


@router.post("", response_model=AreaPublic, status_code=status.HTTP_201_CREATED)
async def create_area(
    payload: AreaCreate,
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> AreaPublic:
    """Crea un área propia del usuario.

    `AreaCreate` no declara `is_system`, `owner_id` ni las columnas `bbox_*`:
    por diseño de tipos, un cliente no puede crear un preset del sistema,
    adjudicarse un área ajena ni declarar un bbox incoherente con su geometría
    (ver src/models/area.py). El bbox lo deriva siempre el service.
    """
    try:
        return await area_service.create(
            current_user.id, payload.name, payload.geometry
        )
    except InvalidGeometryError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


# NOTA DE ORDEN: /areas/active se declara ANTES que /areas/{area_id}.
# FastAPI resuelve por orden de registro, así que con el orden invertido la
# cadena "active" entraría por la ruta paramétrica e intentaría parsearse como
# UUID, devolviendo 422 en vez de la respuesta correcta. Es el error clásico de
# las rutas estáticas que colisionan con una paramétrica hermana.


@router.get("/active", response_model=ActiveAreaResponse)
async def get_active_area(
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> ActiveAreaResponse:
    """Área activa del usuario, con el preset por defecto como fallback.

    `is_default=True` significa que el usuario NO eligió nada y está viendo el
    default — el frontend lo necesita para no mostrar como seleccionada un área
    que el usuario nunca eligió.

    DefaultAreaMissingError se deja propagar (500): ver el docstring del módulo.
    """
    area, is_default = await area_service.get_active(current_user.id)
    return ActiveAreaResponse(area=area, is_default=is_default)


@router.put("/active", response_model=ActiveAreaResponse)
async def set_active_area(
    payload: ActiveAreaUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> ActiveAreaResponse:
    """Fija el área activa del usuario. `area_id=null` vuelve al default.

    PUT y no PATCH: el recurso "área activa" es un valor único que se
    reemplaza entero, no un objeto con campos parciales. Por eso `area_id=null`
    es un valor legítimo ("volver al default") y no un campo omitido — ver
    ActiveAreaUpdate en src/models/area.py.

    Devuelve el estado resultante en vez de 204 para ahorrarle al frontend el
    GET inmediato: tras un PUT con null necesita saber cuál es el default.
    """
    try:
        await area_service.set_active(current_user.id, payload.area_id)
    except AreaNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc

    area, is_default = await area_service.get_active(current_user.id)
    return ActiveAreaResponse(area=area, is_default=is_default)


@router.patch("/{area_id}", response_model=AreaPublic)
async def update_area(
    area_id: UUID,
    payload: AreaUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> AreaPublic:
    """Actualiza parcialmente un área propia.

    `exclude_unset=True` distingue "no mandó el campo" de "lo mandó en null":
    sin eso, un PATCH que sólo cambia el nombre borraría la geometría. Un PATCH
    vacío no es error — el service devuelve el área sin cambios.
    """
    fields = payload.model_dump(exclude_unset=True)
    try:
        return await area_service.update(
            area_id,
            current_user.id,
            name=fields.get("name"),
            geometry=fields.get("geometry"),
        )
    except SystemAreaNotEditableError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    except AreaNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
    except InvalidGeometryError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc



# SIN anotación de retorno, a propósito. FastAPI infiere el `response_model`
# del tipo de retorno de la función, y con `-> None` sobre un 204 aborta el
# ARRANQUE entero con "AssertionError: Status code 204 must not have a response
# body". `response_class=Response` NO alcanza para evitarlo: lo que dispara la
# inferencia es la anotación, no la clase de respuesta.
#
# (El /auth/logout de main.py sí lleva `-> None` y no falla, pero porque recibe
# `response: Response` como parámetro — otra vía distinta para lo mismo.)
@router.delete("/{area_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_area(
    area_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
):
    """Borra un área propia.

    Si era la activa del usuario, `users.active_area_id` queda en NULL por el
    ON DELETE SET NULL de la migración 006 y el usuario vuelve al default — no
    queda apuntando a un área inexistente.
    """
    try:
        await area_service.delete(area_id, current_user.id)
    except SystemAreaNotEditableError as exc:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=str(exc),
        ) from exc
    except AreaNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc


@router.get("/{area_id}", response_model=AreaPublic)
async def get_area(
    area_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    area_service: AreaService = Depends(_get_area_service),
) -> AreaPublic:
    """Un área visible por el usuario (preset del sistema o propia).

    No estaba en los 6 endpoints del diseño original, pero es el complemento
    natural de PATCH/DELETE sobre la misma ruta: sin él, un cliente que tiene
    un id no puede releer el recurso que acaba de modificar sin pedir la lista
    entera.
    """
    try:
        return await area_service.get_visible(area_id, current_user.id)
    except AreaNotFoundError as exc:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=str(exc),
        ) from exc
