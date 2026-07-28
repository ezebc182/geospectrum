"""
Modelos de áreas de interés (AOI-1).

Separación de responsabilidades igual que en src/models/user.py: request y
response conviven en el módulo y se distinguen por sufijo (*Create/*Update =
request, *Public/*Response = response).

La geometría viaja como GeoJSON crudo (`dict`) y NO como un modelo Pydantic
anidado. Es deliberado: RFC 7946 admite anidamientos de profundidad variable
(Polygon vs MultiPolygon) que un modelo estricto expresaría mal, y la
validación real —que la geometría sea interpretable y produzca un bbox— la
hace src/services/geo_filter.py, que es donde vive el conocimiento geométrico
y donde está testeada. Duplicar esa validación acá daría dos fuentes de
verdad que se desincronizan.
"""
from datetime import datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class AreaBbox(BaseModel):
    """Bounding box de un área, en grados decimales.

    Mismo shape que el dict que hoy devuelve `settings.bbox` y que consume el
    frontend en `MonitorReport.region_monitorizada` (dashboard/lib/types.ts).
    Se conserva exactamente para no romper a los consumidores existentes
    cuando la región pase a salir de la base en vez de la config.
    """

    minlat: float
    maxlat: float
    minlon: float
    maxlon: float


class AreaCreate(BaseModel):
    """Payload de POST /areas.

    NO incluye `is_system`, `owner_id` ni las columnas `bbox_*`. La ausencia
    de esos campos en el propio tipo garantiza, a nivel de diseño de tipos,
    que un cliente no pueda crear un preset del sistema, adjudicarse un área
    ajena, ni declarar un bbox que no se corresponda con su geometría —el
    bbox lo deriva siempre el service con geo_filter.bbox_of(). Mismo criterio
    que UserProfileUpdate, que omite `role`/`email` por diseño.
    """

    name: str = Field(..., min_length=1, max_length=120)
    geometry: dict


class AreaUpdate(BaseModel):
    """Payload de PATCH /areas/{id} (actualización parcial).

    Ambos campos opcionales: el endpoint aplica sólo los presentes
    (`exclude_unset=True`). Si viene `geometry`, el service recalcula los
    `bbox_*` — nunca quedan desfasados respecto de la geometría.
    """

    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    geometry: Optional[dict] = None


class AreaPublic(BaseModel):
    """Área tal como se expone en la API.

    Incluye `geometry` porque el frontend la necesita para dibujar el polígono
    en el mapa (hoy dibuja un rectángulo desde el bbox; con áreas reales pasa
    a dibujar el GeoJSON). `bbox` viaja además de la geometría porque es lo
    que usa el mapa para encuadrar la vista sin recorrer los vértices.
    """

    id: UUID
    slug: str
    name: str
    is_system: bool
    geometry: dict
    bbox: AreaBbox
    created_at: datetime
    updated_at: datetime


class ActiveAreaResponse(BaseModel):
    """Respuesta de GET /areas/active y PUT /areas/active.

    `is_default` distingue "el usuario eligió explícitamente esta área" de
    "el usuario no eligió nada y está viendo el preset por defecto"
    (users.active_area_id IS NULL). El frontend lo necesita para no mostrar
    una selección que el usuario nunca hizo.
    """

    area: AreaPublic
    is_default: bool


class ActiveAreaUpdate(BaseModel):
    """Payload de PUT /areas/active.

    `area_id=None` es un valor legítimo y significa "volver al preset por
    defecto" — no es un campo faltante. Por eso el default es explícito y el
    endpoint no usa exclude_unset acá.
    """

    area_id: Optional[UUID] = None
