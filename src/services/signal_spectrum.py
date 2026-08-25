"""Espectro 1D (Power vs Hz) de una ventana completa — paridad SWARM.

A diferencia de swarm_spectrogram_db (que corta la señal en bins solapados y
devuelve una matriz), acá la ventana ENTERA es un solo bin: una FFT, un
espectro. Es el corte 1D que SWARM muestra bajo la onda.

Las constantes se IMPORTAN de swarm_spectra: son la misma referencia física.
Redefinirlas acá haría que el corte 1D y el 2D de la misma ventana dieran
números distintos.
"""

import numpy as np

from src.services.swarm_spectra import (
    DB_MULTIPLIER,
    KAISER_BETA,
    MAX_FREQ_HZ,
    _EPS,
)


def window_spectrum_db(data: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """(freqs, power_db) de la ventana completa. Demean + Kaiser + rfft."""
    signal = np.asarray(data, dtype=np.float64)
    if signal.size < 2:
        raise ValueError(f"ventana de {signal.size} muestras: insuficiente")
    signal = signal - signal.mean()
    spec = np.abs(np.fft.rfft(signal * np.kaiser(signal.size, KAISER_BETA)))
    freqs = np.fft.rfftfreq(signal.size, 1.0 / fs)
    mask = freqs <= effective_max_freq_hz(fs)
    return freqs[mask], DB_MULTIPLIER * np.log10(spec[mask] + _EPS)


def effective_max_freq_hz(fs: float) -> float:
    """Techo real del eje: Nyquist si el canal es más lento que la vista SWARM."""
    return float(min(MAX_FREQ_HZ, fs / 2))
