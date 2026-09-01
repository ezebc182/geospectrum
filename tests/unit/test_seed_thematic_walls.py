"""Tests de contrato del armado de layouts de walls temáticos.

El script no lleva mutación crítica (convención fijada en tasks.md de
mega-wall-estaciones-cuaderno): es una herramienta de seed que se corre a
mano, no código de request. Lo que SÍ tiene que estar blindado es que el
layout que produce pase `validate_wall_layout()` — la función real de
wall_service, no un mock: si el script genera un layout inválido, el fallo
aparece recién al insertar en producción.
"""

import pytest

from scripts.seed_thematic_walls import (
    REGION_WALL_NAMES,
    SMOKE_TEST_WALL_NAME,
    build_region_walls,
    build_smoke_test_wall,
)
from src.services.wall_service import (
    MAX_WALL_CHANNELS,
    MAX_WALL_COLUMNS,
    InvalidWallLayoutError,
    validate_wall_layout,
)

# Subconjunto de humo de referencia: mezcla deliberada de ambos servidores,
# como exige la tarea 4.1. No es el subconjunto definitivo (ese lo fija 4.2
# sobre el catálogo real) — acá sirve para probar el contrato del armado.
RTSERVE_SUBSET = {
    "tokyo": ["JP.JYT..BHZ", "IU.MAJO.00.BHZ"],
    "lima": ["II.NNA.00.BHZ"],
    "santiago": ["C1.BO04..HHZ"],
    "losangeles": ["CI.MLAC..HNZ"],
    "wellington": ["NZ.BFZ.10.HNZ"],
}

# Ninguna de estas tres está en CITY_REGIONS de wall_service (verificado:
# el catálogo GEOFON es nuevo y wall_service todavía no lo conoce), así que
# el fixture ejerce OBLIGATORIAMENTE el camino "sin región mapeada". Sin
# ciudades así, un `continue` que las descarte en silencio pasa desapercibido.
GEOFON_SUBSET = {
    "trieste": ["MN.TRI..HHZ"],
    "kabul": ["GE.KBU..BHZ"],
    "casablanca": ["WM.AVE..HHZ"],
}


class TestSmokeTestWall:
    def test_smoke_test_layout_respeta_max_wall_channels_y_columns(self):
        """El criterio de aceptación de la tarea 4.4."""
        wall = build_smoke_test_wall(RTSERVE_SUBSET, GEOFON_SUBSET)

        # La función real, no un mock: si el layout no sirve, revienta acá.
        validate_wall_layout(wall["layout"])

        assert wall["name"] == SMOKE_TEST_WALL_NAME
        assert len(wall["layout"]["columns"]) <= MAX_WALL_COLUMNS

    def test_incluye_una_tira_por_ciudad_de_ambos_catalogos(self):
        """Una ciudad que no aparece es una ciudad que nadie va a mirar."""
        wall = build_smoke_test_wall(RTSERVE_SUBSET, GEOFON_SUBSET)

        scnls = {
            ch["channel"]
            for col in wall["layout"]["columns"]
            for grp in col["groups"]
            for ch in grp["channels"]
        }
        # El canal PRIMARIO de cada ciudad (el failover en vivo lo resuelve
        # live-channels por debajo, igual que en build_global_wall).
        esperados = {c[0] for c in RTSERVE_SUBSET.values()} | {
            c[0] for c in GEOFON_SUBSET.values()
        }
        assert scnls == esperados

    def test_mezcla_ambos_servidores_en_el_mismo_wall(self):
        """La 4.1 pide mezcla deliberada: rtserve Y GEOFON juntos."""
        wall = build_smoke_test_wall(RTSERVE_SUBSET, GEOFON_SUBSET)

        scnls = {
            ch["channel"]
            for col in wall["layout"]["columns"]
            for grp in col["groups"]
            for ch in grp["channels"]
        }
        assert "MN.TRI..HHZ" in scnls  # GEOFON
        assert "II.NNA.00.BHZ" in scnls  # rtserve

    def test_catalogos_vacios_no_producen_un_layout_invalido(self):
        """columns vacío revienta validate_wall_layout: mejor fallar claro acá."""
        with pytest.raises(ValueError):
            build_smoke_test_wall({}, {})


class TestRegionWalls:
    def test_cada_wall_de_region_pasa_la_validacion_real(self):
        walls = build_region_walls(RTSERVE_SUBSET, GEOFON_SUBSET)

        assert walls, "debe producir al menos un wall"
        for wall in walls:
            validate_wall_layout(wall["layout"])

    def test_no_pierde_ninguna_ciudad_entre_todos_los_walls(self):
        """El riesgo real del agrupamiento por región: una ciudad sin región
        cae en OTROS, no se descarta en silencio."""
        walls = build_region_walls(RTSERVE_SUBSET, GEOFON_SUBSET)

        scnls = {
            ch["channel"]
            for wall in walls
            for col in wall["layout"]["columns"]
            for grp in col["groups"]
            for ch in grp["channels"]
        }
        esperados = {c[0] for c in RTSERVE_SUBSET.values()} | {
            c[0] for c in GEOFON_SUBSET.values()
        }
        assert scnls == esperados

    def test_los_nombres_de_wall_salen_de_region_wall_names(self):
        walls = build_region_walls(RTSERVE_SUBSET, GEOFON_SUBSET)

        conocidos = set(REGION_WALL_NAMES.values())
        for wall in walls:
            assert wall["name"] in conocidos, f"nombre no mapeado: {wall['name']}"

    def test_ningun_wall_supera_el_limite_de_canales(self):
        """La 5.2 exige contar contra MAX_WALL_CHANNELS antes de cargar."""
        walls = build_region_walls(RTSERVE_SUBSET, GEOFON_SUBSET)

        for wall in walls:
            total = sum(
                len(grp["channels"])
                for col in wall["layout"]["columns"]
                for grp in col["groups"]
            )
            assert total <= MAX_WALL_CHANNELS, f"{wall['name']}: {total} canales"

    def test_una_region_que_excede_el_limite_falla_al_armar_no_al_insertar(self):
        """El guard de MAX_WALL_CHANNELS tiene que cortar ACÁ.

        El catálogo de hoy no se acerca a 120 canales, así que este límite
        solo se ejerce con un catálogo grande fabricado. Sin este test, subir
        o borrar el guard no rompe nada — y el fallo aparecería recién al
        insertar en producción, que es exactamente lo que se quiere evitar.
        """
        gigante = {
            f"city{i}": [f"XX.S{i:04d}..BHZ"] for i in range(MAX_WALL_CHANNELS + 5)
        }

        with pytest.raises(ValueError, match=r"máximo|desglosar"):
            build_region_walls(gigante, {})


class TestCatalogoCompletoReal:
    """Contra los catálogos REALES del código, no fixtures.

    Es el chequeo que la 5.2 pide hacer 'como cálculo, no como carga': si el
    catálogo completo produce un wall que supera los 120 canales, esto se
    pone rojo y obliga a desglosar REGION_WALL_NAMES antes del deploy.
    """

    def test_el_catalogo_real_produce_walls_validos(self):
        from src.services.spectrogram_service import (
            LIVE_CANDIDATES_BY_CITY,
            LIVE_CANDIDATES_GEOFON_BY_CITY,
        )

        walls = build_region_walls(
            LIVE_CANDIDATES_BY_CITY, LIVE_CANDIDATES_GEOFON_BY_CITY
        )
        assert walls
        for wall in walls:
            try:
                validate_wall_layout(wall["layout"])
            except InvalidWallLayoutError as exc:
                pytest.fail(
                    f"el catálogo real produce un wall inválido "
                    f"({wall['name']}): {exc}. Desglosar REGION_WALL_NAMES."
                )


def _walls_del_catalogo_real() -> list[dict]:
    from src.services.spectrogram_service import (
        LIVE_CANDIDATES_BY_CITY,
        LIVE_CANDIDATES_GEOFON_BY_CITY,
    )

    return build_region_walls(LIVE_CANDIDATES_BY_CITY, LIVE_CANDIDATES_GEOFON_BY_CITY)


@pytest.mark.parametrize(
    "wall", _walls_del_catalogo_real(), ids=lambda w: w["name"]
)
def test_full_catalog_layout_por_region_respeta_max_wall_channels(wall):
    """Tarea 5.3: un caso por wall temático final, con el catálogo REAL.

    Si esto falla para alguna región, la señal es que esa región necesita
    desglosarse en REGION_WALL_NAMES (retroalimenta a la 5.2) — no se ignora
    ni se sube el límite.
    """
    validate_wall_layout(wall["layout"])

    columns = wall["layout"]["columns"]
    assert len(columns) <= MAX_WALL_COLUMNS, (
        f"{wall['name']}: {len(columns)} columnas, máximo {MAX_WALL_COLUMNS}"
    )

    total = sum(len(g["channels"]) for col in columns for g in col["groups"])
    assert total <= MAX_WALL_CHANNELS, (
        f"{wall['name']}: {total} canales, máximo {MAX_WALL_CHANNELS}. "
        f"Desglosar esta región en REGION_WALL_NAMES."
    )


async def test_create_resuelve_el_dsn_de_la_instancia_de_settings(monkeypatch):
    """La rama real de conexión de _create, que el resto de la suite no pisa.

    Los imports de _create viven DENTRO de la función, así que 17 tests
    verdes y un --dry-run validado no la ejecutan nunca: el primer intento
    real en producción reventó con AttributeError porque el script importaba
    el MÓDULO src.config.settings en vez de la INSTANCIA (el mismo import
    que watchdog.py hace bien). Este test ejecuta _create de verdad, con la
    base reemplazada por un fake, y compara el DSN contra el de la instancia
    real — si el import vuelve a apuntar al módulo, esto revienta igual que
    producción.
    """
    import asyncpg

    from scripts.seed_thematic_walls import _create
    from src.config.settings import settings as real_settings

    captured = {}

    class _FakePool:
        async def close(self):
            captured["closed"] = True

    async def fake_create_pool(dsn, **kwargs):
        captured["dsn"] = dsn
        return _FakePool()

    monkeypatch.setattr(asyncpg, "create_pool", fake_create_pool)

    from uuid import UUID

    await _create([], UUID("00000000-0000-0000-0000-000000000001"))

    assert captured["closed"] is True
    assert captured["dsn"] == real_settings.timescaledb_dsn
