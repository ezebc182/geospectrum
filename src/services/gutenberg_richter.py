"""Estimación del b-value de Gutenberg-Richter por máxima verosimilitud.

Lógica PURA sobre una lista de magnitudes: sin I/O, sin fecha actual, misma
entrada ⇒ misma salida. El router de `/analytics` le agrega ventana y área.

Método (`METHOD = "aki-utsu-mle"`):

    Mc  = MAXC + mcCorrection                 # bin de máximo conteo del histograma NO
                                              # acumulado (Wiemer & Wyss 2000) + 0,2
                                              # (Woessner & Wiemer 2005) — solo con mc=None
    M*  = { Mi : Mi ≥ Mc }                    # el N que cuenta es ESTE, no el catálogo entero
    b   = log10(e) / (mean(M*) − (Mc − ΔM/2)) # Aki (1965); ΔM/2 es la corrección de
                                              # binning de Utsu (1965): sin ella, un catálogo
                                              # con b=1.0 devuelve 1.125
    σ_b = 2.30 · b² · sqrt(Σ(Mi − mean)² / (N·(N−1)))   # Shi & Bolt (1982)
    a   = log10(N) + b · Mc

Tres resultados posibles, discriminados por `status`:
  * `"ok"`           — con `b`, `a`, `sigma_b`;
  * `"insufficient"` — `n_above_mc < MIN_EVENTS` (o catálogo vacío);
  * `"degenerate"`   — N alcanza pero todas las magnitudes sobre Mc son iguales
                       (la MLE daría log10(e)/(ΔM/2) = 8.69, absurdo pero serializable).
En los dos últimos el atributo `b` NO EXISTE (ni None ni NaN): la UI no puede
mostrar por accidente un número que el estimador no respalda.

Referencias: Aki (1965) Bull. Earthq. Res. Inst. 43; Utsu (1965) Geophys.
Bull. Hokkaido Univ. 13; Shi & Bolt (1982) BSSA 72; Wiemer & Wyss (2000) BSSA
90; Woessner & Wiemer (2005) BSSA 95.

Las constantes viven en `dashboard/lib/seismic-constants.json` (FUENTE ÚNICA
compartida con el frontend, que dibuja el histograma con el mismo ΔM). Carga
a nivel de módulo, sin defaults: una clave ausente revienta al importar.
"""

import json
import math
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal, Optional, Union

from src.models.event import SeismicEvent

# Resuelve a <raíz del repo>/dashboard/lib/seismic-constants.json (patrón de
# signal_picks.py): parents[2] desde src/services/ es la raíz del repo.
_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)
_C = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))

# Acceso por clave a propósito (sin .get): la clave ausente debe reventar acá.
BIN_WIDTH: float = _C["magnitudeBinWidth"]
MC_CORRECTION: float = _C["mcCorrection"]
MIN_EVENTS: int = _C["bValueMinEvents"]

METHOD = "aki-utsu-mle"

# Tolerancia para comparar magnitudes con bordes de bin: 2.3 / 0.1 da 22.999…
# en coma flotante y sin esto una magnitud exactamente en el borde caería en
# el bin de abajo. NO cambia ningún resultado con magnitudes a un decimal.
_EPS = 1e-9


@dataclass(frozen=True)
class MagnitudeBin:
    """Un bin del histograma: `m` es el borde inferior (múltiplo de ΔM)."""

    m: float
    count: int  # no acumulado
    cumulative: int  # N(M ≥ m)


@dataclass(frozen=True)
class _BValueFitBase:
    method: str
    n_total: int
    n_above_mc: int
    min_events: int
    mc: Optional[float]  # None solo con catálogo vacío y mc=None
    mc_at_catalog_floor: bool
    bins: list[MagnitudeBin] = field(compare=True)


@dataclass(frozen=True)
class BValueOkFit(_BValueFitBase):
    status: Literal["ok"] = "ok"
    b: float = 0.0
    a: float = 0.0
    sigma_b: float = 0.0


@dataclass(frozen=True)
class BValueNotEstimableFit(_BValueFitBase):
    status: Literal["insufficient", "degenerate"] = "insufficient"


BValueFit = Union[BValueOkFit, BValueNotEstimableFit]


def _bin_index(mag: float) -> int:
    """Índice entero del bin que contiene `mag` (piso, tolerante al borde)."""
    return int(math.floor(mag / BIN_WIDTH + _EPS))


def _bin_edge(index: int) -> float:
    """Borde inferior del bin `index`, redondeado para que 23·0.1 sea 2.3 y no 2.3000000000000003."""
    return round(index * BIN_WIDTH, 6)


def magnitude_bins(mags: Sequence[float]) -> list[MagnitudeBin]:
    """Histograma contiguo de `mags` desde el bin del mínimo hasta el del máximo.

    Los bins intermedios sin eventos se incluyen con `count = 0`: un histograma
    que saltea bins vacíos dibuja una pendiente que no existe. `cumulative` es
    N(M ≥ m), lo que se grafica en la FMD acumulada.
    """
    if not mags:
        return []
    per_index = Counter(_bin_index(m) for m in mags)
    lo, hi = min(per_index), max(per_index)
    bins: list[MagnitudeBin] = []
    remaining = len(mags)
    for index in range(lo, hi + 1):
        count = per_index.get(index, 0)
        bins.append(MagnitudeBin(m=_bin_edge(index), count=count, cumulative=remaining))
        remaining -= count
    return bins


def estimate_mc_maxc(bins: Sequence[MagnitudeBin]) -> tuple[Optional[float], bool]:
    """(Mc, mc_at_catalog_floor) por máxima curvatura: bin de máximo conteo + MC_CORRECTION.

    Devuelve `(None, False)` sin bins. Ante empate gana el bin más bajo (el
    primero): es el criterio conservador, Mc más chico ⇒ más eventos.
    `mc_at_catalog_floor` avisa que el pico está en el bin MÁS BAJO del catálogo:
    el pico refleja el piso de ingesta (`source_min_magnitude`), no la red, y el
    Mc real podría ser menor.
    """
    if not bins:
        return None, False
    peak = max(bins, key=lambda b: b.count)  # max() devuelve el primero ante empate
    return round(peak.m + MC_CORRECTION, 6), peak.m == bins[0].m


def _mc_at_floor(bins: Sequence[MagnitudeBin], mc: float) -> bool:
    """Con Mc explícito: ¿queda en (o por debajo de) el bin más bajo del catálogo + corrección?

    Es la misma pregunta que responde `estimate_mc_maxc` para el Mc automático:
    un Mc que no supera el piso del catálogo está truncado por la ingesta.
    """
    return bool(bins) and mc <= bins[0].m + MC_CORRECTION + _EPS


def fit_b_value(mags: Sequence[float], mc: Optional[float] = None) -> BValueFit:
    """Ajuste Aki-Utsu MLE con σ de Shi & Bolt. `mc=None` ⇒ `estimate_mc_maxc()`.

    Guardas, en este orden: catálogo vacío ⇒ `insufficient`; `n_above_mc <
    MIN_EVENTS` ⇒ `insufficient`; varianza cero sobre Mc ⇒ `degenerate`. Nunca
    lanza por catálogo vacío. Determinista y sin I/O.
    """
    n_total = len(mags)
    bins = magnitude_bins(mags)

    if mc is None:
        mc, at_floor = estimate_mc_maxc(bins)
    else:
        at_floor = _mc_at_floor(bins, mc)

    if mc is None:
        above: list[float] = []
    else:
        # Decisión 2 de la spec: N se cuenta DESPUÉS de filtrar por Mc.
        above = [m for m in mags if m >= mc - _EPS]
    n_above = len(above)

    base = dict(
        method=METHOD,
        n_total=n_total,
        n_above_mc=n_above,
        min_events=MIN_EVENTS,
        mc=mc,
        mc_at_catalog_floor=at_floor,
        bins=bins,
    )

    if n_above < MIN_EVENTS:
        return BValueNotEstimableFit(status="insufficient", **base)

    mean = sum(above) / n_above
    if max(above) - min(above) < _EPS:
        return BValueNotEstimableFit(status="degenerate", **base)

    assert mc is not None  # n_above ≥ MIN_EVENTS ≥ 50 implica que hubo Mc
    b = math.log10(math.e) / (mean - (mc - BIN_WIDTH / 2))
    sum_sq = sum((m - mean) ** 2 for m in above)
    sigma_b = 2.30 * b * b * math.sqrt(sum_sq / (n_above * (n_above - 1)))
    a = math.log10(n_above) + b * mc
    return BValueOkFit(status="ok", b=b, a=a, sigma_b=sigma_b, **base)


def mag_type_counts(events: Sequence[SeismicEvent]) -> dict[str, int]:
    """Cuántos eventos hay por escala de magnitud (`mag_tipo`); `None`/vacío ⇒ `"unknown"`.

    Gutenberg-Richter asume UNA escala; el catálogo fusionado mezcla varias.
    No se filtra (partiría más el N): se expone para que quien lee sepa qué mira.
    """
    return dict(Counter((ev.mag_tipo or "unknown") for ev in events))
