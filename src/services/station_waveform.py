"""Waveform decimado para el detalle de estación (helicorder / wave view).

La decimación min/max por bloque es la técnica estándar de los visores
sísmicos: cada par (min, max) resume un bloque de muestras, así los picos
NUNCA se pierden por submuestreo — a diferencia de un stride simple.
"""

import numpy as np


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
