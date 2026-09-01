"""El watchdog vigila los canales de LOS DOS ingestores, no solo el de rtserve.

Desde que existe seedlink_ingestor_geofon.py hay dos procesos SeedLink
escribiendo en la misma tabla spectrogram_columns. Si expected_channels solo
lleva los de rtserve, el watchdog no se entera nunca de que el ingestor de
GEOFON se murió: sus canales no están en la lista de esperados, así que no
pueden faltar.

El riesgo simétrico es igual de real y es el que justifica el orden de fases:
si el watchdog conociera los canales de GEOFON ANTES de que ese proceso esté
desplegado, reportaría falsos "mudos" desde el primer ciclo.
"""

from src.services.seedlink_ingestor import DEFAULT_CHANNELS
from src.services.seedlink_ingestor_geofon import DEFAULT_CHANNELS_GEOFON
from src.services.watchdog import build_expected_channels


def test_incluye_los_canales_de_los_dos_ingestores():
    expected = build_expected_channels()

    assert "MN.TRI.HHZ" in expected, "falta un canal de GEOFON"
    assert len(expected) == len(DEFAULT_CHANNELS) + len(DEFAULT_CHANNELS_GEOFON)


def test_usa_la_clave_de_suscripcion_NET_STA_CHAN():
    # La clave de suscripción es de 3 partes porque el location code no se
    # puede derivar de antemano. NO es el formato de la base: la base guarda
    # trace.id de 4 partes con location, y check_seedlink normaliza el lado
    # activo con _to_subscription_key antes de comparar.
    for canal in build_expected_channels():
        partes = canal.split(".")
        assert len(partes) == 3, f"{canal!r} no tiene forma NET.STA.CHAN"
        assert all(partes), f"{canal!r} tiene campos vacíos"


def test_no_pierde_los_canales_de_rtserve_al_sumar_geofon():
    # La regresión que importa: concatenar mal y quedarse solo con GEOFON
    # apagaría la vigilancia de los 74 canales que hoy YA están en producción.
    expected = set(build_expected_channels())

    for net, sta, cha in DEFAULT_CHANNELS:
        assert f"{net}.{sta}.{cha}" in expected


def test_no_repite_canales():
    expected = build_expected_channels()

    assert len(expected) == len(set(expected))
