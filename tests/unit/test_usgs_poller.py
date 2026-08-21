"""
Tests del poller de USGS (PR-W4, T5).

Es la red de seguridad del push: cubre los sismos que EMSC no reporta y los
minutos en que su WebSocket está caído. Lo que se fija acá es que ESA red no
se rompa sola — un poller que muere en silencio nos deja sin respaldo justo
cuando más falta hace.

`fetch_usgs_events` se mockea porque es I/O contra USGS; lo que se testea es
el ciclo, no el cliente HTTP (que ya tiene sus propios tests).
"""

from unittest.mock import AsyncMock, patch

import pytest

from src.ingestors.usgs_poller import (
    POLL_INTERVAL_SECONDS,
    POLL_WINDOW_MINUTES,
    USGSPoller,
)
from src.models.event import SeismicEvent

# Sin `pytestmark` global: TestCadencia son asserts sync sobre constantes y
# marcarlos como asyncio dispara un PytestWarning. Silenciar ese warning sería
# repetir el error del timeZone (commit 92b0328): el aviso es información, no
# ruido. Las clases async llevan la marca a nivel de clase.


def build_event(event_id: str = "usgs_a", mag: float = 4.5) -> SeismicEvent:
    return SeismicEvent(
        id=event_id,
        fuentes=["USGS"],
        hora_utc="2026-08-21T12:00:00Z",
        lat=-23.5,
        lon=-68.2,
        prof_km=110.0,
        mag=mag,
        mag_tipo="mb",
        lugar="Antofagasta, Chile",
    )


@pytest.mark.asyncio
class TestPollOnce:
    async def test_entrega_cada_evento_al_callback(self):
        recibidos = []
        poller = USGSPoller(on_event=lambda e: _collect(recibidos, e))

        with patch(
            "src.ingestors.usgs_poller.fetch_usgs_events",
            new=AsyncMock(return_value=([build_event("a"), build_event("b")], None)),
        ):
            entregados = await poller.poll_once()

        assert entregados == 2
        assert recibidos == ["a", "b"]

    async def test_usgs_caido_no_levanta(self):
        """
        USGS caído no debe matar al worker: EMSC sigue vivo y es la fuente
        principal. `fetch_usgs_events` ya devuelve (lista_vacía, error) en vez
        de tirar excepción; acá se fija que el poller respete ese contrato.
        """
        poller = USGSPoller(on_event=_noop)

        with patch(
            "src.ingestors.usgs_poller.fetch_usgs_events",
            new=AsyncMock(return_value=([], "timeout contra USGS")),
        ):
            assert await poller.poll_once() == 0

        assert poller.last_error == "timeout contra USGS"

    async def test_un_callback_que_falla_no_corta_el_ciclo(self):
        """Igual que en EMSC: un evento que explota no se lleva a los demás."""
        recibidos = []

        async def on_event(evento):
            recibidos.append(evento.id)
            if evento.id == "a":
                raise RuntimeError("fallo simulado del store")

        poller = USGSPoller(on_event=on_event)
        with patch(
            "src.ingestors.usgs_poller.fetch_usgs_events",
            new=AsyncMock(return_value=([build_event("a"), build_event("b")], None)),
        ):
            entregados = await poller.poll_once()

        assert recibidos == ["a", "b"]
        # El que falló no cuenta como entregado.
        assert entregados == 1

    async def test_un_poll_exitoso_limpia_el_error_anterior(self):
        """
        Sin esto, un error transitorio quedaría pegado para siempre y el
        healthcheck reportaría USGS caído con USGS andando.
        """
        poller = USGSPoller(on_event=_noop)
        poller.last_error = "error viejo"

        with patch(
            "src.ingestors.usgs_poller.fetch_usgs_events",
            new=AsyncMock(return_value=([build_event()], None)),
        ):
            await poller.poll_once()

        assert poller.last_error is None

    async def test_pide_la_ventana_configurada(self):
        fake = AsyncMock(return_value=([], None))
        poller = USGSPoller(on_event=_noop, window_minutes=15, min_magnitude=3.0)

        with patch("src.ingestors.usgs_poller.fetch_usgs_events", new=fake):
            await poller.poll_once()

        fake.assert_awaited_once_with(window_minutes=15, min_magnitude=3.0)


class TestCadencia:
    def test_pollea_cada_sesenta_segundos(self):
        """La cadencia del feed de USGS: pollear más seguido trae lo mismo."""
        assert POLL_INTERVAL_SECONDS == 60.0

    def test_la_ventana_es_mucho_mayor_que_el_intervalo(self):
        """
        15 min de ventana contra 1 de intervalo. El solape es deliberado: si
        un poll falla o el proceso se reinicia, el siguiente recupera lo
        perdido en vez de dejar un hueco. Traer de más es gratis porque el
        dedupe descarta lo ya conocido.
        """
        assert POLL_WINDOW_MINUTES * 60 > POLL_INTERVAL_SECONDS * 10


@pytest.mark.asyncio
class TestRun:
    async def test_stop_corta_el_loop(self):
        """
        Sin dormir en tramos cortos, stop() tardaría un minuto entero en
        surtir efecto y el shutdown del worker se colgaría.
        """
        import asyncio

        poller = USGSPoller(on_event=_noop, interval_s=0.05)

        with patch(
            "src.ingestors.usgs_poller.fetch_usgs_events",
            new=AsyncMock(return_value=([], None)),
        ):
            task = asyncio.create_task(poller.run())
            await asyncio.sleep(0.12)
            poller.stop()
            await asyncio.wait_for(task, timeout=1.0)

    async def test_un_error_inesperado_no_mata_el_loop(self):
        """
        Este poller es el fallback del WS. Si se muere en silencio nos
        quedamos sin red de seguridad; tiene que seguir intentando.
        """
        import asyncio

        llamadas = []

        async def explota(**_kwargs):
            llamadas.append(1)
            raise RuntimeError("algo inesperado")

        poller = USGSPoller(on_event=_noop, interval_s=0.05)
        with patch("src.ingestors.usgs_poller.fetch_usgs_events", new=explota):
            task = asyncio.create_task(poller.run())
            await asyncio.sleep(0.18)
            poller.stop()
            await asyncio.wait_for(task, timeout=1.0)

        # Siguió intentando después del primer fallo.
        assert len(llamadas) >= 2


async def _noop(_evento):
    return None


async def _collect(destino, evento):
    destino.append(evento.id)
