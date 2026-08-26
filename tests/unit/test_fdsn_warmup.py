"""Warm-up de FDSN: precalienta el helicorder de 24 h de los canales vivos.

El contrato crítico es la PARIDAD DE KEYS: el warm-up tiene que poblar
exactamente la key que el endpoint va a mirar cuando el frontend pida
`?minutes=1440&points={variante}&filter=none`. Por eso el test de oro no
inspecciona strings: pasa por el endpoint REAL y verifica que FDSN no se toque.
"""

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace

from src.main import app
from src.services import cache
from src.services.fdsn_warmup import WARMUP_POINTS_VARIANTS, warmup_sweep

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _cache_limpio():
    cache.clear()
    yield
    cache.clear()


def _stream(fs=20.0, seconds=3600.0):
    t = np.arange(int(fs * seconds)) / fs
    data = 100.0 * np.sin(2 * np.pi * 5.0 * t)
    return Stream(
        [
            Trace(
                data=data,
                header={
                    "network": "IU",
                    "station": "MAJO",
                    "channel": "BHZ",
                    "sampling_rate": fs,
                },
            )
        ]
    )


class _FakeService:
    def __init__(self, streams):
        """`streams` mapea channel SCNL → Stream | None | Exception."""
        self.streams = streams
        self.calls = []

    async def get_waveform_data(self, **kwargs):
        self.calls.append(kwargs)
        key = f"{kwargs['network']}.{kwargs['station']}"
        value = self.streams[key]
        if isinstance(value, Exception):
            raise value
        return value


async def test_las_variantes_salen_del_json_compartido():
    """El backend NO inventa sus points: los lee de seismic-constants.json,
    la misma fuente que el frontend verifica por consumo en
    helicorder-layout.test.ts. Si divergen, alguna variante queda fría."""
    constants = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "dashboard"
            / "lib"
            / "seismic-constants.json"
        ).read_text()
    )
    assert sorted(WARMUP_POINTS_VARIANTS) == sorted(constants["helicorderPointsVariants"])


async def test_precalienta_todas_las_variantes_de_un_canal():
    service = _FakeService({"IU.MAJO": _stream()})
    warmed = await warmup_sweep(service, ["IU.MAJO.00.BHZ"], ttl_seconds=1200)

    assert warmed == 1
    # UN solo fetch por canal: las variantes se computan del mismo stream.
    assert len(service.calls) == 1
    assert service.calls[0]["duration_hours"] == 24
    for points in WARMUP_POINTS_VARIANTS:
        key = f"waveform:IU.MAJO.00.BHZ:m1440:{points}:none"
        assert cache.get(key) is not None, f"variante fría: {points}"


async def test_paridad_de_key_con_el_endpoint_real():
    """El test de oro: después del sweep, el pedido EXACTO del frontend
    (HelicorderCanvas: minutes=1440, points de waveformPoints, filter=none)
    se sirve del cache y FDSN no se toca. Si la key difiere en UN carácter,
    este test llama al mock y falla."""
    service = _FakeService({"IU.MAJO": _stream()})
    await warmup_sweep(service, ["IU.MAJO.00.BHZ"], ttl_seconds=1200)

    client = TestClient(app)
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        for points in WARMUP_POINTS_VARIANTS:
            resp = client.get(
                f"/stations/IU.MAJO.00.BHZ/waveform"
                f"?minutes=1440&points={points}&filter=none"
            )
            assert resp.status_code == 200
    gs.return_value.get_waveform_data.assert_not_awaited()


async def test_canal_sin_datos_no_cachea_nada():
    service = _FakeService({"XX.NADA": None})
    warmed = await warmup_sweep(service, ["XX.NADA..BHZ"], ttl_seconds=1200)

    assert warmed == 0
    for points in WARMUP_POINTS_VARIANTS:
        assert cache.get(f"waveform:XX.NADA..BHZ:m1440:{points}:none") is None


async def test_un_canal_roto_no_frena_el_barrido():
    service = _FakeService(
        {"XX.ROTO": ConnectionError("timeout FDSN"), "IU.MAJO": _stream()}
    )
    warmed = await warmup_sweep(
        service, ["XX.ROTO..BHZ", "IU.MAJO.00.BHZ"], ttl_seconds=1200
    )

    assert warmed == 1
    assert cache.get("waveform:IU.MAJO.00.BHZ:m1440:38400:none") is not None


async def test_location_vacio_se_pide_como_wildcard():
    """Mismo contrato que el endpoint: `loc or "*"`. Sin esto, un SCNL con
    location vacío pediría location="" y FDSN devolvería vacío."""
    service = _FakeService({"IU.MAJO": _stream()})
    await warmup_sweep(service, ["IU.MAJO..BHZ"], ttl_seconds=1200)

    assert service.calls[0]["location"] == "*"


async def test_scnl_malformado_se_saltea_sin_romper():
    service = _FakeService({"IU.MAJO": _stream()})
    warmed = await warmup_sweep(
        service, ["MALFORMADO", "IU.MAJO.00.BHZ"], ttl_seconds=1200
    )
    assert warmed == 1


# =============================================================================
# El loop: barre, duerme, se frena con el stop_event
# =============================================================================


async def test_el_loop_barre_hasta_que_el_stop_event_se_setea():
    from src.services.fdsn_warmup import run_warmup_loop

    service = _FakeService({"IU.MAJO": _stream()})
    stop = asyncio.Event()
    calls = []

    async def get_channels():
        calls.append(1)
        if len(calls) >= 2:
            stop.set()
        return ["IU.MAJO.00.BHZ"]

    await asyncio.wait_for(
        run_warmup_loop(
            service, get_channels, interval_seconds=0.01, ttl_seconds=1200, stop_event=stop
        ),
        timeout=5,
    )

    assert len(calls) >= 2
    assert cache.get("waveform:IU.MAJO.00.BHZ:m1440:38400:none") is not None


async def test_un_barrido_que_explota_no_mata_el_loop():
    """FDSN caído un rato no puede dejar el warm-up muerto para siempre —
    la lección del ingestor que salía con exit 0: el loop atrapa y sigue."""
    from src.services.fdsn_warmup import run_warmup_loop

    service = _FakeService({"IU.MAJO": _stream()})
    stop = asyncio.Event()
    calls = []

    async def get_channels():
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionError("la base se cayó justo ahora")
        stop.set()
        return ["IU.MAJO.00.BHZ"]

    await asyncio.wait_for(
        run_warmup_loop(
            service, get_channels, interval_seconds=0.01, ttl_seconds=1200, stop_event=stop
        ),
        timeout=5,
    )

    assert len(calls) == 2
    assert cache.get("waveform:IU.MAJO.00.BHZ:m1440:38400:none") is not None


# =============================================================================
# _warmup_channels: las ganadoras por ciudad, con la frescura de la base
# =============================================================================


async def test_warmup_channels_elige_la_candidata_viva_de_cada_ciudad():
    from src.main import _warmup_channels

    class _FakeWriter:
        async def fetch_active_channels(self, minutes):
            # Solo la SEGUNDA candidata de Seattle está fresca: la ganadora
            # debe ser esa, no la primaria muda.
            return {"UW.SP2..HHZ"}

    with patch("src.main.column_writer", _FakeWriter()):
        channels = await _warmup_channels()

    assert "UW.SP2..HHZ" in channels
    assert "UW.LON..HHZ" not in channels
    # Un set real ("nada fresco salvo Seattle") excluye a las demás ciudades.
    assert channels == ["UW.SP2..HHZ"]


async def test_warmup_channels_sin_base_usa_las_primarias():
    """Sin base (column_writer None) se precalientan las primarias: mejor
    calentar de más que dejar todo frío — misma semántica que /live-channels."""
    from src.main import _warmup_channels

    with patch("src.main.column_writer", None):
        channels = await _warmup_channels()

    assert "UW.LON..HHZ" in channels
    assert len(channels) > 20


async def test_warmup_channels_con_set_vacio_usa_las_primarias():
    """Un set vacío casi siempre significa "el ingestor está caído", no "el
    planeta dejó de temblar". FDSN es una fuente INDEPENDIENTE del ingestor:
    con el ingestor muerto los usuarios siguen abriendo estaciones, así que
    el warm-up trata el vacío como "sin información" y calienta las
    primarias. (La UI hace lo contrario a propósito: un badge que miente es
    peor que un badge gris. Acá no hay badge, hay cache.)"""
    from src.main import _warmup_channels

    class _FakeWriter:
        async def fetch_active_channels(self, minutes):
            return set()

    with patch("src.main.column_writer", _FakeWriter()):
        channels = await _warmup_channels()

    assert "UW.LON..HHZ" in channels
    assert len(channels) > 20
