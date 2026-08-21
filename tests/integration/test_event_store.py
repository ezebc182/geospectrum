"""
Tests del EventStore contra Postgres REAL (PR-W4, T2).

Van en integration y con testcontainer, no con mocks, por la doctrina del
proyecto (tests/integration/conftest.py:1-12): los mocks de asyncpg validan que
se llame al pool, no que la query sea correcta. Dos bugs de SQL del pasado
pasaron por mocks verdes.

Lo que se fija acá es el CONTRATO del store:
- el mismo sismo por dos fuentes ocupa UNA fila
- una revisión de EMSC actualiza, no duplica
- un reenvío idéntico devuelve `hubo_novedad = False` (no despierta clientes)
- `recent()` corta por hora del sismo y ordena del más nuevo al más viejo
"""

from datetime import datetime, timedelta, timezone

import pytest

from src.models.event import SeismicEvent

pytestmark = pytest.mark.asyncio


def build_event(**overrides) -> SeismicEvent:
    """M4.5 en Antofagasta, con hora RELATIVA a ahora.

    Relativa y no fija porque `recent()` filtra por ventana contra
    `now()`: con una fecha clavada en 2026 los tests pasarían o no según el
    día en que se corran.
    """
    ahora = datetime.now(timezone.utc)
    data = {
        "id": "usgs_us7000abcd",
        "fuentes": ["USGS"],
        "hora_utc": ahora.isoformat().replace("+00:00", "Z"),
        "lat": -23.5,
        "lon": -68.2,
        "prof_km": 110.0,
        "mag": 4.5,
        "mag_tipo": "Mw",
        "lugar": "Antofagasta, Chile",
        "sentido": False,
        "revisado": False,
    }
    data.update(overrides)
    return SeismicEvent(**data)


def hours_ago(hours: float) -> str:
    ts = datetime.now(timezone.utc) - timedelta(hours=hours)
    return ts.isoformat().replace("+00:00", "Z")


class TestUpsertSismoNuevo:
    async def test_persiste_y_reporta_novedad(self, event_store):
        evento, novedad = await event_store.upsert(build_event())

        assert novedad is True
        assert evento.id == "usgs_us7000abcd"
        assert (await event_store.get("usgs_us7000abcd")) is not None

    async def test_los_campos_sobreviven_el_roundtrip(self, event_store):
        """
        Que la fila se escriba no alcanza: hay que leerla de vuelta. Un
        `fuentes` mal mapeado a TEXT[] o una hora sin tz se detectan acá, no
        en el INSERT.
        """
        await event_store.upsert(build_event(fuentes=["USGS", "EMSC"], sentido=True))
        leido = await event_store.get("usgs_us7000abcd")

        assert leido.fuentes == ["USGS", "EMSC"]
        assert leido.mag == 4.5
        assert leido.mag_tipo == "Mw"
        assert leido.prof_km == 110.0
        assert leido.lugar == "Antofagasta, Chile"
        assert leido.sentido is True
        assert leido.revisado is False
        # La hora vuelve como ISO con Z, no como datetime ni con "+00:00".
        assert leido.hora_utc.endswith("Z")

    async def test_prof_km_nula_sobrevive(self, event_store):
        """INPRES a veces no reporta profundidad."""
        await event_store.upsert(build_event(prof_km=None))
        assert (await event_store.get("usgs_us7000abcd")).prof_km is None


class TestDedupeEntreFuentes:
    async def test_el_mismo_sismo_por_dos_fuentes_ocupa_una_sola_fila(self, event_store):
        """
        EL test de la feature. USGS y EMSC reportan el mismo sismo con ids
        distintos: sin dedupe, el globo mostraría dos epicentros pegados.
        """
        base = datetime.now(timezone.utc)
        usgs = build_event(hora_utc=base.isoformat().replace("+00:00", "Z"))
        emsc = build_event(
            id="emsc_1234567",
            fuentes=["EMSC"],
            # 40 s después y ~12 km corrido: adentro del criterio.
            hora_utc=(base + timedelta(seconds=40)).isoformat().replace("+00:00", "Z"),
            lat=-23.6,
            lon=-68.25,
            mag=4.7,
        )

        await event_store.upsert(usgs)
        fusionado, novedad = await event_store.upsert(emsc)

        assert novedad is True
        assert len(await event_store.recent(hours=1)) == 1
        # Conserva el id del primero (es la PK de la fila que se actualizó).
        assert fusionado.id == "usgs_us7000abcd"
        # Y acumula las dos fuentes con la magnitud mayor.
        assert fusionado.fuentes == ["EMSC", "USGS"]
        assert fusionado.mag == 4.7

    async def test_dos_sismos_distintos_son_dos_filas(self, event_store):
        """Contraprueba: sin esto, un dedupe demasiado agresivo pasaría igual."""
        await event_store.upsert(build_event())
        await event_store.upsert(
            build_event(id="usgs_tokio", lat=35.6, lon=139.7, lugar="Tokio, Japón")
        )
        assert len(await event_store.recent(hours=1)) == 2

    async def test_dos_sismos_en_el_mismo_lugar_pero_separados_en_el_tiempo(
        self, event_store
    ):
        """
        Una réplica 10 minutos después del sismo principal es un evento
        propio, no un duplicado.
        """
        base = datetime.now(timezone.utc)
        await event_store.upsert(
            build_event(hora_utc=base.isoformat().replace("+00:00", "Z"))
        )
        await event_store.upsert(
            build_event(
                id="usgs_replica",
                hora_utc=(base - timedelta(minutes=10)).isoformat().replace("+00:00", "Z"),
            )
        )
        assert len(await event_store.recent(hours=1)) == 2


class TestRevisiones:
    async def test_una_revision_actualiza_la_fila_existente(self, event_store):
        """EMSC manda revisiones del mismo evento con magnitud corregida."""
        await event_store.upsert(build_event(id="emsc_1234567", fuentes=["EMSC"]))
        revisado, novedad = await event_store.upsert(
            build_event(id="emsc_1234567", fuentes=["EMSC"], mag=5.2, revisado=True)
        )

        assert novedad is True
        assert len(await event_store.recent(hours=1)) == 1
        assert revisado.mag == 5.2
        assert revisado.revisado is True
        # Y quedó escrito, no sólo devuelto.
        assert (await event_store.get("emsc_1234567")).mag == 5.2

    async def test_un_reenvio_identico_no_es_novedad(self, event_store):
        """
        Sin esto, cada reenvío de EMSC despertaría a todos los clientes
        conectados para mostrarles exactamente lo mismo.
        """
        evento = build_event()
        await event_store.upsert(evento)
        _, novedad = await event_store.upsert(evento)

        assert novedad is False
        assert len(await event_store.recent(hours=1)) == 1


class TestRecent:
    async def test_ordena_del_mas_nuevo_al_mas_viejo(self, event_store):
        await event_store.upsert(build_event(id="viejo", hora_utc=hours_ago(3)))
        await event_store.upsert(build_event(id="nuevo", lat=10.0, lon=10.0))
        await event_store.upsert(
            build_event(id="medio", lat=20.0, lon=20.0, hora_utc=hours_ago(1))
        )

        assert [e.id for e in await event_store.recent(hours=24)] == [
            "nuevo",
            "medio",
            "viejo",
        ]

    async def test_corta_por_la_ventana_pedida(self, event_store):
        await event_store.upsert(build_event(id="dentro", hora_utc=hours_ago(2)))
        await event_store.upsert(
            build_event(id="fuera", lat=10.0, lon=10.0, hora_utc=hours_ago(30))
        )

        ids = [e.id for e in await event_store.recent(hours=24)]
        assert ids == ["dentro"]

    async def test_filtra_por_magnitud_minima(self, event_store):
        await event_store.upsert(build_event(id="chico", mag=2.1))
        await event_store.upsert(build_event(id="grande", lat=10.0, lon=10.0, mag=6.3))

        ids = [e.id for e in await event_store.recent(hours=24, min_magnitude=5.0)]
        assert ids == ["grande"]

    async def test_respeta_el_limit(self, event_store):
        for i in range(5):
            await event_store.upsert(
                build_event(id=f"ev{i}", lat=float(i * 10), lon=float(i * 10))
            )
        assert len(await event_store.recent(hours=24, limit=3)) == 3

    async def test_sin_eventos_devuelve_lista_vacia(self, event_store):
        assert await event_store.recent(hours=24) == []


class TestStats:
    async def test_cuenta_y_reporta_el_ultimo(self, event_store):
        await event_store.upsert(build_event(id="a", hora_utc=hours_ago(5)))
        await event_store.upsert(build_event(id="b", lat=10.0, lon=10.0))

        stats = await event_store.stats()
        assert stats["total"] == 2
        assert stats["ultimo_evento_utc"].endswith("Z")

    async def test_base_vacia_no_rompe(self, event_store):
        """max() sobre cero filas devuelve NULL — el healthcheck no debe explotar."""
        stats = await event_store.stats()
        assert stats["total"] == 0
        assert stats["ultimo_evento_utc"] is None


class TestConexion:
    async def test_usar_el_store_sin_conectar_falla_claro(self, _migrated):
        """
        Un AttributeError sobre None sería críptico. El mensaje tiene que
        decir qué hacer.
        """
        from src.services.event_store import EventStore

        store = EventStore(_migrated)
        with pytest.raises(RuntimeError, match="connect"):
            _ = store.pool

    async def test_connect_es_idempotente(self, _migrated):
        from src.services.event_store import EventStore

        store = EventStore(_migrated)
        await store.connect()
        primer_pool = store.pool
        await store.connect()
        try:
            assert store.pool is primer_pool
        finally:
            await store.close()
