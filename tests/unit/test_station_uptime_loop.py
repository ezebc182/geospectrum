"""Loop del rollup de uptime: aislamiento por ciclo y parada limpia.

Molde: `tests/unit/test_disk_alert.py`. El contrato crítico es el mismo que
el de la alerta de disco: el loop corre como `create_task` DENTRO del
lifespan del `api`, así que un ciclo que lanza (Postgres caído, tabla
ausente) NO puede propagar — tumbaría el servicio entero — ni matar el
loop para siempre: el próximo ciclo debe reintentar solo.

Acá no hay Postgres: `rollup_once` se parchea. Lo que se prueba es el
loop, no el SQL (ese va contra base real en
`tests/integration/test_station_uptime_rollup.py`).
"""

import asyncio
import logging
import time
from unittest.mock import patch

from src.services import station_uptime
from src.services.seedlink_ingestor import COLUMN_INTERVAL_SECONDS

# Sin `pytestmark = pytest.mark.asyncio`: asyncio_mode=auto ya detecta las
# corrutinas, y la marca global le pegaría a un test síncrono (warning).

_LOGGER_NAME = "src.services.station_uptime"


def test_expected_columns_per_hour_se_deriva_del_ingestor():
    """Contra el import, NO contra `900`: si la cadencia del ingestor cambia,
    el denominador del uptime tiene que cambiar con ella."""
    assert station_uptime.EXPECTED_COLUMNS_PER_HOUR == 3600 // COLUMN_INTERVAL_SECONDS


async def test_un_ciclo_fallido_no_mata_el_loop_ni_propaga(caplog):
    """Dos ciclos: el primero explota, el segundo debe correr y escribir."""
    stop_event = asyncio.Event()
    calls: list[object] = []

    async def _fake_rollup(pool):
        calls.append(pool)
        if len(calls) == 1:
            raise RuntimeError("base caída un instante")
        stop_event.set()
        return 3

    pool_sentinel = object()
    with (
        patch("src.services.station_uptime.rollup_once", new=_fake_rollup),
        caplog.at_level(logging.WARNING, logger=_LOGGER_NAME),
    ):
        started = time.monotonic()
        # Si la excepción del primer ciclo se propagara, esta línea lanzaría.
        await station_uptime.run_uptime_rollup_loop(
            pool_sentinel, interval_seconds=0.01, stop_event=stop_event
        )
        elapsed = time.monotonic() - started

    assert calls == [pool_sentinel, pool_sentinel]
    assert elapsed < 1.0

    warnings = [
        r
        for r in caplog.records
        if r.name == _LOGGER_NAME and r.levelno == logging.WARNING and "rollup" in r.getMessage()
    ]
    assert len(warnings) == 1
    # El warning lleva la causa real (exc_info=True), no un mensaje mudo.
    assert warnings[0].exc_info is not None
    assert isinstance(warnings[0].exc_info[1], RuntimeError)
    assert str(warnings[0].exc_info[1]) == "base caída un instante"


async def test_el_stop_corta_la_espera_sin_esperar_el_intervalo():
    """El intervalo es de 10 min en prod: el shutdown del deploy no puede
    esperar a que venza. `wait_for(stop_event.wait())` en vez de un sleep."""
    stop_event = asyncio.Event()
    calls: list[int] = []

    async def _fake_rollup(pool):
        calls.append(1)
        return 0

    async def _stop_soon():
        await asyncio.sleep(0.05)
        stop_event.set()

    with patch("src.services.station_uptime.rollup_once", new=_fake_rollup):
        started = time.monotonic()
        await asyncio.gather(
            station_uptime.run_uptime_rollup_loop(
                None, interval_seconds=600, stop_event=stop_event
            ),
            _stop_soon(),
        )
        elapsed = time.monotonic() - started

    assert calls == [1]
    assert elapsed < 1.0


async def test_con_el_stop_ya_seteado_no_corre_ni_un_ciclo():
    stop_event = asyncio.Event()
    stop_event.set()
    calls: list[int] = []

    async def _fake_rollup(pool):
        calls.append(1)
        return 0

    with patch("src.services.station_uptime.rollup_once", new=_fake_rollup):
        await station_uptime.run_uptime_rollup_loop(
            None, interval_seconds=0.01, stop_event=stop_event
        )

    assert calls == []
