"""Tests del espectro 1D (Fase 3, tareas 3.2-3.5).

La referencia física se pinea con LITERALES (beta=5, multiplicador=20): si las
constantes compartidas de swarm_spectra cambian, estos tests tienen que ponerse
rojos — es la garantía de que el corte 1D y el 2D siguen dando los mismos
números (mutaciones #6 y #7 del mutation-log).
"""

import numpy as np
import pytest
from obspy import Trace

from src.services.signal_spectrum import effective_max_freq_hz, window_spectrum_db
from src.services.station_waveform import build_waveform_response


def _sinusoid(f0: float, fs: float, seconds: float) -> np.ndarray:
    t = np.arange(int(seconds * fs)) / fs
    return 1000.0 * np.sin(2 * np.pi * f0 * t)


class TestWindowSpectrumDb:
    def test_el_pico_cae_en_la_frecuencia_de_la_sinusoide(self):
        # 10 s a 100 Hz: resolución de 0.1 Hz, sobra para exigir ±0.5 Hz.
        freqs, power_db = window_spectrum_db(_sinusoid(5.0, 100.0, 10.0), 100.0)
        assert abs(freqs[int(np.argmax(power_db))] - 5.0) <= 0.5

    def test_misma_longitud_freqs_y_power(self):
        # Un desalineo de un elemento corre TODO el espectro sin excepción.
        freqs, power_db = window_spectrum_db(_sinusoid(5.0, 100.0, 10.0), 100.0)
        assert len(freqs) == len(power_db)

    def test_valor_en_db_contra_la_referencia_a_mano(self):
        # Referencia recalculada acá con LITERALES: Kaiser beta=5 y 20*log10.
        # Si el módulo dejara de compartir la referencia de swarm_spectra
        # (mutaciones #6/#7), los valores divergen y esto se pone rojo.
        signal = _sinusoid(5.0, 100.0, 10.0)
        n = signal.size
        demeaned = signal - signal.mean()
        expected_spec = np.abs(np.fft.rfft(demeaned * np.kaiser(n, 5)))
        expected_freqs = np.fft.rfftfreq(n, 1.0 / 100.0)
        mask = expected_freqs <= 25.0
        expected_db = 20 * np.log10(expected_spec[mask] + 1e-12)

        _, power_db = window_spectrum_db(signal, 100.0)
        np.testing.assert_allclose(power_db, expected_db, rtol=1e-9)

    def test_senal_de_menos_de_dos_muestras_es_error(self):
        with pytest.raises(ValueError):
            window_spectrum_db(np.array([1.0]), 100.0)

    def test_no_se_calcula_sobre_datos_decimados(self):
        # Los pares min/max del waveform NO sirven para una FFT: el espectro de
        # la señal cruda pone el pico en 5 Hz; el de los pares decimados, no.
        fs, f0, seconds = 100.0, 5.0, 60.0
        signal = _sinusoid(f0, fs, seconds)

        freqs_raw, power_raw = window_spectrum_db(signal, fs)
        assert abs(freqs_raw[int(np.argmax(power_raw))] - f0) <= 0.5

        trace = Trace(data=signal, header={"sampling_rate": fs})
        decimated = build_waveform_response(trace, "XX.TEST..BHZ", 100, apply_filter=False)
        pairs = np.ravel(np.column_stack([decimated["mins"], decimated["maxs"]]))
        fs_pairs = len(pairs) / seconds  # tasa efectiva de la serie decimada
        freqs_dec, power_dec = window_spectrum_db(pairs, fs_pairs)
        assert abs(freqs_dec[int(np.argmax(power_dec))] - f0) > 0.5


class TestEffectiveMaxFreqHz:
    def test_canal_lento_manda_nyquist(self):
        # 10.0 es distinto de MAX_FREQ_HZ (25.0) Y de fs (20.0): una
        # implementación que devuelva la constante no puede pasar este test.
        assert effective_max_freq_hz(20.0) == 10.0

    def test_canal_rapido_manda_la_vista_swarm(self):
        assert effective_max_freq_hz(100.0) == 25.0
