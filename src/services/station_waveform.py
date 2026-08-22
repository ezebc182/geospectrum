"""Waveform decimado para el detalle de estación (helicorder / wave view).

La decimación min/max por bloque es la técnica estándar de los visores
sísmicos: cada par (min, max) resume un bloque de muestras, así los picos
NUNCA se pierden por submuestreo — a diferencia de un stride simple.
"""

import numpy as np
from scipy.signal import butter, filtfilt

# Paridad SWARM (WaveDefaults.config): bandpass orden 4, 1-10 Hz, zeroPhaseShift
FILTER_ORDER = 4
FILTER_LOW_HZ = 1.0
FILTER_HIGH_HZ = 10.0


def butterworth_bandpass(data: np.ndarray, fs: float) -> np.ndarray:
    """Bandpass 1-10 Hz zero-phase, los parámetros exactos de SWARM."""
    high = min(FILTER_HIGH_HZ, fs / 2 * 0.99)  # canales lentos: tope en Nyquist
    sos_b, sos_a = butter(FILTER_ORDER, [FILTER_LOW_HZ, high], btype="band", fs=fs)
    return filtfilt(sos_b, sos_a, np.asarray(data, dtype=np.float64))


def decimate_minmax(data: np.ndarray, target_pairs: int) -> tuple[np.ndarray, np.ndarray]:
    """(mins, maxs) por bloque; si la señal es más corta que el objetivo, pasa entera."""
    signal = np.asarray(data, dtype=np.float64)
    n = len(signal)
    if n <= target_pairs:
        return signal.copy(), signal.copy()

    # Bloques casi-iguales vía índices enteros (el último absorbe el resto)
    edges = np.linspace(0, n, target_pairs + 1).astype(int)
    mins = np.minimum.reduceat(signal, edges[:-1])
    maxs = np.maximum.reduceat(signal, edges[:-1])
    return mins, maxs
