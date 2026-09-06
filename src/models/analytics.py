"""Modelos de respuesta de `/analytics` (analytics-professional-panels, 3.1).

Espejo 1:1 de "Interfaces / Contracts" del design. Lo que estos tipos
GARANTIZAN (y los tests de `test_analytics_models.py` fijan):

- b-value es una unión discriminada por `status` ([R8]/[R9]): en
  `insufficient` y `degenerate` el campo `b` NO EXISTE en el body — ni
  siquiera como `null` — porque `BValueNotEstimable` no lo declara. Un
  frontend que lea `body.b` sin mirar `status` se rompe en tipos, no en
  producción con un `null` que se dibuja como `0`.
- `null` ≠ `0` ([R12], [R4]): `UptimeBucket.ratio`, `overall[channel]`,
  `baseline_rsam` y `threshold_rsam` son `Optional` a propósito. `None`
  quiere decir "nadie miró" / "sin datos"; `0.0` quiere decir "se miró y
  no había nada". Son dos hechos distintos y viajan distintos.

La lógica que produce estos valores vive en `src/services/` (dataclasses
puros, sin Pydantic); el router mapea. Este módulo no importa servicios.
"""

from datetime import datetime
from typing import Annotated, Literal, Optional, Union

from pydantic import BaseModel, Field

from src.models.event import SeismicEvent

# --- b-value ----------------------------------------------------------------


class MagnitudeBin(BaseModel):
    m: float  # borde inferior del bin (múltiplo de magnitudeBinWidth)
    count: int  # no acumulado
    cumulative: int  # N(M >= m)


class _BValueBase(BaseModel):
    method: Literal["aki-utsu-mle"]
    n_total: int
    n_above_mc: int
    min_events: int  # bValueMinEvents del JSON — la UI no lo hardcodea
    mc: Optional[float]  # None si el catálogo está vacío
    mc_at_catalog_floor: bool
    bins: list[MagnitudeBin]
    mag_type_counts: dict[str, int]  # "unknown" para mag_tipo None
    window_start: datetime
    window_end: datetime
    area_slug: Optional[str]  # None ⇒ global (área no resuelta)


class BValueOk(_BValueBase):
    """Estimación válida. Es el ÚNICO miembro de la unión con `b`/`a`/`sigma_b`."""

    status: Literal["ok"]
    b: float
    a: float
    sigma_b: float


class BValueNotEstimable(_BValueBase):
    """[R8]/[R9]: sin `b`. `insufficient` = N bajo el mínimo; `degenerate` =
    todas las magnitudes sobre Mc iguales (el MLE daría un número absurdo)."""

    status: Literal["insufficient", "degenerate"]


BValueResponse = Annotated[Union[BValueOk, BValueNotEstimable], Field(discriminator="status")]


# --- hipocentros --------------------------------------------------------------


class HypocentersResponse(BaseModel):
    eventos: list[SeismicEvent]  # ORDER BY mag DESC, recortado a `limit`
    total: int  # antes del recorte
    truncated: bool
    window_start: datetime
    window_end: datetime
    area_slug: Optional[str]


# --- uptime de estaciones -----------------------------------------------------


class UptimeBucket(BaseModel):
    bucket_start: datetime
    columns_count: int  # 0 si el canal no tiene fila en el bucket
    observed_hours: int  # horas del bucket con fila de ALGÚN canal (0 o 1 en bucket=hour)
    expected: int  # EXPECTED_COLUMNS_PER_HOUR × observed_hours  [R12]
    ratio: Optional[float]  # min(1, count/expected); None si observed_hours == 0
    in_progress: bool  # el bucket contiene `now`


class StationUptimeResponse(BaseModel):
    bucket: Literal["hour", "day"]
    window_start: datetime
    window_end: datetime
    expected_columns_per_hour: int  # 900, derivado de COLUMN_INTERVAL_SECONDS
    # clave: channel de 4 partes (trace.id); TODOS los buckets de la ventana, siempre
    stations: dict[str, list[UptimeBucket]]
    overall: dict[str, Optional[float]]  # ratio agregado; None si no se observó nunca [R12]


# --- tremor -------------------------------------------------------------------


class TremorEpisode(BaseModel):
    start: datetime  # t de la primera muestra del episodio
    end: datetime  # t de la última muestra del episodio
    samples: int  # cantidad de muestras del episodio (spec)
    duration_s: int  # samples × period_seconds
    mean_ratio: float  # media de rsam/baseline dentro del episodio (spec)
    peak_rsam: float
    peak_ratio: float  # peak / baseline
    onset_ratio: float  # rsam[start] / peak — bajo = emergente
    mean_dominant_hz: Optional[float]
    mean_fi: Optional[float]
    band: Literal["low", "mid", "high", "undefined"]
    fi_sign: Literal["lp_like", "vt_like", "undefined"]


class TremorParameters(BaseModel):
    baseline_factor: float  # tremorBaselineFactor del JSON
    min_duration_periods: int  # tremorMinDurationPeriods del JSON


class TremorResponse(BaseModel):
    channel: str
    sampling_rate: float
    period_seconds: int
    baseline_rsam: Optional[float]  # None si no hay muestras (spec: "sin datos" explícito)
    threshold_rsam: Optional[float]  # baseline × tremorBaselineFactor
    tremor_fraction: float  # muestras en episodio / muestras no nulas; 0.0 sin datos [R4]
    parameters: TremorParameters  # [R4]
    # {t, rsam, dominant_hz, fi} — t = CENTRO de la ventana; `rsam` == `value` de /rsam
    samples: list[dict]
    episodes: list[TremorEpisode]
