"""Tests del clasificador de episodios de tremor (capa 1, pura sobre la serie RSAM).

Los valores esperados se derivan de la DEFINICIÓN en el propio test (la línea
base es la mediana de las muestras no nulas; el umbral es mediana × factor),
no se copian de la spec. Las constantes se comparan contra
`dashboard/lib/seismic-constants.json` leído acá.
"""

import json
import statistics
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

from src.services.swarm_rsam import RSAM_PERIOD_SECONDS, rsam_series
from src.services.tremor import (
    BASELINE_FACTOR,
    LOW_BAND_MAX_HZ,
    MID_BAND_MAX_HZ,
    MIN_DURATION_PERIODS,
    characterize,
    classify_episodes,
)

_CONSTANTS_PATH = (
    Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
)

T0 = datetime(2026, 9, 5, 0, 0, tzinfo=timezone.utc)
PERIOD_S = 600
BASE = 40.0


def series(values: list[float | None]) -> list[tuple[datetime, float | None]]:
    return [(T0 + timedelta(seconds=i * PERIOD_S), v) for i, v in enumerate(values)]


def plateau_values(gap_at: int | None = None) -> list[float | None]:
    """100 × 40.0 salvo las muestras 20..39 a 40·factor·2 (opcionalmente un None)."""
    values: list[float | None] = [BASE] * 100
    for i in range(20, 40):
        values[i] = BASE * BASELINE_FACTOR * 2
    if gap_at is not None:
        values[gap_at] = None
    return values


def expected_baseline(values: list[float | None]) -> float:
    return float(statistics.median([v for v in values if v is not None]))


class TestConstantsFromSharedJson:
    def test_las_constantes_salen_del_json_compartido(self) -> None:
        constants = json.loads(_CONSTANTS_PATH.read_text(encoding="utf-8"))
        assert BASELINE_FACTOR == constants["tremorBaselineFactor"]
        assert MIN_DURATION_PERIODS == constants["tremorMinDurationPeriods"]
        assert LOW_BAND_MAX_HZ == constants["tremorLowBandMaxHz"]
        assert MID_BAND_MAX_HZ == constants["tremorMidBandMaxHz"]

    def test_cotas_de_la_spec(self) -> None:
        # Con 1 período el clasificador sería un duplicado del contador de eventos.
        assert MIN_DURATION_PERIODS >= 3
        assert BASELINE_FACTOR > 1


class TestClassifyEpisodes:
    def test_serie_constante_no_tiene_tremor(self) -> None:
        values: list[float | None] = [BASE] * 100
        result = classify_episodes(series(values))

        assert result.episodes == []
        assert result.tremor_fraction == 0.0
        assert result.baseline_rsam == expected_baseline(values) == BASE
        assert result.threshold_rsam == BASE * BASELINE_FACTOR

    def test_un_pico_aislado_no_es_tremor(self) -> None:
        values: list[float | None] = [BASE] * 100
        values[50] = BASE * BASELINE_FACTOR * 10
        result = classify_episodes(series(values))

        assert result.episodes == []
        assert result.tremor_fraction == 0.0

    def test_una_meseta_sostenida_es_un_episodio_con_bordes_exactos(self) -> None:
        values = plateau_values()
        s = series(values)
        result = classify_episodes(s)

        baseline = expected_baseline(values)
        assert result.baseline_rsam == baseline
        assert len(result.episodes) == 1
        episode = result.episodes[0]
        assert episode.start == s[20][0]
        assert episode.end == s[39][0]
        assert episode.samples == 20
        assert episode.mean_ratio == pytest.approx(2 * BASELINE_FACTOR, abs=1e-9)
        assert episode.peak_rsam == BASE * BASELINE_FACTOR * 2
        assert episode.peak_ratio == pytest.approx(2 * BASELINE_FACTOR, abs=1e-9)
        assert episode.onset_ratio == pytest.approx(1.0, abs=1e-9)
        assert result.tremor_fraction == pytest.approx(0.20, abs=1e-9)

    def test_un_hueco_parte_el_episodio_en_dos(self) -> None:
        s = series(plateau_values(gap_at=30))
        result = classify_episodes(s)

        assert len(result.episodes) == 2
        first, second = result.episodes
        assert (first.start, first.end, first.samples) == (s[20][0], s[29][0], 10)
        assert (second.start, second.end, second.samples) == (s[31][0], s[39][0], 9)
        # 99 muestras no nulas: el None NO cuenta en el denominador (19/100 = 0.19 falla).
        assert result.tremor_fraction == pytest.approx(19 / 99, abs=0.001)

    def test_serie_vacia_o_toda_none_devuelve_sin_datos(self) -> None:
        for s in ([], series([None] * 10)):
            result = classify_episodes(s)
            assert result.episodes == []
            assert result.baseline_rsam is None
            assert result.threshold_rsam is None
            assert result.tremor_fraction == 0.0

    def test_serie_toda_en_cero_no_es_tremor(self) -> None:
        # Un canal muerto (baseline 0) no puede ser "100 % tremor" ni dividir por cero.
        result = classify_episodes(series([0.0] * 20))
        assert result.episodes == []
        assert result.baseline_rsam == 0.0
        assert result.tremor_fraction == 0.0

    def test_corrida_justo_en_el_minimo_cuenta_y_una_menos_no(self) -> None:
        exact: list[float | None] = [BASE] * 50
        for i in range(10, 10 + MIN_DURATION_PERIODS):
            exact[i] = BASE * BASELINE_FACTOR
        assert len(classify_episodes(series(exact)).episodes) == 1

        short: list[float | None] = [BASE] * 50
        for i in range(10, 10 + MIN_DURATION_PERIODS - 1):
            short[i] = BASE * BASELINE_FACTOR
        assert classify_episodes(series(short)).episodes == []

    def test_parameters_expone_las_constantes_usadas(self) -> None:
        result = classify_episodes(series([BASE] * 5))
        assert result.parameters == {
            "baseline_factor": BASELINE_FACTOR,
            "min_duration_periods": MIN_DURATION_PERIODS,
        }


# --- Capa 2: characterize(signal, fs, start) ---------------------------------

FS = 20.0
HOURS = 4
N_SAMPLES = int(HOURS * 3600 * FS)  # 288 000
PER_WINDOW = int(RSAM_PERIOD_SECONDS * FS)  # 12 000
N_WINDOWS = N_SAMPLES // PER_WINDOW  # 24
FIRST_ELEVATED = 10


def synthetic_signal(
    tone_amplitudes: list[float],
    tone_hz: float,
    noise_multiplier: float = 3.0,
    seed: int = 7,
) -> np.ndarray:
    """Ruido uniforme de amplitud 1 durante 4 h; a partir de la ventana
    `FIRST_ELEVATED`, `len(tone_amplitudes)` períodos de 600 s (alineados a
    los cortes de RSAM) con ruido × `noise_multiplier` más un tono a `tone_hz`."""
    rng = np.random.default_rng(seed)
    noise = rng.uniform(-1.0, 1.0, N_SAMPLES)
    signal = noise.copy()
    t = np.arange(PER_WINDOW) / FS
    for k, amplitude in enumerate(tone_amplitudes):
        window = slice((FIRST_ELEVATED + k) * PER_WINDOW, (FIRST_ELEVATED + k + 1) * PER_WINDOW)
        signal[window] = noise_multiplier * noise[window] + amplitude * np.sin(
            2 * np.pi * tone_hz * t
        )
    return signal


class TestCharacterize:
    def test_cuarenta_minutos_elevados_son_un_episodio_de_banda_baja(self) -> None:
        signal = synthetic_signal([3.0] * 4, tone_hz=1.5)
        result = characterize(signal, FS, T0)

        assert result.period_seconds == RSAM_PERIOD_SECONDS
        assert result.sampling_rate == FS
        assert len(result.episodes) == 1
        episode = result.episodes[0]
        assert episode.samples == 4
        assert episode.duration_s == 2400
        assert episode.band == "low"
        assert episode.mean_dominant_hz == pytest.approx(1.5, abs=1e-9)
        assert episode.start == T0 + timedelta(seconds=(FIRST_ELEVATED + 0.5) * PERIOD_S)
        assert episode.end == T0 + timedelta(seconds=(FIRST_ELEVATED + 3.5) * PERIOD_S)
        assert result.tremor_fraction == pytest.approx(4 / N_WINDOWS)
        assert result.parameters == {
            "baseline_factor": BASELINE_FACTOR,
            "min_duration_periods": MIN_DURATION_PERIODS,
        }

    def test_veinte_minutos_no_alcanzan(self) -> None:
        signal = synthetic_signal([3.0] * 2, tone_hz=1.5)
        result = characterize(signal, FS, T0)
        assert result.episodes == []
        assert result.tremor_fraction == 0.0

    def test_tono_a_8_hz_es_banda_alta_y_a_3_5_hz_media(self) -> None:
        high = characterize(synthetic_signal([3.0] * 4, tone_hz=8.0), FS, T0)
        assert [ep.band for ep in high.episodes] == ["high"]
        assert high.episodes[0].mean_dominant_hz == pytest.approx(8.0, abs=1e-9)

        mid = characterize(synthetic_signal([3.0] * 4, tone_hz=3.5), FS, T0)
        assert [ep.band for ep in mid.episodes] == ["mid"]

    def test_la_rampa_tiene_onset_ratio_menor_que_el_escalon(self) -> None:
        step = characterize(synthetic_signal([3.0] * 4, tone_hz=1.5), FS, T0)
        ramp = characterize(synthetic_signal([1.0, 2.0, 3.0, 4.0], tone_hz=1.5), FS, T0)

        assert len(step.episodes) == len(ramp.episodes) == 1
        assert ramp.episodes[0].onset_ratio < step.episodes[0].onset_ratio
        assert step.episodes[0].onset_ratio > 0.9
        assert ramp.episodes[0].onset_ratio < 0.8

    def test_las_muestras_son_la_misma_serie_rsam_con_t_en_el_centro(self) -> None:
        signal = synthetic_signal([3.0] * 4, tone_hz=1.5)
        result = characterize(signal, FS, T0)
        expected = rsam_series(signal, FS)

        assert len(result.samples) == N_WINDOWS == len(expected)
        for i, sample in enumerate(result.samples):
            assert sample["rsam"] == expected[i]
            assert sample["t"] == T0 + timedelta(seconds=(i + 0.5) * RSAM_PERIOD_SECONDS)
        assert result.samples[FIRST_ELEVATED]["dominant_hz"] == pytest.approx(1.5, abs=1e-9)

    def test_traza_mas_corta_que_un_periodo_devuelve_sin_datos(self) -> None:
        result = characterize(np.zeros(100), FS, T0)
        assert result.samples == []
        assert result.episodes == []
        assert result.baseline_rsam is None
        assert result.tremor_fraction == 0.0
