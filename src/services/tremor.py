"""Caracterización de episodios sostenidos de amplitud (candidatos a tremor).

Dos capas, a propósito (Decision 4 del design, regla 1 de la spec de
`signal-analysis`):

  * **Capa 1 — `classify_episodes(samples)`**: PURA sobre la serie RSAM, con la
    MISMA forma que `samples` de `GET /stations/{channel}/rsam`. Nunca ve la
    forma de onda ni recalcula amplitud: la única fórmula de amplitud del
    sistema sigue siendo `rsam_series()` (`swarm_rsam.py`). Se testea con
    listas de números.
  * **Capa 2 — `characterize(signal, fs, start)`**: corre `rsam_series` sobre
    la traza, llama a la capa 1 y ENRIQUECE cada episodio con el espectro del
    mismo período (frecuencia dominante, índice de frecuencia, banda). No
    cambia qué es episodio.

Clasificación (capa 1):

    baseline   = mediana de las muestras no nulas       (None si no hay ninguna)
    threshold  = baseline × tremorBaselineFactor
    elevada[i] = value[i] is not None and value[i] ≥ threshold
    episodio   = corrida de ≥ tremorMinDurationPeriods muestras CONSECUTIVAS elevadas
    None       = ni elevada ni cero: corta la corrida y NO cuenta en el denominador
    tremor_fraction = muestras dentro de algún episodio / muestras no nulas

Se usa la mediana y no la media porque la meseta que se quiere detectar es
justamente lo que arrastraría la media hacia arriba. Limitación documentada:
un episodio que ocupe MÁS de la mitad de la ventana sube la mediana y no se
detecta — el panel muestra `baseline_rsam` para que eso sea visible.

Lo que esto NO afirma: "tremor volcánico". Con una estación y sin contexto
sólo se puede afirmar amplitud sostenida, banda dominante y signo del FI; la
interpretación es del sismólogo. La UI lo llama "episodio sostenido".

Las constantes viven en `dashboard/lib/seismic-constants.json` (FUENTE
ÚNICA: el frontend dibuja el umbral y la leyenda de bandas con los mismos
números). Carga a nivel de módulo, sin defaults.
"""

import json
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal, Optional

import numpy as np

from src.services.signal_spectrum import window_spectrum_db
from src.services.swarm_rsam import RSAM_PERIOD_SECONDS, rsam_series
from src.services.swarm_spectra import dominant_frequency_hz, frequency_index

# Patrón de signal_picks.py: parents[2] desde src/services/ es la raíz del repo.
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)
_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))

# Acceso por clave a propósito (sin .get): la clave ausente debe reventar acá.
BASELINE_FACTOR: float = _C["tremorBaselineFactor"]
MIN_DURATION_PERIODS: int = _C["tremorMinDurationPeriods"]
LOW_BAND_MAX_HZ: float = _C["tremorLowBandMaxHz"]
MID_BAND_MAX_HZ: float = _C["tremorMidBandMaxHz"]

Band = Literal["low", "mid", "high", "undefined"]
FiSign = Literal["lp_like", "vt_like", "undefined"]

RsamSample = tuple[datetime, Optional[float]]


@dataclass(frozen=True)
class TremorEpisodeCore:
    """Un episodio según la capa 1. `first_index`/`last_index` son posiciones en
    la serie de entrada: la capa 2 los usa para promediar el espectro del tramo."""

    start: datetime
    end: datetime
    samples: int
    mean_ratio: float
    peak_rsam: float
    peak_ratio: float
    onset_ratio: float
    first_index: int
    last_index: int


@dataclass(frozen=True)
class TremorClassification:
    baseline_rsam: Optional[float]
    threshold_rsam: Optional[float]
    tremor_fraction: float
    parameters: dict[str, float | int]
    episodes: list[TremorEpisodeCore]


def _parameters() -> dict[str, float | int]:
    return {
        "baseline_factor": BASELINE_FACTOR,
        "min_duration_periods": MIN_DURATION_PERIODS,
    }


def _elevated_runs(flags: Sequence[bool]) -> list[tuple[int, int]]:
    """Corridas `(first, last)` de `True` consecutivos con largo ≥ MIN_DURATION_PERIODS."""
    runs: list[tuple[int, int]] = []
    run_start: Optional[int] = None
    for i, elevated in enumerate(flags):
        if elevated and run_start is None:
            run_start = i
        elif not elevated and run_start is not None:
            if i - run_start >= MIN_DURATION_PERIODS:
                runs.append((run_start, i - 1))
            run_start = None
    if run_start is not None and len(flags) - run_start >= MIN_DURATION_PERIODS:
        runs.append((run_start, len(flags) - 1))
    return runs


def classify_episodes(samples: Sequence[RsamSample]) -> TremorClassification:
    """Capa 1: episodios sostenidos sobre la serie RSAM `[(t, value | None)]`.

    Serie vacía, toda `None` o con línea base no positiva (canal muerto) ⇒
    `episodes=[]`, `tremor_fraction=0.0`, sin lanzar. Determinista, sin I/O.
    """
    values = [v for _, v in samples if v is not None]
    if not values:
        return TremorClassification(None, None, 0.0, _parameters(), [])

    baseline = float(statistics.median(values))
    threshold = baseline * BASELINE_FACTOR
    if baseline <= 0.0:
        # Sin señal no hay "elevado": todo sería ≥ 0 y la razón dividiría por cero.
        return TremorClassification(baseline, threshold, 0.0, _parameters(), [])

    flags = [v is not None and v >= threshold for _, v in samples]
    episodes: list[TremorEpisodeCore] = []
    for first, last in _elevated_runs(flags):
        tramo = [samples[i][1] for i in range(first, last + 1)]
        tramo_values = [v for v in tramo if v is not None]  # todos no nulos por construcción
        peak = max(tramo_values)
        episodes.append(
            TremorEpisodeCore(
                start=samples[first][0],
                end=samples[last][0],
                samples=len(tramo_values),
                mean_ratio=sum(tramo_values) / len(tramo_values) / baseline,
                peak_rsam=peak,
                peak_ratio=peak / baseline,
                onset_ratio=tramo_values[0] / peak,
                first_index=first,
                last_index=last,
            )
        )

    in_episode = sum(ep.samples for ep in episodes)
    return TremorClassification(
        baseline_rsam=baseline,
        threshold_rsam=threshold,
        tremor_fraction=in_episode / len(values),
        parameters=_parameters(),
        episodes=episodes,
    )


# --- Capa 2: enriquecimiento espectral sobre la MISMA traza ------------------


@dataclass(frozen=True)
class TremorEpisode:
    """Episodio de la capa 1 más su caracterización espectral (contrato de `/analytics/tremor`)."""

    start: datetime
    end: datetime
    samples: int
    duration_s: int
    mean_ratio: float
    peak_rsam: float
    peak_ratio: float
    onset_ratio: float
    mean_dominant_hz: Optional[float]
    mean_fi: Optional[float]
    band: Band
    fi_sign: FiSign


@dataclass(frozen=True)
class TremorResult:
    """Salida de `characterize`. El router agrega `channel`."""

    sampling_rate: float
    period_seconds: int
    baseline_rsam: Optional[float]
    threshold_rsam: Optional[float]
    tremor_fraction: float
    parameters: dict[str, float | int]
    samples: list[dict[str, object]]  # {t, rsam, dominant_hz, fi}; t = CENTRO de la ventana
    episodes: list[TremorEpisode]


def _band(mean_dominant_hz: Optional[float]) -> Band:
    if mean_dominant_hz is None:
        return "undefined"
    if mean_dominant_hz < LOW_BAND_MAX_HZ:
        return "low"
    if mean_dominant_hz < MID_BAND_MAX_HZ:
        return "mid"
    return "high"


def _fi_sign(mean_fi: Optional[float]) -> FiSign:
    if mean_fi is None:
        return "undefined"
    return "lp_like" if mean_fi < 0 else "vt_like"


def _mean_or_none(values: Sequence[Optional[float]]) -> Optional[float]:
    present = [v for v in values if v is not None]
    return sum(present) / len(present) if present else None


def characterize(signal: np.ndarray, fs: float, start: datetime) -> TremorResult:
    """Capa 2: `rsam_series()` + `classify_episodes()` + espectro por período.

    Los bloques espectrales usan los MISMOS cortes contiguos que RSAM para que
    cada punto tenga un FI asociado sin interpolar. `t` es el centro de cada
    ventana, igual que en `/rsam` (`start + (i + 0.5) · period`).
    """
    period = RSAM_PERIOD_SECONDS
    rsam = rsam_series(signal, fs, period)
    per_window = int(period * fs)
    data = np.asarray(signal, dtype=np.float64)

    times: list[datetime] = []
    dominant: list[Optional[float]] = []
    fi: list[Optional[float]] = []
    for i in range(len(rsam)):
        block = data[i * per_window : (i + 1) * per_window]
        freqs, power_db = window_spectrum_db(block, fs)
        times.append(start + timedelta(seconds=(i + 0.5) * period))
        dominant.append(dominant_frequency_hz(freqs, power_db))
        fi.append(frequency_index(freqs, power_db))

    cls = classify_episodes(list(zip(times, rsam)))

    episodes: list[TremorEpisode] = []
    for ep in cls.episodes:
        span = slice(ep.first_index, ep.last_index + 1)
        mean_dominant = _mean_or_none(dominant[span])
        mean_fi = _mean_or_none(fi[span])
        episodes.append(
            TremorEpisode(
                start=ep.start,
                end=ep.end,
                samples=ep.samples,
                duration_s=ep.samples * period,
                mean_ratio=ep.mean_ratio,
                peak_rsam=ep.peak_rsam,
                peak_ratio=ep.peak_ratio,
                onset_ratio=ep.onset_ratio,
                mean_dominant_hz=mean_dominant,
                mean_fi=mean_fi,
                band=_band(mean_dominant),
                fi_sign=_fi_sign(mean_fi),
            )
        )

    return TremorResult(
        sampling_rate=fs,
        period_seconds=period,
        baseline_rsam=cls.baseline_rsam,
        threshold_rsam=cls.threshold_rsam,
        tremor_fraction=cls.tremor_fraction,
        parameters=cls.parameters,
        samples=[
            {"t": t, "rsam": r, "dominant_hz": d, "fi": f}
            for t, r, d, f in zip(times, rsam, dominant, fi)
        ],
        episodes=episodes,
    )
