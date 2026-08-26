"""Modelos de la API de picks de señal (Fase 5 de analiticas-profesionales-senal).

SignalPickCreate NO expone user_id: el dueño sale de la sesión (seguridad por
diseño de tipos, patrón wall.py). PUT reusa SignalPickCreate porque es
reemplazo total del pick.
"""

from datetime import datetime
from enum import Enum
from uuid import UUID

from pydantic import BaseModel, Field


class PickPhase(str, Enum):
    """Fases marcables. Espejo del CHECK de la tabla signal_picks."""

    P = "P"
    S = "S"
    CODA = "coda"


class SignalPickCreate(BaseModel):
    phase: PickPhase
    # Instante ABSOLUTO UTC de la fase — nunca un offset ni un x de píxel:
    # la misma ventana con otro `points` da otro x, el instante es invariante.
    pick_time: datetime
    note: str | None = Field(None, max_length=280)


class SignalPickPublic(BaseModel):
    id: UUID
    channel: str
    phase: PickPhase
    pick_time: datetime
    note: str | None
    created_at: datetime
    updated_at: datetime


class PickMeasurements(BaseModel):
    """Derivadas de los picks de una ventana. None cuando faltan las fases."""

    sp_seconds: float | None  # tS - tP (puede ser <= 0 si el orden es inválido)
    distance_km: float | None  # d = (tS-tP)*(vp*vs)/(vp-vs); None si S-P <= 0
    coda_seconds: float | None  # tCoda - tP
    coda_magnitude: float | None  # Mc = 1.86*log10(t) - 0.85; None si t <= 0
