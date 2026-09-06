"""`GET /analytics/tremor/{channel}` de punta a punta, sin red (3.4).

Molde `test_station_rsam_endpoint.py`: `TestClient(app)` SIN `with` (el
`with` dispara el lifespan real), `patch` del singleton FDSN. OJO con el
target del patch: el router importa `get_spectrogram_service` desde
`src.services.spectrogram_service`, así que se parchea
`src.api.routers.analytics.get_spectrogram_service`, NO `src.main.…`.

La clasificación (capa 1) y la caracterización (capa 2) viven en
`test_tremor.py`; acá se fija el CONTRATO HTTP: validaciones con sus
códigos, el 404 honesto, la forma del body, y el escenario "tremor y
tendencia comparten la serie" — `samples[i].rsam`/`t` del tremor son
EXACTAMENTE `samples[i].value`/`t` de `/stations/{channel}/rsam` sobre la
misma traza.
"""

import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import numpy as np
import pytest
from fastapi.testclient import TestClient
from obspy import Stream, Trace, UTCDateTime

from src.main import app

SERVICE = "src.api.routers.analytics.get_spectrogram_service"
RSAM_SERVICE = "src.main.get_spectrogram_service"

# Tres horas: 18 períodos de 600 s a 20 Hz.
START = "2019-04-18T20:00:00"
VENTANA = "start=2019-04-18T20:00:00Z&end=2019-04-18T23:00:00Z"
FS = 20.0
SECONDS = 3 * 3600.0

CONSTANTS = json.loads(
    (
        Path(__file__).resolve().parents[2] / "dashboard" / "lib" / "seismic-constants.json"
    ).read_text(encoding="utf-8")
)


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _cache_limpio():
    from src.services import cache as _cache

    _cache.clear()
    yield
    _cache.clear()


def _stream(data: np.ndarray, fs: float = FS, start: str = START) -> Stream:
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


def _stationary_stream(seconds: float = SECONDS) -> Stream:
    """Senoidal de amplitud fija: RSAM constante en TODOS los períodos ⇒ nada
    supera `baseline × factor` y no hay episodio. Es la 'traza constante' del
    escenario (una DC pura daría RSAM 0 y un espectro degenerado)."""
    t = np.arange(int(FS * seconds)) / FS
    return _stream(500.0 + 100.0 * np.sin(2 * np.pi * 5.0 * t))


def _plateau_stream() -> Stream:
    """Ruido uniforme de amplitud 1 con 40 min (períodos 6-9, alineados a los
    cortes de 600 s) a amplitud ×3 con tono de 1.5 Hz: UN episodio de 4
    muestras sobre una línea base de ~0.5."""
    rng = np.random.default_rng(7)
    n = int(FS * SECONDS)
    t = np.arange(n) / FS
    data = rng.uniform(-1.0, 1.0, n)
    lo, hi = int(6 * 600 * FS), int(10 * 600 * FS)
    data[lo:hi] = 3.0 * data[lo:hi] + np.sin(2 * np.pi * 1.5 * t[lo:hi])
    return _stream(500.0 + data)


# --- validaciones de borde (iguales a /rsam) --------------------------------


def test_scnl_de_tres_partes_da_422(client):
    resp = client.get(f"/analytics/tremor/GE.KBU.BHZ?{VENTANA}")
    assert resp.status_code == 422
    assert "NET.STA.LOC.CHA" in resp.json()["detail"]


def test_start_y_end_son_obligatorios(client):
    resp = client.get("/analytics/tremor/IU.MAJO..BHZ")
    assert resp.status_code == 422


def test_end_anterior_a_start_da_422(client):
    resp = client.get(
        "/analytics/tremor/IU.MAJO..BHZ?start=2019-04-18T21:00:00Z&end=2019-04-18T20:00:00Z"
    )
    assert resp.status_code == 422
    assert "posterior" in resp.json()["detail"]


def test_ventana_de_25_horas_da_422_con_detail(client):
    resp = client.get(
        "/analytics/tremor/IU.MAJO..BHZ?start=2019-04-18T00:00:00Z&end=2019-04-19T01:00:00Z"
    )
    assert resp.status_code == 422
    assert "24" in resp.json()["detail"]


def test_sin_datos_fdsn_da_404_honesto(client):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=None)
        resp = client.get(f"/analytics/tremor/XX.NADA..BHZ?{VENTANA}")

    assert resp.status_code == 404
    detail = resp.json()["detail"]
    assert detail != "Not Found"  # el 404 genérico de una ruta inexistente
    assert "XX.NADA..BHZ" in detail


def test_stream_vacio_tambien_es_404(client):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=Stream())
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 404
    assert resp.json()["detail"] != "Not Found"


# --- contrato del body --------------------------------------------------------


def test_traza_estacionaria_no_tiene_episodios(client):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 200
    body = resp.json()
    assert body["channel"] == "IU.MAJO..BHZ"
    assert body["sampling_rate"] == FS
    assert body["period_seconds"] == 600
    assert body["episodes"] == []
    assert body["tremor_fraction"] == 0.0
    assert body["baseline_rsam"] is not None and body["baseline_rsam"] > 0
    assert body["threshold_rsam"] == pytest.approx(
        body["baseline_rsam"] * CONSTANTS["tremorBaselineFactor"]
    )
    assert len(body["samples"]) == 18
    assert set(body["samples"][0]) == {"t", "rsam", "dominant_hz", "fi"}
    # `t` es el CENTRO de la primera ventana (start + 300 s), como en /rsam.
    assert body["samples"][0]["t"].startswith("2019-04-18T20:05:00")


def test_meseta_de_40_minutos_es_un_episodio_con_los_parametros_del_json(client):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_plateau_stream())
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 200
    body = resp.json()
    assert len(body["episodes"]) == 1
    episode = body["episodes"][0]
    assert episode["samples"] == 4
    assert episode["duration_s"] == 2400
    assert episode["band"] == "low"
    assert episode["start"].startswith("2019-04-18T21:05:00")
    assert episode["end"].startswith("2019-04-18T21:35:00")
    assert body["tremor_fraction"] == pytest.approx(4 / 18)
    # Los parámetros con los que se clasificó son los del JSON compartido, no
    # una copia del router.
    assert body["parameters"] == {
        "baseline_factor": CONSTANTS["tremorBaselineFactor"],
        "min_duration_periods": CONSTANTS["tremorMinDurationPeriods"],
    }


def test_tremor_y_tendencia_comparten_la_serie(client):
    """Escenario de la spec: misma traza ⇒ `tremor.samples[i].rsam ==
    rsam.samples[i].value` y el mismo `t`, para todo `i`. Si el tremor
    calculara amplitud por otra vía, o alineara `t` distinto, esto muere."""
    stream = _plateau_stream()
    with patch(SERVICE) as gs, patch(RSAM_SERVICE) as gs_main:
        gs.return_value.get_waveform_data = AsyncMock(return_value=stream)
        gs_main.return_value.get_waveform_data = AsyncMock(return_value=stream)
        tremor = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")
        rsam = client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}&period_seconds=600")

    assert tremor.status_code == rsam.status_code == 200
    tremor_samples = tremor.json()["samples"]
    rsam_samples = rsam.json()["samples"]
    assert len(tremor_samples) == len(rsam_samples) == 18
    assert [s["t"] for s in tremor_samples] == [s["t"] for s in rsam_samples]
    assert [s["rsam"] for s in tremor_samples] == [s["value"] for s in rsam_samples]


# --- caches (mismo camino que /rsam) -----------------------------------------


def test_la_misma_ventana_se_sirve_del_cache_en_memoria(client):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")
        client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert gs.return_value.get_waveform_data.await_count == 1


def test_el_cache_del_tremor_no_colisiona_con_el_de_rsam(client):
    """Misma ventana, dos claves: un hit de `rsam:` no puede servir un body de
    tremor (ni al revés)."""
    with patch(SERVICE) as gs, patch(RSAM_SERVICE) as gs_main:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        gs_main.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        client.get(f"/stations/IU.MAJO..BHZ/rsam?{VENTANA}&period_seconds=600")
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert gs.return_value.get_waveform_data.await_count == 1
    assert "episodes" in resp.json()


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


def test_ventana_cubierta_se_persiste_en_db_con_clave_propia(client, db_cache):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 200
    assert len(db_cache.set_calls) == 1
    key, payload = db_cache.set_calls[0]
    assert key.startswith("tremor:")
    assert payload == resp.json()


def test_ventana_parcial_no_se_persiste_en_db(client, db_cache):
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(
            return_value=_stationary_stream(seconds=1800.0)
        )
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 200
    assert db_cache.set_calls == []


def test_hit_de_db_evita_el_fetch_a_fdsn(client, db_cache):
    # Un body COMPLETO, como lo congeló el propio endpoint: el hit pasa por el
    # response_model y un parcial se rechazaría (500), no probaría nada.
    db_cache.hit = {
        "channel": "IU.MAJO..BHZ",
        "sampling_rate": 20.0,
        "period_seconds": 600,
        "baseline_rsam": None,
        "threshold_rsam": None,
        "tremor_fraction": 0.0,
        "parameters": {"baseline_factor": 2.0, "min_duration_periods": 3},
        "samples": [],
        "episodes": [],
    }
    with patch(SERVICE) as gs:
        gs.return_value.get_waveform_data = AsyncMock(return_value=_stationary_stream())
        resp = client.get(f"/analytics/tremor/IU.MAJO..BHZ?{VENTANA}")

    assert resp.status_code == 200
    assert resp.json() == db_cache.hit
    gs.return_value.get_waveform_data.assert_not_awaited()
