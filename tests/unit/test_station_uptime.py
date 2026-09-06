"""Tests de `build_uptime_series` (pura) sobre filas del rollup `station_uptime_hourly`.

Regla [R12] del design: `null` ≠ `0`. Una hora es OBSERVADA si algún canal
tiene fila; un canal presente sin fila en una hora observada vale `0.0`
(mudo); una hora sin fila de nadie vale `None` (nadie miró); un canal pedido
sin ninguna fila en la ventana es `None` en todo, incluido `overall`.
"""

from datetime import datetime, timedelta, timezone

import pytest

from src.services.seedlink_ingestor import COLUMN_INTERVAL_SECONDS
from src.services.station_uptime import EXPECTED_COLUMNS_PER_HOUR, build_uptime_series

H = datetime(2026, 9, 4, 10, 0, tzinfo=timezone.utc)
HOUR = timedelta(hours=1)
KBU = "GE.KBU..BHZ"
MAJO = "IU.MAJO.00.BHZ"
FULL = EXPECTED_COLUMNS_PER_HOUR
NOW = H + timedelta(hours=1, minutes=30)  # dentro de la segunda hora


def test_la_constante_deriva_del_import() -> None:
    assert EXPECTED_COLUMNS_PER_HOUR == 3600 // COLUMN_INTERVAL_SECONDS


def test_canal_siempre_activo_da_1_en_todos_los_buckets() -> None:
    rows = [(KBU, H, FULL), (KBU, H + HOUR, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", [KBU], NOW)

    buckets = result.stations[KBU]
    assert len(buckets) == 2
    assert [b.bucket_start for b in buckets] == [H, H + HOUR]
    assert [b.ratio for b in buckets] == [1.0, 1.0]
    assert [b.expected for b in buckets] == [FULL, FULL]
    assert [b.columns_count for b in buckets] == [FULL, FULL]
    assert [b.observed_hours for b in buckets] == [1, 1]
    assert result.overall[KBU] == 1.0
    assert result.expected_columns_per_hour == FULL
    assert result.bucket == "hour"
    assert (result.window_start, result.window_end) == (H, H + 2 * HOUR)


def test_media_hora_da_0_5_y_el_exceso_se_clampea() -> None:
    rows = [(KBU, H, FULL // 2), (KBU, H + HOUR, FULL + 50)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", [KBU], NOW)

    assert [b.ratio for b in result.stations[KBU]] == [0.5, 1.0]
    assert result.overall[KBU] == pytest.approx((FULL // 2 + FULL + 50) / (2 * FULL))


def test_hora_sin_filas_de_ningun_canal_es_none_no_cero() -> None:
    rows = [(KBU, H, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", [KBU], NOW)

    first, second = result.stations[KBU]
    assert first.ratio == 1.0
    assert second.ratio is None
    assert second.observed_hours == 0
    assert second.expected == 0
    # Sobre la ventana: 1 hora observada, completa.
    assert result.overall[KBU] == 1.0


def test_canal_mudo_en_hora_observada_vale_cero() -> None:
    rows = [(MAJO, H, FULL), (MAJO, H + HOUR, FULL), (KBU, H, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", [KBU, MAJO], NOW)

    kbu_second = result.stations[KBU][1]
    assert kbu_second.ratio == 0.0
    assert kbu_second.ratio is not None
    assert kbu_second.columns_count == 0
    assert kbu_second.observed_hours == 1
    assert result.overall[KBU] == 0.5
    assert result.overall[MAJO] == 1.0


def test_canal_pedido_sin_filas_queda_en_none() -> None:
    rows = [(MAJO, H, FULL), (MAJO, H + HOUR, FULL), (KBU, H, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", ["XX.NOPE..BHZ"], NOW)

    assert list(result.stations) == ["XX.NOPE..BHZ"]
    buckets = result.stations["XX.NOPE..BHZ"]
    assert len(buckets) == 2
    assert all(b.ratio is None for b in buckets)
    # Las horas SÍ fueron observadas (por otros canales): eso se informa igual.
    assert [b.observed_hours for b in buckets] == [1, 1]
    assert result.overall["XX.NOPE..BHZ"] is None


def test_un_dia_con_18_horas_observadas_se_mide_sobre_18() -> None:
    day = datetime(2026, 9, 3, 0, 0, tzinfo=timezone.utc)
    rows = [(KBU, day + i * HOUR, FULL) for i in range(18)]
    now = day + timedelta(days=3)
    result = build_uptime_series(rows, day, day + timedelta(days=1), "day", [KBU], now)

    (bucket,) = result.stations[KBU]
    assert bucket.bucket_start == day
    assert bucket.observed_hours == 18
    assert bucket.expected == FULL * 18
    assert bucket.columns_count == FULL * 18
    assert bucket.ratio == 1.0
    assert bucket.in_progress is False
    assert result.overall[KBU] == 1.0


def test_bucket_day_con_dia_sin_horas_observadas_es_none() -> None:
    day = datetime(2026, 9, 3, 0, 0, tzinfo=timezone.utc)
    rows = [(KBU, day + i * HOUR, FULL // 2) for i in range(24)]
    now = day + timedelta(days=5)
    result = build_uptime_series(rows, day, day + timedelta(days=2), "day", [KBU], now)

    first, second = result.stations[KBU]
    assert (first.ratio, first.observed_hours) == (0.5, 24)
    assert (second.ratio, second.observed_hours, second.expected) == (None, 0, 0)
    assert result.overall[KBU] == 0.5


def test_ventana_de_dos_horas_produce_exactamente_dos_buckets() -> None:
    rows = [(KBU, H + HOUR, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", None, NOW)

    assert [b.bucket_start for b in result.stations[KBU]] == [H, H + HOUR]


def test_los_buckets_se_alinean_al_date_trunc_del_inicio() -> None:
    start = H + timedelta(minutes=17)
    rows = [(KBU, H, FULL), (KBU, H + HOUR, FULL)]
    result = build_uptime_series(rows, start, start + 2 * HOUR, "hour", [KBU], NOW)

    assert [b.bucket_start for b in result.stations[KBU]] == [H, H + HOUR, H + 2 * HOUR]


def test_in_progress_solo_en_el_bucket_que_contiene_now() -> None:
    rows = [(KBU, H, FULL), (KBU, H + HOUR, FULL), (KBU, H + 2 * HOUR, 300)]
    now = H + 2 * HOUR + timedelta(minutes=20)
    result = build_uptime_series(rows, H, H + 3 * HOUR, "hour", [KBU], now)

    assert [b.in_progress for b in result.stations[KBU]] == [False, False, True]


def test_channels_none_toma_los_canales_presentes_en_rows() -> None:
    rows = [(MAJO, H, FULL), (KBU, H, FULL)]
    result = build_uptime_series(rows, H, H + HOUR, "hour", None, NOW)

    assert sorted(result.stations) == sorted([KBU, MAJO])
    assert sorted(result.overall) == sorted([KBU, MAJO])


def test_filas_fuera_de_la_ventana_se_ignoran() -> None:
    rows = [(KBU, H - HOUR, FULL), (KBU, H, FULL), (KBU, H + 2 * HOUR, FULL)]
    result = build_uptime_series(rows, H, H + 2 * HOUR, "hour", [KBU], NOW)

    first, second = result.stations[KBU]
    assert first.ratio == 1.0
    assert second.ratio is None
