"""El ingestor de GEOFON es el mismo motor apuntando a otro servidor.

No se testea la lógica de ingesta acá: es la MISMA clase SeedLinkIngestor que
ya cubren los tests de seedlink_ingestor.py. Lo que se verifica es lo único
que este módulo aporta: que apunte al servidor correcto, que derive los
canales del catálogo correcto, y que no pise los canales del otro ingestor.
"""

from src.services.seedlink_ingestor import DEFAULT_CHANNELS, SeedLinkIngestor
from src.services.seedlink_ingestor_geofon import (
    DEFAULT_CHANNELS_GEOFON,
    GEOFON_SERVER,
)
from src.services.spectrogram_service import LIVE_CANDIDATES_GEOFON_BY_CITY


class _FakeBus:
    """Stub del EventBus: el constructor no publica nada, solo lo guarda."""

    async def publish(self, *args, **kwargs):  # pragma: no cover - nunca se llama
        raise AssertionError("el constructor no debe publicar")


def test_seedlink_ingestor_geofon_instancia_con_server_correcto():
    # El default de la clase es rtserve.earthscope.org: si el server no se pasa
    # explícito, el proceso "de GEOFON" se conectaría al servidor equivocado y
    # duplicaría la ingesta de rtserve sin que nada falle a la vista.
    ingestor = SeedLinkIngestor(_FakeBus(), server=GEOFON_SERVER)

    assert ingestor.server == "geofon.gfz-potsdam.de"
    assert SeedLinkIngestor(_FakeBus()).server != GEOFON_SERVER


def test_default_channels_geofon_sale_del_catalogo_de_geofon():
    # Verificado contra el servidor real el 2026-08-31: los 5 canales
    # entregaron paquetes SeedLink de 520 bytes.
    assert DEFAULT_CHANNELS_GEOFON, "el catálogo de GEOFON no puede estar vacío"

    esperados = {
        tuple(seed_id.split(".")[i] for i in (0, 1, 3))
        for candidates in LIVE_CANDIDATES_GEOFON_BY_CITY.values()
        for seed_id in candidates
    }
    assert set(DEFAULT_CHANNELS_GEOFON) == esperados


def test_default_channels_geofon_no_colisiona_con_default_channels_rtserve():
    # spectrogram_columns usa `channel` como clave: dos ingestores escribiendo
    # el MISMO "NET.STA.CHAN" desde servidores distintos se pisarían entre sí.
    # Hoy los catálogos son disjuntos por construcción (se verificó que ninguna
    # estación de GEOFON está en rtserve); este test es la regresión que avisa
    # si eso deja de ser cierto cuando el catálogo crezca en la Fase 6.
    assert not set(DEFAULT_CHANNELS) & set(DEFAULT_CHANNELS_GEOFON)


def test_el_respaldo_por_canal_da_suscripciones_independientes():
    # GE.KBU..BHZ y GE.KBU..SHZ son la misma estación: si channels_from_catalog
    # dedupeara por estación en vez de por (red, estación, canal), el respaldo
    # sería teatro — una sola suscripción disfrazada de dos.
    kbu = [c for c in DEFAULT_CHANNELS_GEOFON if c[1] == "KBU"]

    assert len(kbu) == 2
    assert {c[2] for c in kbu} == {"BHZ", "SHZ"}
