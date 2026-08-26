"""Fórmulas sismológicas de picking: S-P → distancia y coda → magnitud.

Las constantes viven en `dashboard/lib/seismic-constants.json` — la FUENTE
ÚNICA que comparten Python y TypeScript. Este módulo NO declara ninguno de los
cuatro valores: el cliente calcula con la misma fuente para el feedback
inmediato y el backend calcula para el artefacto (el CSV de mediciones).

La carga es a nivel de módulo, UNA sola vez, y sin defaults: si el archivo
falta o le falta una clave, esto revienta al IMPORTAR. Un `KeyError` al
arrancar es infinitamente mejor que una distancia equivocada en un CSV.
"""

import csv
import io
import json
import math
from datetime import datetime
from pathlib import Path
from uuid import UUID

import asyncpg

from src.models.signal_pick import (
    PickMeasurements,
    PickPhase,
    SignalPickPublic,
)

# Resuelve a <raíz del repo>/dashboard/lib/seismic-constants.json:
# parents[2] desde src/services/signal_picks.py es la raíz del repo.
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)
_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))

# Acceso por clave a propósito (sin .get): la clave ausente debe reventar acá.
P_VELOCITY_KM_S: float = _C["pVelocityKmS"]
VP_VS_RATIO: float = _C["vpVsRatio"]
CODA_A: float = _C["codaA"]
CODA_B: float = _C["codaB"]

# Derivada, no declarada: una quinta constante suelta podría divergir del JSON.
S_VELOCITY_KM_S: float = P_VELOCITY_KM_S / VP_VS_RATIO


def sp_distance_km(sp_seconds: float) -> float | None:
    """Distancia epicentral estimada a partir del intervalo S-P.

    d = (tS - tP) · (vp·vs)/(vp - vs), con vp y vp/vs del JSON compartido.

    Una sola estación da DISTANCIA, no ubicación: el epicentro está en algún
    punto del círculo de radio `d` centrado en la estación.

    Devuelve None para S-P no positivo o no finito — nunca 0, NaN ni Infinity
    silenciosos, y nunca una distancia negativa.
    """
    if not math.isfinite(sp_seconds) or sp_seconds <= 0:
        return None

    factor = (P_VELOCITY_KM_S * S_VELOCITY_KM_S) / (P_VELOCITY_KM_S - S_VELOCITY_KM_S)
    return sp_seconds * factor


def coda_magnitude(coda_seconds: float) -> float | None:
    """Magnitud de coda: Mc = CODA_A · log10(t) + CODA_B (valores del JSON compartido).

    Devuelve None para duración no positiva o no finita: sin la guarda, t=0
    propaga -Infinity y t<0 propaga NaN hasta la UI y el CSV.

    No se recorta a cero: Mc(1 s) = CODA_B es negativo y es correcto.
    """
    if not math.isfinite(coda_seconds) or coda_seconds <= 0:
        return None

    return CODA_A * math.log10(coda_seconds) + CODA_B


# --- Mediciones derivadas de un conjunto de picks --------------------------


def compute_measurements(picks: list[SignalPickPublic]) -> PickMeasurements:
    """Mediciones derivadas de los picks de una ventana.

    La referencia es la PRIMERA fase de cada tipo en orden temporal: con dos
    eventos en la misma ventana, las derivadas corresponden al primero (la UI
    acota la ventana para aislar un evento).

    sp_seconds se devuelve aunque sea <= 0 — así la UI distingue "falta una
    fase" (None) de "S marcada antes que P" (negativo) y puede indicar orden
    inválido. La DISTANCIA sí es None en ese caso: la guarda de
    sp_distance_km no deja pasar un intervalo no positivo.
    """
    first: dict[PickPhase, datetime] = {}
    for pick in sorted(picks, key=lambda p: p.pick_time):
        first.setdefault(pick.phase, pick.pick_time)

    p_time = first.get(PickPhase.P)
    s_time = first.get(PickPhase.S)
    coda_time = first.get(PickPhase.CODA)

    sp_seconds = (s_time - p_time).total_seconds() if p_time and s_time else None
    coda_seconds = (coda_time - p_time).total_seconds() if p_time and coda_time else None

    return PickMeasurements(
        sp_seconds=sp_seconds,
        distance_km=sp_distance_km(sp_seconds) if sp_seconds is not None else None,
        coda_seconds=coda_seconds,
        coda_magnitude=coda_magnitude(coda_seconds) if coda_seconds is not None else None,
    )


def build_picks_csv(picks: list[SignalPickPublic]) -> str:
    """CSV de mediciones, armado SERVER-SIDE.

    Es el entregable que se va al flujo del sismólogo: si lo armara el
    cliente, distance_km y coda_magnitude saldrían de la copia TS y una
    deriva produciría un CSV con números que no coinciden con la pantalla.

    Las columnas derivadas se repiten por grupo (filas P y S llevan S-P y
    distancia; la fila coda lleva duración y magnitud), como en el ejemplo
    del diseño.
    """
    measurements = compute_measurements(picks)

    def _fmt(value: float | None) -> str:
        return "" if value is None else f"{value:.3f}"

    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(
        [
            "channel",
            "phase",
            "pick_time_utc",
            "note",
            "sp_seconds",
            "distance_km",
            "coda_seconds",
            "coda_magnitude",
        ]
    )
    for pick in sorted(picks, key=lambda p: p.pick_time):
        is_coda = pick.phase is PickPhase.CODA
        writer.writerow(
            [
                pick.channel,
                pick.phase.value,
                pick.pick_time.isoformat().replace("+00:00", "Z"),
                pick.note or "",
                _fmt(None if is_coda else measurements.sp_seconds),
                _fmt(None if is_coda else measurements.distance_km),
                _fmt(measurements.coda_seconds if is_coda else None),
                _fmt(measurements.coda_magnitude if is_coda else None),
            ]
        )
    return buffer.getvalue()


# --- CRUD (patrón WallService: pool prestado, ownership en el WHERE) -------


class SignalPickNotFoundError(Exception):
    """El pick no existe o pertenece a otro usuario (404 unificado, patrón walls)."""


_PICK_COLUMNS = "id, channel, phase, pick_time, note, created_at, updated_at"


def _row_to_public(row: asyncpg.Record) -> SignalPickPublic:
    return SignalPickPublic(
        id=row["id"],
        channel=row["channel"],
        phase=PickPhase(row["phase"]),
        pick_time=row["pick_time"],
        note=row["note"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class SignalPickService:
    """CRUD de picks. El pool es prestado: lo abre y cierra el lifespan."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list_for_window(
        self,
        user_id: UUID,
        channel: str,
        start: datetime | None = None,
        end: datetime | None = None,
    ) -> list[SignalPickPublic]:
        """Picks del usuario en el canal, opcionalmente acotados a una ventana."""
        query = f"SELECT {_PICK_COLUMNS} FROM signal_picks WHERE user_id = $1 AND channel = $2"
        params: list[object] = [user_id, channel]
        if start is not None:
            params.append(start)
            query += f" AND pick_time >= ${len(params)}"
        if end is not None:
            params.append(end)
            query += f" AND pick_time <= ${len(params)}"
        query += " ORDER BY pick_time"

        async with self._pool.acquire() as conn:
            rows = await conn.fetch(query, *params)
        return [_row_to_public(row) for row in rows]

    async def create(
        self,
        user_id: UUID,
        channel: str,
        phase: PickPhase,
        pick_time: datetime,
        note: str | None,
    ) -> SignalPickPublic:
        """Alta idempotente: el doble clic (misma fase, mismo instante) no
        duplica — el ON CONFLICT sobre el índice UNIQUE devuelve la fila
        existente actualizando sólo la nota."""
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"INSERT INTO signal_picks (user_id, channel, phase, pick_time, note) "
                f"VALUES ($1, $2, $3, $4, $5) "
                f"ON CONFLICT (user_id, channel, phase, pick_time) "
                f"DO UPDATE SET note = EXCLUDED.note, updated_at = now() "
                f"RETURNING {_PICK_COLUMNS}",
                user_id,
                channel,
                phase.value,
                pick_time,
                note,
            )
        return _row_to_public(row)

    async def update(
        self,
        pick_id: UUID,
        user_id: UUID,
        phase: PickPhase,
        pick_time: datetime,
        note: str | None,
    ) -> SignalPickPublic:
        async with self._pool.acquire() as conn:
            # Ownership en el WHERE: un pick ajeno devuelve row None → 404,
            # indistinguible de inexistente a propósito.
            row = await conn.fetchrow(
                f"UPDATE signal_picks SET phase = $3, pick_time = $4, note = $5, "
                f"updated_at = now() "
                f"WHERE id = $1 AND user_id = $2 RETURNING {_PICK_COLUMNS}",
                pick_id,
                user_id,
                phase.value,
                pick_time,
                note,
            )
        if row is None:
            raise SignalPickNotFoundError(f"Pick {pick_id} not found")
        return _row_to_public(row)

    async def delete(self, pick_id: UUID, user_id: UUID) -> None:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM signal_picks WHERE id = $1 AND user_id = $2",
                pick_id,
                user_id,
            )
        if result == "DELETE 0":
            raise SignalPickNotFoundError(f"Pick {pick_id} not found")
