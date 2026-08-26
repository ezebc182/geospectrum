"""El endpoint `/stations/{channel}/rsam` de punta a punta, sin red.

La fórmula vive en `test_swarm_rsam.py`; acá se verifica la ruta, las
validaciones con sus códigos, los timestamps de la serie (t = CENTRO de cada
ventana, coherente con computeTime() de SWARM) y el cache por ventana.
"""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace, UTCDateTime
from unittest.mock import AsyncMock, patch

from src.main import app

VENTANA = "start=2019-04-18T20:00:00Z&end=2019-04-18T21:00:00Z"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cache_limpio():
    from src.services import cache as _cache

    _cache.clear()
    yield
    _cache.clear()


def _stream(fs=20.0, seconds=3600.0, start="2019-04-18T20:00:00"):
    t = np.arange(int(fs * seconds)) / fs
    data = 500.0 + 100.0 * np.sin(2 * np.pi * 5.0 * t)
    return Stream(
        [
            Trace(
                data=data,
                header={
                    "network": "IU",
                    "station": "MAJO",
                    "channel": "BHZ",
                    "sampling_rate": fs,
                    "starttime": UTCDateTime(start),
                },
            )
        ]
    )


def test_scnl_mal_formado_da_422(client):
    resp = client.get(f"/stations/IU.MAJO.BHZ/rsam?{VENTANA}")
    assert resp.status_code == 422
    assert "NET.STA.LOC.CHA" in resp.json()["detail"]


def test_start_y_end_son_obligatorios(client):
    resp = client.get("/stations/IU.MAJO..BHZ/rsam")
    assert resp.status_code == 422


def test_end_anterior_a_start_da_422(client):
    resp = client.get(
        "/stations/IU.MAJO..BHZ/rsam"
        "?start=2019-04-18T21:00:00Z&end=2019-04-18T20:00:00Z"
    )
    assert resp.status_code == 422
    assert "posterior" in resp.json()["detail"]


def test_ventana_de_mas_de_24_horas_da_422(client):
    resp = client.get(
        "/stations/IU.MAJO..BHZ/rsam"
        "?start=2019-04-18T00:00:00Z&end=2019-04-19T00:00:01Z"
    )
    assert resp.status_code == 422
    assert "24" in resp.json()["detail"]


def test_period_seconds_fuera_de_rango_da_422(client):
    resp = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}&period_seconds=7200")
    assert resp.status_code == 422


def test_sin_datos_fdsn_da_404(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        resp = client.get(f"/stations/XX.NADA..BHZ/rsam?{VENTANA}")

    assert resp.status_code == 404
    assert "XX.NADA..BHZ" in resp.json()["detail"]


def test_la_serie_cubre_la_ventana_con_t_en_el_centro(client):
    # 1 h a 20 Hz con period=600 ⇒ 6 ventanas completas. El primer t es el
    # CENTRO de la primera (start + 300 s): el borde izquierdo desalinearía el
    # gráfico RSAM del espectrograma por medio período.
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "IU.MAJO..BHZ"
    assert body["sampling_rate"] == 20.0
    assert body["period_seconds"] == 600
    assert len(body["samples"]) == 6
    assert body["samples"][0]["t"].startswith("2019-04-18T20:05:00")

    tiempos = [s["t"] for s in body["samples"]]
    assert tiempos == sorted(set(tiempos))  # estrictamente crecientes
    assert tiempos[0] >= "2019-04-18T20:00:00"
    assert tiempos[-1] <= "2019-04-18T21:00:00"


def test_period_custom_cambia_la_cantidad_de_muestras(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}&period_seconds=1800")

    assert resp.status_code == 200
    assert len(resp.json()["samples"]) == 2


def test_dos_ventanas_distintas_no_colisionan_en_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")
        client.get(
            "/stations/IU.MAJO..BHZ/rsam"
            "?start=2020-01-01T00:00:00Z&end=2020-01-01T01:00:00Z"
        )

    assert gs.return_value.get_waveform_data.await_count == 2


def test_dos_periodos_distintos_no_colisionan_en_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}&period_seconds=300")

    assert gs.return_value.get_waveform_data.await_count == 2


def test_la_misma_ventana_se_sirve_del_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")

    assert gs.return_value.get_waveform_data.await_count == 1


def test_sin_datos_fdsn_no_se_cachea_el_vacio(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        primera = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")
        segunda = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}")

    assert primera.status_code == segunda.status_code == 404
    assert gs.return_value.get_waveform_data.await_count == 2
