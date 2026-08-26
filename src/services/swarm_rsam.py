"""
RSAM (Real-time Seismic Amplitude Measurement) con paridad SWARM.

Adelantado del PR D del detalle de estación: el PR-W3 lo usa para las
métricas por canal del muro. Lógica pura sin threads ni Redis — el
ingestor la alimenta con una muestra por tick y decide cuándo publicar.

Paridad SWARM (RsamDefaults.config / RSAMData.countEvents, CC0):
- RSAM = media móvil de |señal demeaned| por período (default 600 s).
- Evento: v >= threshold Y v >= v[i-2] * ratio (threshold=50, ratio=1.3).
  Una corrida contigua de ticks que cumplen la condición cuenta UN evento
  (contar cada tick inflaría eventos/hora hasta volverla inútil).
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta

import numpy as np

RSAM_PERIOD_SECONDS = 600
EVENTS_WINDOW_SECONDS = 3600
EVENT_THRESHOLD = 50.0
EVENT_RATIO = 1.3


def rsam_sample(data: np.ndarray) -> float:
    """Media de |señal demeaned| de una ventana corta (un tick del ingestor)."""
    if data.size == 0:
        return 0.0
    centered = data.astype(np.float64) - float(np.mean(data))
    return float(np.mean(np.abs(centered)))


class RsamAccumulator:
    """Serie rodante de muestras RSAM de un canal (una muestra por tick).

    Retiene solo la última hora (ventana de eventos/hora): a 1 muestra
    cada 4 s son ≤900 floats por canal — memoria despreciable.
    """

    def __init__(self, max_window_s: int = EVENTS_WINDOW_SECONDS) -> None:
        self._max_window_s = max_window_s
        self._samples: deque[tuple[datetime, float]] = deque()

    def add(self, value: float, at: datetime) -> None:
        self._samples.append((at, value))
        cutoff = at - timedelta(seconds=self._max_window_s)
        while self._samples and self._samples[0][0] < cutoff:
            self._samples.popleft()

    def rsam(self, now: datetime, period_s: int = RSAM_PERIOD_SECONDS) -> float | None:
        cutoff = now - timedelta(seconds=period_s)
        values = [v for t, v in self._samples if t >= cutoff]
        if not values:
            return None
        return float(np.mean(values))

    def events_last_hour(
        self,
        now: datetime,
        threshold: float = EVENT_THRESHOLD,
        ratio: float = EVENT_RATIO,
    ) -> int:
        cutoff = now - timedelta(seconds=EVENTS_WINDOW_SECONDS)
        values = [v for t, v in self._samples if t >= cutoff]
        events = 0
        in_event = False
        for i in range(2, len(values)):
            hit = values[i] >= threshold and values[i] >= values[i - 2] * ratio
            if hit and not in_event:
                events += 1
            in_event = hit
        return events


def rsam_series(
    data: np.ndarray, fs: float, period_s: int = RSAM_PERIOD_SECONDS
) -> list[float]:
    """Una muestra RSAM por ventana contigua de `period_s`.

    Reusa rsam_sample(): el número del muro y el punto del gráfico salen de la
    MISMA fórmula. Si divergieran, comparar las dos pantallas sería mentira.

    Las ventanas son contiguas y NO solapadas (a diferencia del espectrograma):
    RSAM es una media móvil por período, no una STFT.
    """
    per_window = int(period_s * fs)
    if per_window <= 0 or data.size < per_window:
        return []
    n_windows = data.size // per_window  # la cola parcial se descarta a propósito
    blocks = np.asarray(data[: n_windows * per_window], dtype=np.float64)
    return [rsam_sample(block) for block in blocks.reshape(n_windows, per_window)]
