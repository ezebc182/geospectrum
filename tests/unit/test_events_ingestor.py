"""
Tests del worker de ingesta de eventos (PR-W4, T6).

Lo que se fija acá es la POLÍTICA que el worker agrega sobre los ingestores:

1. Persiste ANTES de publicar. Si publicara primero y muriera, el evento
   quedaría en las pantallas de los conectados y desaparecería del histórico —
   peor que no haberlo mostrado.
2. Sólo publica si hubo novedad. Sin esto, cada reenvío de EMSC despierta a
   todos los clientes para mostrarles lo mismo.
3. Un fallo de Redis NO frena la ingesta: el evento ya está persistido.

El store se mockea acá (su SQL tiene tests propios contra Postgres real en
tests/integration/test_event_store.py); lo que se testea es el orden y las
decisiones, no las queries.
"""

from unittest.mock import AsyncMock

import pytest

from src.models.event import SeismicEvent
from src.services.events_ingestor import EVENTS_CHANNEL, EventsIngestor


def build_event(event_id: str = "emsc_1", mag: float = 4.5) -> SeismicEvent:
    return SeismicEvent(
        id=event_id,
        fuentes=["EMSC"],
        hora_utc="2026-08-21T12:00:00Z",
        lat=-23.5,
        lon=-68.2,
        prof_km=110.0,
        mag=mag,
        mag_tipo="mb",
        lugar="Antofagasta, Chile",
    )


class FakeBus:
    """Bus que registra lo publicado, en orden."""

    def __init__(self, falla: bool = False):
        self.published: list[tuple[str, dict]] = []
        self._falla = falla

    async def publish(self, channel: str, event: dict) -> None:
        if self._falla:
            raise RuntimeError("Redis caído")
        self.published.append((channel, event))


@pytest.mark.asyncio
class TestPublicacion:
    async def test_un_evento_nuevo_se_persiste_y_se_publica(self):
        evento = build_event()
        bus = FakeBus()
        store = AsyncMock()
        store.upsert = AsyncMock(return_value=(evento, True))

        ingestor = EventsIngestor(bus, store)
        await ingestor.handle_event(evento)

        store.upsert.assert_awaited_once_with(evento)
        assert len(bus.published) == 1
        canal, payload = bus.published[0]
        assert canal == EVENTS_CHANNEL
        assert payload["id"] == "emsc_1"
        assert ingestor.persisted_count == 1
        assert ingestor.published_count == 1

    async def test_un_duplicado_NO_se_publica(self):
        """
        EL test de la feature. EMSC reenvía el mismo evento sin cambios; sin
        este filtro cada reenvío despertaría a todos los clientes conectados.
        """
        evento = build_event()
        bus = FakeBus()
        store = AsyncMock()
        store.upsert = AsyncMock(return_value=(evento, False))

        ingestor = EventsIngestor(bus, store)
        await ingestor.handle_event(evento)

        assert bus.published == []
        assert ingestor.duplicate_count == 1
        assert ingestor.published_count == 0

    async def test_publica_el_evento_FUSIONADO_no_el_entrante(self):
        """
        Cuando USGS confirma un sismo que ya trajo EMSC, lo que va al cliente
        tiene que ser la fila fusionada (las dos fuentes, la magnitud mayor),
        no el reporte suelto que acaba de llegar.
        """
        entrante = build_event("usgs_2", mag=4.5)
        fusionado = SeismicEvent(
            **{**entrante.model_dump(), "id": "emsc_1", "fuentes": ["EMSC", "USGS"], "mag": 5.1}
        )
        bus = FakeBus()
        store = AsyncMock()
        store.upsert = AsyncMock(return_value=(fusionado, True))

        ingestor = EventsIngestor(bus, store)
        await ingestor.handle_event(entrante)

        _, payload = bus.published[0]
        assert payload["id"] == "emsc_1"
        assert payload["fuentes"] == ["EMSC", "USGS"]
        assert payload["mag"] == 5.1


@pytest.mark.asyncio
class TestOrdenYResiliencia:
    async def test_persiste_ANTES_de_publicar(self):
        """
        Si publicara primero y el proceso muriera, el evento quedaría en las
        pantallas de los conectados y desaparecería del histórico. La tabla es
        la fuente de verdad; el pub/sub es sólo la entrega rápida.
        """
        orden: list[str] = []
        evento = build_event()

        class SpyBus(FakeBus):
            async def publish(self, channel, event):
                orden.append("publish")
                await super().publish(channel, event)

        async def upsert_spy(_e):
            orden.append("upsert")
            return evento, True

        store = AsyncMock()
        store.upsert = upsert_spy

        await EventsIngestor(SpyBus(), store).handle_event(evento)

        assert orden == ["upsert", "publish"]

    async def test_redis_caido_no_frena_la_ingesta(self):
        """
        El evento ya quedó persistido: el próximo cliente que conecte lo va a
        ver en el snapshot. Mismo criterio que las métricas del seedlink
        (:141-147): un fallo de entrega jamás debe frenar la ingesta.
        """
        evento = build_event()
        store = AsyncMock()
        store.upsert = AsyncMock(return_value=(evento, True))

        ingestor = EventsIngestor(FakeBus(falla=True), store)
        await ingestor.handle_event(evento)  # no debe levantar

        assert ingestor.persisted_count == 1
        assert ingestor.published_count == 0

    async def test_un_fallo_de_la_base_SI_se_propaga(self):
        """
        Contraparte del anterior: si no se pudo persistir, no hay nada que
        salvar. El error tiene que subir para que el ingestor lo registre en
        vez de perderlo — un worker que traga errores de base es el incidente
        del seedlink otra vez.
        """
        store = AsyncMock()
        store.upsert = AsyncMock(side_effect=RuntimeError("base caída"))

        ingestor = EventsIngestor(FakeBus(), store)
        with pytest.raises(RuntimeError, match="base caída"):
            await ingestor.handle_event(build_event())


@pytest.mark.asyncio
class TestCableado:
    async def test_las_dos_fuentes_escriben_por_el_mismo_camino(self):
        """
        EMSC y USGS comparten `handle_event`: el dedupe y la publicación son
        los mismos vengan de donde vengan. Si cada fuente tuviera su ruta, una
        podría publicar duplicados y la otra no.
        """
        store = AsyncMock()
        ingestor = EventsIngestor(FakeBus(), store)

        assert ingestor.emsc._on_event == ingestor.handle_event
        assert ingestor.usgs._on_event == ingestor.handle_event

    async def test_stop_frena_las_dos_fuentes(self):
        ingestor = EventsIngestor(FakeBus(), AsyncMock())
        ingestor.emsc._running = True
        ingestor.usgs._running = True

        ingestor.stop()

        assert ingestor.emsc._running is False
        assert ingestor.usgs._running is False

    async def test_run_guarda_el_fallo_para_el_exit_code(self):
        """
        Sin `failure`, el __main__ levanta un RuntimeError genérico y el
        traceback real se pierde: el log diría "terminó" sin decir por qué.
        Es la lección de ingestor-salia-con-codigo-cero.
        """
        ingestor = EventsIngestor(FakeBus(), AsyncMock())

        async def explota():
            raise RuntimeError("EMSC murió feo")

        ingestor.emsc.run = explota
        ingestor.usgs.run = explota

        with pytest.raises(RuntimeError, match="EMSC murió feo"):
            await ingestor.run()

        assert isinstance(ingestor.failure, RuntimeError)
        assert "EMSC murió feo" in str(ingestor.failure)


class TestCanal:
    def test_el_canal_no_colisiona_con_los_existentes(self):
        """spec:{SCNL} y metrics:{SCNL} son las otras dos convenciones vivas."""
        assert EVENTS_CHANNEL == "events:new"
        assert not EVENTS_CHANNEL.startswith("spec:")
        assert not EVENTS_CHANNEL.startswith("metrics:")
