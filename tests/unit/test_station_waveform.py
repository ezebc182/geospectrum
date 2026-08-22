"""Waveform de estación: decimación min/max y filtro Butterworth (paridad SWARM)."""

import numpy as np
import pytest

from src.services.station_waveform import decimate_minmax


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
