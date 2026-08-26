"""El endpoint `/stations/{channel}/spectra` de punta a punta, sin red.

La lógica pura vive en `test_signal_spectrum.py`; acá se verifica lo que ella
no puede ver: la ruta registrada, las validaciones con sus códigos, el eje
declarado por la respuesta y que el cache distinga ventanas.
"""

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace
from unittest.mock import AsyncMock, patch

from src.main import app

VENTANA = "start=2019-04-18T20:00:00Z&end=2019-04-18T20:10:00Z"


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cache_limpio():
    # Mismo motivo que en el endpoint de waveform: el TTL por defecto es 900 s
    # y sin limpiar, un test se sirve del mock del anterior.
    from src.services import cache as _cache

    _cache.clear()
    yield
    _cache.clear()


def _stream(fs=20.0, seconds=600.0, f0=5.0):
    t = np.arange(int(fs * seconds)) / fs
    data = 500.0 + 100.0 * np.sin(2 * np.pi * f0 * t)
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
    resp = client.get(f"/stations/IU.MAJO.BHZ/spectra?{VENTANA}")
    assert resp.status_code == 422
    assert "NET.STA.LOC.CHA" in resp.json()["detail"]


def test_start_y_end_son_obligatorios(client):
    # Un espectro "de las últimas 24 h" no tiene sentido físico: sin ventana
    # explícita el endpoint no debe ni intentar calcular.
    resp = client.get("/stations/IU.MAJO..BHZ/spectra")
    assert resp.status_code == 422


def test_end_anterior_a_start_da_422(client):
    resp = client.get(
        "/stations/IU.MAJO..BHZ/spectra"
        "?start=2019-04-18T20:10:00Z&end=2019-04-18T20:00:00Z"
    )
    assert resp.status_code == 422
    assert "posterior" in resp.json()["detail"]


def test_ventana_de_mas_de_una_hora_da_422(client):
    # El techo de 1 h protege la RAM: la FFT es sobre la señal SIN decimar.
    resp = client.get(
        "/stations/IU.MAJO..BHZ/spectra"
        "?start=2019-04-18T20:00:00Z&end=2019-04-18T21:00:01Z"
    )
    assert resp.status_code == 422
    assert "1 hora" in resp.json()["detail"]


def test_sin_datos_fdsn_da_404(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        resp = client.get(f"/stations/XX.NADA..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 404
    assert "XX.NADA..BHZ" in resp.json()["detail"]


def test_ventana_demasiado_corta_da_422(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(
            return_value=Stream(
                [Trace(data=np.array([1.0]), header={"sampling_rate": 20.0})]
            )
        )
        resp = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 422
    assert "corta" in resp.json()["detail"]


def test_respuesta_declara_el_eje_y_el_pico_cae_donde_debe(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream(fs=40.0))
        resp = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "IU.MAJO..BHZ"
    assert body["sampling_rate"] == 40.0
    # Con fs=40, Nyquist es 20.0: distinto de MAX_FREQ_HZ (25) y de fs (40).
    assert body["max_freq_hz"] == 20.0
    assert len(body["freqs"]) == len(body["power_db"]) > 0
    assert body["npts"] == int(40.0 * 600.0)
    pico = body["freqs"][int(np.argmax(body["power_db"]))]
    assert abs(pico - 5.0) <= 0.5


def test_dos_canales_dos_ejes_distintos(client):
    """La mutación #8 (`MAX_FREQ_HZ 25 → 50`) debe poner ESTE test en rojo:
    con el techo en 50, el canal de fs=100 declararía 50.0 y no 25.0."""
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream(fs=20.0))
        lento = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}").json()
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream(fs=100.0))
        rapido = client.get(f"/stations/IU.USC..BHZ/spectra?{VENTANA}").json()

    assert lento["max_freq_hz"] == 10.0
    assert rapido["max_freq_hz"] == 25.0
    assert lento["max_freq_hz"] != rapido["max_freq_hz"]


def test_dos_ventanas_distintas_no_colisionan_en_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")
        client.get(
            "/stations/IU.MAJO..BHZ/spectra"
            "?start=2020-01-01T00:00:00Z&end=2020-01-01T00:10:00Z"
        )

    assert gs.return_value.get_waveform_data.await_count == 2


def test_la_misma_ventana_se_sirve_del_cache(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream())
        client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")
        client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert gs.return_value.get_waveform_data.await_count == 1


def test_sin_datos_fdsn_no_se_cachea_el_vacio(client):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        primera = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")
        segunda = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert primera.status_code == segunda.status_code == 404
    assert gs.return_value.get_waveform_data.await_count == 2


# =============================================================================
# Cache eterno en DB (ventanas absolutas históricas) — performance FDSN
# =============================================================================


class _FakeResultCache:
    def __init__(self, hit=None):
        self.hit = hit
        self.get_calls = []
        self.set_calls = []

    async def get(self, key):
        self.get_calls.append(key)
        return self.hit

    async def set(self, key, payload):
        self.set_calls.append((key, payload))


@pytest.fixture
def db_cache():
    fake = _FakeResultCache()
    app.state.fdsn_result_cache = fake
    yield fake
    del app.state._state["fdsn_result_cache"]


def _stream_anclado(seconds=600.0, fs=20.0):
    from obspy import UTCDateTime

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
                    "starttime": UTCDateTime("2019-04-18T20:00:00"),
                },
            )
        ]
    )


def test_ventana_cubierta_se_persiste_en_db(client, db_cache):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream_anclado())
        resp = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 200
    assert len(db_cache.set_calls) == 1
    key, payload = db_cache.set_calls[0]
    assert key.startswith("spectra:")
    assert payload == resp.json()


def test_ventana_parcial_no_se_persiste_en_db(client, db_cache):
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(
            return_value=_stream_anclado(seconds=300.0)
        )
        resp = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 200
    assert db_cache.set_calls == []


def test_hit_de_db_evita_el_fetch_a_fdsn(client, db_cache):
    db_cache.hit = {"channel": "IU.MAJO..BHZ", "freqs": [1.0], "power_db": [2.0]}
    with patch("src.main.get_spectrogram_service") as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stream_anclado())
        resp = client.get(f"/stations/IU.MAJO..BHZ/spectra?{VENTANA}")

    assert resp.status_code == 200
    assert resp.json() == db_cache.hit
    gs.return_value.get_waveform_data.assert_not_awaited()
