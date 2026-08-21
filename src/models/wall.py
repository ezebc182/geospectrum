"""Modelos de la API de muros SPECTRONET (PR-W2).

WallCreate/WallUpdate NO exponen user_id: el dueño sale de la sesión
(seguridad por diseño de tipos, patrón AreaCreate). PUT es reemplazo total,
por eso WallUpdate tiene los mismos campos obligatorios que WallCreate.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class WallCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    layout: dict


class WallUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    layout: dict


class WallPublic(BaseModel):
    id: UUID
    name: str
    layout: dict
    created_at: datetime
    updated_at: datetime
