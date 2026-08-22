"""Waveform de estación: decimación min/max y filtro Butterworth (paridad SWARM)."""

import numpy as np
import pytest

from src.services.station_waveform import butterworth_bandpass, decimate_minmax


def test_decimacion_preserva_los_extremos():
    # Un pico positivo y uno negativo enterrados en ruido NO pueden
    # desaparecer al decimar: min/max por bloque los retiene siempre.
    data = np.zeros(100_000)
    data[12_345] = 500.0
    data[67_890] = -700.0

    mins, maxs = decimate_minmax(data, 800)

    assert len(mins) == len(maxs) == 800
    assert maxs.max() == 500.0
    assert mins.min() == -700.0


def test_senal_corta_pasa_entera():
    data = np.array([1.0, -2.0, 3.0])
    mins, maxs = decimate_minmax(data, 800)
    assert np.array_equal(mins, data)
    assert np.array_equal(maxs, data)


def test_min_nunca_supera_al_max():
    rng = np.random.default_rng(42)
    data = rng.normal(size=50_000)
    mins, maxs = decimate_minmax(data, 640)
    assert np.all(mins <= maxs)


def _sine(freq_hz, fs, seconds, amp=1.0):
    t = np.arange(int(fs * seconds)) / fs
    return amp * np.sin(2 * np.pi * freq_hz * t)


def test_bandpass_conserva_la_banda_y_mata_la_deriva():
    fs = 100.0
    in_band = _sine(5.0, fs, 30.0, amp=100.0)
    drift = np.linspace(0, 10_000, int(fs * 30))  # deriva lenta fuera de banda

    out = butterworth_bandpass(in_band + drift, fs)

    core = out[int(fs * 5) : -int(fs * 5)]  # descartar transitorios de borde
    assert np.abs(core).max() == pytest.approx(100.0, rel=0.05)


def test_bandpass_es_zero_phase():
    # filtfilt no desfasa: el pico del seno filtrado coincide con el original.
    fs = 100.0
    sine = _sine(5.0, fs, 30.0, amp=100.0)
    out = butterworth_bandpass(sine, fs)
    center = slice(int(fs * 10), int(fs * 20))
    lag = np.argmax(np.correlate(out[center], sine[center], "full")) - (len(sine[center]) - 1)
    assert lag == 0
