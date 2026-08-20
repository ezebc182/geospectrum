"""
Tests del piso de magnitud en el fetch a las fuentes.

El bug (2026-08-20): min_mag_alert=3.0 se usaba como `minmagnitude` en la URL
del fetch a USGS y EMSC — los eventos M<3 JAMÁS entraban al sistema. El
dashboard parecía muerto (ventana de 60 min + piso M3 + recorte de área ≈ cero
eventos nuevos) y el slider de 2.5 del Explorador era mentira: pedía 2.5 sobre
un universo que ya venía recortado a 3.0.

Ahora: piso configurable bajo (source_min_magnitude=1.0) y los endpoints
propagan el min_mag pedido hasta la fuente.
"""

from unittest.mock import AsyncMock, patch

import pytest

from src.config.settings import settings
from src.services import cache
from src.services.usgs_service import fetch_usgs_events
from src.services.emsc_service import fetch_emsc_events


@pytest.fixture(autouse=True)
def clear_cache_between_tests():
    cache.clear()
    yield
    cache.clear()


class _CapturingClient:
    """httpx.AsyncClient falso: captura los params y devuelve un JSON vacío."""

    captured: dict = {}

    def __init__(self, *args, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def get(self, url, params=None):
        _CapturingClient.captured = dict(params or {})

        class _Resp:
            def raise_for_status(self):
                pass

            def json(self):
                return {"features": []}

        return _Resp()


@pytest.mark.asyncio
async def test_usgs_pide_el_piso_configurado_no_m3(monkeypatch):
    monkeypatch.setattr("src.services.usgs_service.httpx.AsyncClient", _CapturingClient)
    await fetch_usgs_events(window_minutes=60)
    assert _CapturingClient.captured["minmagnitude"] == str(settings.source_min_magnitude)


@pytest.mark.asyncio
async def test_usgs_propaga_el_min_mag_explicito(monkeypatch):
    monkeypatch.setattr("src.services.usgs_service.httpx.AsyncClient", _CapturingClient)
    await fetch_usgs_events(window_minutes=60, min_magnitude=2.5)
    assert _CapturingClient.captured["minmagnitude"] == "2.5"


@pytest.mark.asyncio
async def test_emsc_pide_el_piso_configurado_no_m3(monkeypatch):
    monkeypatch.setattr("src.services.emsc_service.httpx.AsyncClient", _CapturingClient)
    await fetch_emsc_events(window_minutes=60)
    assert _CapturingClient.captured["minmag"] == str(settings.source_min_magnitude)


@pytest.mark.asyncio
async def test_emsc_propaga_el_min_mag_explicito(monkeypatch):
    monkeypatch.setattr("src.services.emsc_service.httpx.AsyncClient", _CapturingClient)
    await fetch_emsc_events(window_minutes=60, min_magnitude=2.5)
    assert _CapturingClient.captured["minmag"] == "2.5"


def test_el_piso_de_fetch_es_bajo():
    """El piso existe para descartar micro-sismos (M<1 de redes densas), no
    para esconder sismos reales: si alguien lo vuelve a subir a 3, el
    dashboard vuelve a parecer muerto."""
    assert settings.source_min_magnitude <= 1.5


@pytest.mark.asyncio
async def test_cache_no_mezcla_pisos_de_magnitud_distintos():
    """La clave del caché debe incluir el piso: /report (piso default) y
    /events/search (min_mag del usuario) comparten el mismo store global —
    sin el piso en la clave, una búsqueda M4+ del Explorador serviría
    resultados recortados al /report de los próximos 30 segundos."""
    from src.services.report_service import build_report

    llamadas: list[float | None] = []

    async def _fake_fetch(window_minutes, min_magnitude=None):
        llamadas.append(min_magnitude)
        return [], None

    with (
        patch("src.services.report_service.fetch_usgs_events", side_effect=_fake_fetch),
        patch("src.services.report_service.fetch_emsc_events", side_effect=_fake_fetch),
        patch(
            "src.services.report_service.fetch_inpres_events", new_callable=AsyncMock
        ) as mock_inpres,
    ):
        mock_inpres.return_value = ([], None)
        await build_report(sources=["usgs", "emsc"])
        await build_report(sources=["usgs", "emsc"], min_magnitude=4.0)

    # Si la clave no incluyera el piso, la segunda tanda saldría del caché y
    # las llamadas con 4.0 no existirían.
    assert llamadas.count(4.0) == 2
