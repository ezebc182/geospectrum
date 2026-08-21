"""Cálculo espectral con paridad exacta a SWARM (USGS, dominio público CC0).

Port de volcano-core gov.usgs.volcanoes.core.data.Spectrogram: ventana
Kaiser beta=5, bin de 2 s redondeado a la siguiente potencia de 2, overlap
0.859375 (220/256) y dB = 20*log10(|FFT|/1) con la FFT CRUDA — sin
normalizar por N. Esa referencia es la que hace que la escala fija
20-120 dB de SWARM tenga sentido sobre counts de sismómetro.

No filtra la señal (SWARM tampoco): solo remueve la media (removeBias).
"""

import numpy as np

KAISER_BETA = 5
BIN_SECONDS = 2.0
OVERLAP_FRACTION = 0.859375  # el valor exacto de SWARM, no un 0.86 "redondo"
DB_MULTIPLIER = 20  # amplitud (20*log10), no potencia (10*log10)
MAX_FREQ_HZ = 25.0  # vista por defecto de SWARM

# Escala fija de potencia de SWARM (WaveDefaults.config). El frontend usa
# los mismos valores: el rojo significa 120 dB reales, no "el 5% más alto".
MIN_POWER_DB = 20.0
MAX_POWER_DB = 120.0

_EPS = 1e-12  # evita log10(0) en bins exactamente nulos


def swarm_bin_samples(fs: float) -> int:
    """Muestras por bin: BIN_SECONDS redondeado a potencia de 2 (como SWARM)."""
    return int(2 ** np.ceil(np.log2(BIN_SECONDS * fs)))


def _freq_mask(nbin: int, fs: float) -> tuple[np.ndarray, np.ndarray]:
    freqs = np.fft.rfftfreq(nbin, 1.0 / fs)
    return freqs, freqs <= min(MAX_FREQ_HZ, fs / 2)


def swarm_column_db(data: np.ndarray, fs: float) -> tuple[np.ndarray, np.ndarray]:
    """(freqs, power_db) del ÚLTIMO bin de la señal — la columna en vivo."""
    nbin = swarm_bin_samples(fs)
    if len(data) < nbin:
        raise ValueError(f"señal de {len(data)} muestras; el bin necesita {nbin}")

    tail = np.asarray(data[-nbin:], dtype=np.float64)
    tail = tail - tail.mean()
    spec = np.abs(np.fft.rfft(tail * np.kaiser(nbin, KAISER_BETA)))
    freqs, mask = _freq_mask(nbin, fs)
    power_db = DB_MULTIPLIER * np.log10(spec[mask] + _EPS)
    return freqs[mask], power_db


def swarm_spectrogram_db(
    data: np.ndarray, fs: float, max_columns: int | None = None
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(freqs, times_s, power_db[freq, col]) de la señal completa.

    max_columns submuestrea POSICIONES temporales (para señales largas donde
    el overlap de SWARM daría cientos de miles de columnas); cada columna
    sigue siendo un bin Kaiser idéntico, así que los dB no cambian.
    """
    nbin = swarm_bin_samples(fs)
    if len(data) < nbin:
        raise ValueError(f"señal de {len(data)} muestras; el bin necesita {nbin}")

    signal = np.asarray(data, dtype=np.float64)
    overlap = int(nbin * OVERLAP_FRACTION)
    hop = nbin - overlap
    ncols = (len(signal) - overlap) // hop

    starts = hop * np.arange(ncols)
    if max_columns is not None and ncols > max_columns:
        starts = starts[:: int(np.ceil(ncols / max_columns))]
    bins = signal[starts[:, None] + np.arange(nbin)[None, :]]
    # Demean POR BIN (como el removeBias de SWARM sobre la ventana visible).
    # Un demean global sobre horas de señal deja la deriva del instrumento
    # como offset gigante en los bins de las puntas y ~cero en el centro:
    # pintaba un embudo simétrico idéntico en estaciones distintas.
    bins = bins - bins.mean(axis=1, keepdims=True)
    spec = np.abs(np.fft.rfft(bins * np.kaiser(nbin, KAISER_BETA), axis=1)).T

    freqs, mask = _freq_mask(nbin, fs)
    power_db = DB_MULTIPLIER * np.log10(spec[mask] + _EPS)
    # centro temporal de cada bin, como computeTime() de SWARM
    times = (starts + nbin / 2) / fs
    return freqs[mask], times, power_db
