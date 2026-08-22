"""El endpoint `/stations/{channel}/waveform` de punta a punta, sin red.

Los tests de `test_station_waveform.py` cubren la lógica pura. Estos cubren lo
que la lógica pura NO puede ver: que la ruta esté registrada, que el SCNL se
parsee, que los códigos de estado sean los correctos y que la respuesta
sobreviva la serialización de FastAPI.

Lección del proyecto: 736 tests verdes y el proceso moría al arrancar. Que las
funciones anden no prueba que el endpoint responda.
"""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace
from unittest.mock import AsyncMock, patch

from src.main import app


@pytest.fixture
def client():
    return TestClient(app)


def _stream(fs=20.0, seconds=3600.0, offset=500.0, amp=100.0):
    """Stream sintético con offset DC, para verificar que el demean lo saca."""
    t = np.arange(int(fs * seconds)) / fs
    data = offset + amp * np.sin(2 * np.pi * 5.0 * t)
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


def test_scnl_mal_formado_da_422(client):
    # Falta el location code: "IU.MAJO.BHZ" son 3 partes, no 4.
    resp = client.get("/stations/IU.MAJO.BHZ/waveform")
    assert resp.status_code == 422
    assert "NET.STA.LOC.CHA" in resp.json()["detail"]


def test_devuelve_waveform_decimado_y_demeaneado(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?minutes=60&points=500")

    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "IU.MAJO..BHZ"
    assert body["sampling_rate"] == 20.0
    assert len(body["mins"]) == len(body["maxs"]) == 500
    # El offset DC de 500 no llega al cliente: la señal sale centrada en 0.
    assert abs(np.mean(body["mins"]) + np.mean(body["maxs"])) < 5.0


def test_sin_datos_fdsn_da_404(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        resp = client.get("/stations/XX.NADA..BHZ/waveform")

    assert resp.status_code == 404
    assert "XX.NADA..BHZ" in resp.json()["detail"]


def test_usa_el_trace_mas_largo_cuando_hay_gaps(client):
    """Un stream partido por gaps trae varios traces: se dibuja el más largo,
    no el primero (que puede ser un fragmento de segundos)."""
    corto = _stream(seconds=10.0)[0]
    largo = _stream(seconds=3600.0)[0]
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=Stream([corto, largo]))
        resp = client.get("/stations/IU.MAJO..BHZ/waveform?points=400")

    assert resp.status_code == 200
    # Con el trace corto (10 s a 20 Hz = 200 muestras) no se llegaría a 400 pares.
    assert len(resp.json()["mins"]) == 400
