"""Tests de swarm_rsam con señales sintéticas (spec station-detail línea 71):
media conocida, eventos fabricados que el detector DEBE contar y subidas
graduales que NO."""

from datetime import datetime, timedelta, timezone

import numpy as np

from src.services.swarm_rsam import (
    EVENT_RATIO,
    EVENT_THRESHOLD,
    RsamAccumulator,
    rsam_sample,
)

T0 = datetime(2026, 8, 21, 12, 0, 0, tzinfo=timezone.utc)


def _fill(acc: RsamAccumulator, values: list[float], step_s: int = 4) -> datetime:
    """Carga una serie con un tick cada step_s segundos; devuelve el now final."""
    now = T0
    for v in values:
        acc.add(v, now)
        now += timedelta(seconds=step_s)
    return now


def test_rsam_sample_es_la_media_del_valor_absoluto_demeaned():
    # señal 10 ± 4 alternante: demean deja ±4, media de |±4| = 4
    data = np.array([14.0, 6.0, 14.0, 6.0])
    assert rsam_sample(data) == 4.0


def test_rsam_sample_con_ventana_vacia_es_cero():
    assert rsam_sample(np.array([])) == 0.0


def test_rsam_promedia_solo_el_periodo_pedido():
    acc = RsamAccumulator()
    # 200 muestras viejas de 100.0 y 150 recientes (600 s a 4 s/tick) de 10.0
    now = _fill(acc, [100.0] * 200 + [10.0] * 150)
    assert acc.rsam(now, period_s=600) == 10.0


def test_rsam_sin_muestras_devuelve_none():
    acc = RsamAccumulator()
    assert acc.rsam(T0) is None


def test_detector_cuenta_un_pico_que_cumple_threshold_y_ratio():
    acc = RsamAccumulator()
    # base 40 (bajo threshold), pico 80: 80 >= 50 y 80 >= 40*1.3
    now = _fill(acc, [40.0, 40.0, 40.0, 80.0, 80.0, 40.0, 40.0])
    assert acc.events_last_hour(now) == 1  # la corrida contigua cuenta UNO


def test_detector_ignora_subida_gradual_que_no_cumple_ratio():
    acc = RsamAccumulator()
    # sube de a 5%: siempre v < v[i-2]*1.3 aunque supere el threshold
    values = [40.0 * (1.05**i) for i in range(20)]
    now = _fill(acc, values)
    assert acc.events_last_hour(now) == 0


def test_detector_ignora_picos_bajo_el_threshold():
    acc = RsamAccumulator()
    # 10 -> 30 cumple ratio (30 >= 13) pero no threshold (30 < 50)
    now = _fill(acc, [10.0, 10.0, 30.0, 30.0, 10.0])
    assert acc.events_last_hour(now) == 0


def test_detector_compara_contra_dos_ticks_atras_no_contra_el_anterior():
    """La referencia del ratio es v[i-2], NO v[i-1] (paridad SWARM countEvents).

    Rampa donde cada paso individual es 1.25x (< ratio 1.3) pero el salto de
    dos ticks es 1.5625x (> 1.3): comparar contra el tick anterior perdería
    el evento. Los tests de pulso cuadrado no distinguen los dos lags porque
    ahí v[i-1] y v[i-2] valen lo mismo (la línea de base).
    """
    acc = RsamAccumulator()
    now = _fill(acc, [40.0, 40.0, 50.0, 62.5, 78.125, 40.0])
    assert acc.events_last_hour(now) == 1


def test_detector_cuenta_dos_eventos_separados():
    acc = RsamAccumulator()
    base, pico = [40.0] * 5, [90.0] * 3
    now = _fill(acc, base + pico + base + pico + base)
    assert acc.events_last_hour(now) == 2


def test_las_muestras_fuera_de_la_hora_expiran():
    acc = RsamAccumulator()
    acc.add(500.0, T0)
    now = T0 + timedelta(seconds=3700)
    acc.add(10.0, now)
    assert acc.rsam(now, period_s=600) == 10.0
    assert acc.events_last_hour(now) == 0
