"""Endpoints de métricas contra Redis real.

Mismo espíritu que test_walls_api.py (app + app.state armados a mano), pero
acá NO hace falta Postgres ni auth: los endpoints son públicos y su única
dependencia es `app.state.metrics_store`. Por eso se monta un FastAPI
descartable con el router en vez de reusar el singleton `src.main.app`.
"""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.api.routers import stations as stations_router
from src.services.metrics_store import MetricsStore

SAMPLE = {
    "channel": "IU.MAJO.00.BHZ",
    "endtime": "2026-08-21T14:32:10.000000Z",
    "rsam": 123.4,
    "freq_hz": 2.4,
    "fi": -0.12,
    "peak_db": 87.3,
    "events_hour": 3,
}


@pytest.fixture
async def app_with_store(redis_url):
    app = FastAPI()
    app.include_router(stations_router.router)
    store = MetricsStore(redis_url)
    await store.connect()
    app.state.metrics_store = store
    yield app, store
    await store.close()


@pytest.fixture
async def client(app_with_store):
    app, _ = app_with_store
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def test_snapshot_singular(client, app_with_store):
    _, store = app_with_store
    await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)

    response = await client.get("/stations/IU.MAJO.00.BHZ/metrics")

    assert response.status_code == 200
    assert response.json() == SAMPLE


async def test_snapshot_singular_sin_datos_da_404(client):
    response = await client.get("/stations/XX.NADA..HHZ/metrics")
    assert response.status_code == 404


async def test_batch_omite_canales_sin_datos(client, app_with_store):
    _, store = app_with_store
    await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)

    response = await client.get(
        "/stations/metrics",
        params=[("channel", "IU.MAJO.00.BHZ"), ("channel", "XX.NADA..HHZ")],
    )

    assert response.status_code == 200
    assert response.json() == {"metrics": {"IU.MAJO.00.BHZ": SAMPLE}}


async def test_batch_con_mas_de_120_canales_da_422(client):
    params = [("channel", f"XX.S{i:04d}..HHZ") for i in range(121)]
    response = await client.get("/stations/metrics", params=params)
    assert response.status_code == 422


async def test_sin_redis_da_503(redis_url):
    app = FastAPI()
    app.include_router(stations_router.router)
    app.state.metrics_store = None
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        response = await c.get("/stations/IU.MAJO.00.BHZ/metrics")
    assert response.status_code == 503
