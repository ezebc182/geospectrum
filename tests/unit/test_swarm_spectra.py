"""Paridad con el cálculo espectral de SWARM (USGS, CC0).

Referencia: volcano-core gov.usgs.volcanoes.core.data.Spectrogram —
ventana Kaiser beta=5, bin de 2 s redondeado a potencia de 2, overlap
0.859375, dB = 20*log10(|FFT|/1) con la FFT CRUDA (sin normalizar por N).
Un seno de amplitud A en el centro de un bin da un pico de |FFT| ≈
A * sum(ventana) / 2 — de ahí salen los valores esperados.
"""

import numpy as np
import pytest

from src.services.swarm_spectra import (
    KAISER_BETA,
    dominant_frequency_hz,
    frequency_index,
    peak_db,
    swarm_bin_samples,
    swarm_column_db,
    swarm_spectrogram_db,
)


def _sine(freq_hz: float, fs: float, seconds: float, amplitude: float) -> np.ndarray:
    t = np.arange(int(fs * seconds)) / fs
    return amplitude * np.sin(2 * np.pi * freq_hz * t)


def _expected_peak_db(amplitude: float, nbin: int) -> float:
    window_sum = np.kaiser(nbin, KAISER_BETA).sum()
    return float(20 * np.log10(amplitude * window_sum / 2))


def test_bin_es_potencia_de_dos_de_2s():
    # fs=100 -> 200 muestras en 2 s -> siguiente potencia de 2 = 256
    assert swarm_bin_samples(100.0) == 256
    # fs=40 -> 80 muestras -> 128
    assert swarm_bin_samples(40.0) == 128


def test_pico_del_seno_en_su_frecuencia_con_db_de_swarm():
    fs, amp = 100.0, 1000.0
    freqs, power_db = swarm_column_db(_sine(12.5, fs, 8.0, amp), fs)

    peak_freq = freqs[int(np.argmax(power_db))]
    assert peak_freq == pytest.approx(12.5, abs=0.5)
    assert power_db.max() == pytest.approx(
        _expected_peak_db(amp, swarm_bin_samples(fs)), abs=1.0
    )


def test_un_seno_de_22hz_sobrevive_sin_bandpass():
    # El pipeline viejo filtraba 0.1-20 Hz y enmascaraba a 20: un seno de
    # 22 Hz desaparecía. SWARM no filtra y muestra hasta 25 Hz.
    fs, amp = 100.0, 1000.0
    freqs, power_db = swarm_column_db(_sine(22.0, fs, 8.0, amp), fs)

    peak_freq = freqs[int(np.argmax(power_db))]
    assert peak_freq == pytest.approx(22.0, abs=0.5)
    assert power_db.max() > 60  # energía real, no piso residual


def test_banda_se_recorta_a_25hz_o_nyquist():
    fs = 100.0
    freqs, _ = swarm_column_db(_sine(5.0, fs, 8.0, 100.0), fs)
    assert freqs.max() <= 25.0

    fs_low = 40.0  # Nyquist 20 < 25: manda Nyquist
    freqs_low, _ = swarm_column_db(_sine(5.0, fs_low, 16.0, 100.0), fs_low)
    assert freqs_low.max() <= 20.0


def test_espectrograma_completo_es_estable_para_senal_estacionaria():
    fs, amp = 100.0, 1000.0
    freqs, times, power_db = swarm_spectrogram_db(_sine(12.5, fs, 30.0, amp), fs)

    assert power_db.shape == (len(freqs), len(times))
    assert len(times) > 10  # el overlap 0.859375 tiene que rendir columnas densas
    # Todas las columnas de un seno constante ven el mismo pico (±1 dB)
    peaks = power_db.max(axis=0)
    assert peaks.max() - peaks.min() < 1.0
    assert peaks.mean() == pytest.approx(
        _expected_peak_db(amp, swarm_bin_samples(fs)), abs=1.0
    )


def test_senal_corta_no_revienta():
    fs = 100.0
    with pytest.raises(ValueError):
        swarm_column_db(_sine(10.0, fs, 1.0, 100.0), fs)  # < 1 bin


def test_max_columns_limita_sin_cambiar_los_db():
    # Para imágenes de 24h: menos posiciones temporales, misma matemática
    # de bin (los dB de un seno estacionario no cambian al submuestrear).
    fs, amp = 100.0, 1000.0
    data = _sine(12.5, fs, 30.0, amp)
    _, times_full, db_full = swarm_spectrogram_db(data, fs)
    _, times_cap, db_cap = swarm_spectrogram_db(data, fs, max_columns=10)

    assert len(times_cap) <= 10 < len(times_full)
    assert db_cap.max() == pytest.approx(db_full.max(), abs=0.1)


def test_la_deriva_del_instrumento_no_fabrica_un_embudo():
    # Una rampa lineal (drift tipico de instrumento) con un demean GLOBAL
    # deja offsets enormes en los bins de las puntas y ~cero en el centro:
    # eso pintaba un embudo simetrico identico en estaciones distintas.
    # Con demean POR BIN, todas las columnas ven la misma senal residual.
    fs, amp = 100.0, 1000.0
    drift = np.linspace(0, 500_000, int(fs * 60))
    data = drift + _sine(12.5, fs, 60.0, amp)

    freqs, _, power_db = swarm_spectrogram_db(data, fs)

    peaks = power_db.max(axis=0)
    assert peaks.max() - peaks.min() < 1.0  # sin embudo: columnas uniformes
    # El seno sigue visible en su fila con el dB correcto (la deriva mete
    # leakage legitimo en las filas bajas, pero no contamina la de 12.5 Hz).
    sine_row = power_db[int(np.argmin(np.abs(freqs - 12.5)))]
    assert sine_row.mean() == pytest.approx(
        _expected_peak_db(amp, swarm_bin_samples(fs)), abs=1.0
    )


# --- métricas espectrales del PR-W3 ---------------------------------------


def test_dominant_frequency_es_el_bin_de_mayor_potencia():
    freqs = [0.0, 1.0, 2.0, 3.0]
    power = [10.0, 50.0, 90.0, 40.0]
    assert dominant_frequency_hz(freqs, power) == 2.0


def test_dominant_frequency_con_columna_vacia_es_none():
    assert dominant_frequency_hz([], []) is None


def test_peak_db_es_el_maximo_de_la_columna():
    assert peak_db([30.0, 87.3, 45.0]) == 87.3
    assert peak_db([]) is None


def test_fi_positivo_cuando_domina_la_banda_alta():
    # banda baja (1-5) media 40 dB, banda alta (5-15) media 80 dB
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [40.0, 40.0, 80.0, 80.0]
    result = frequency_index(freqs, power)
    assert result is not None
    assert abs(result - np.log10(80.0 / 40.0)) < 1e-9


def test_fi_negativo_cuando_domina_la_banda_baja():
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [80.0, 80.0, 40.0, 40.0]
    result = frequency_index(freqs, power)
    assert result is not None
    assert result < 0


def test_fi_sin_bins_en_la_banda_alta_es_none():
    # fs baja: Nyquist < 5 Hz, no hay banda 5-15
    assert frequency_index([1.0, 2.0, 4.0], [50.0, 50.0, 50.0]) is None


def test_fi_con_media_no_positiva_es_none():
    # dB crudos pueden ser <= 0 con amplitud minúscula; log10 indefinido
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [-5.0, -5.0, 40.0, 40.0]
    assert frequency_index(freqs, power) is None
