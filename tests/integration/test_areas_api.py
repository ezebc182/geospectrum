"""Tests de integración de AOI-1 contra Postgres REAL (no mocks).

Por qué contra un motor de verdad: los mocks del proyecto validan que se llame
al pool, no que la query sea correcta. Son ciegos para un nombre de columna mal
escrito, un JOIN que no devuelve lo que uno cree o un cast que Postgres
rechaza — justamente la clase de bug que apareció en AOI-1 durante el
desarrollo. Estos tests corren sobre las migraciones 001-006 y el catálogo
sembrado (ver tests/integration/conftest.py).
"""
import pytest

from src.api.deps import get_current_user_optional
from src.services.area_service import (
    AreaNotFoundError,
    AreaService,
    DEFAULT_AREA_SLUG,
    SystemAreaNotEditableError,
)

pytestmark = pytest.mark.asyncio

# Polígono chico y convexo sobre Buenos Aires, para las áreas propias.
BUENOS_AIRES = {
    "type": "Polygon",
    "coordinates": [[[-59.0, -35.0], [-57.0, -35.0], [-57.0, -34.0], [-59.0, -34.0], [-59.0, -35.0]]],
}


@pytest.fixture
async def service(db_pool):
    return AreaService(db_pool)


@pytest.fixture
async def user_id(db_pool):
    """Un usuario cualquiera; AOI-1 autoriza por ownership, no por rol."""
    return await db_pool.fetchval(
        """
        INSERT INTO users (email, password_hash, role)
        VALUES ('aoi-test@example.com', 'x', 'viewer')
        RETURNING id
        """
    )


@pytest.fixture
async def other_user_id(db_pool):
    return await db_pool.fetchval(
        """
        INSERT INTO users (email, password_hash, role)
        VALUES ('aoi-other@example.com', 'x', 'viewer')
        RETURNING id
        """
    )


class TestSeedYPresets:
    async def test_el_catalogo_quedo_sembrado(self, db_pool):
        """Lo sembrado tiene que coincidir con el seed, área por área.

        El conteo se lee del JSON en vez de ir hardcodeado: con un número fijo,
        agregar un área al catálogo rompía este test sin que hubiera nada roto
        (pasó al sumar `cascadia`), y el arreglo era actualizar la constante, que
        no verifica nada. Comparar los slugs sí detecta lo que importa: un seed
        que quedó a medias o un área que no se cargó.
        """
        import json
        from pathlib import Path

        seed_path = (
            Path(__file__).resolve().parents[2]
            / "deploy"
            / "sql"
            / "seeds"
            / "areas_of_interest.json"
        )
        esperados = {a["slug"] for a in json.loads(seed_path.read_text())["areas"]}

        filas = await db_pool.fetch(
            "SELECT slug FROM areas_of_interest WHERE is_system"
        )
        sembrados = {fila["slug"] for fila in filas}

        assert sembrados == esperados

    async def test_existe_el_preset_por_defecto(self, service):
        area = await service.get_default()
        assert area.slug == DEFAULT_AREA_SLUG
        assert area.is_system is True

    async def test_el_default_es_global_y_cubre_el_mundo(self, service):
        """Regresión de la decisión de cambiar el default de Andes a global:
        un usuario de California no tiene por qué defaultear a los Andes."""
        area = await service.get_default()
        assert area.slug == "global"
        assert (area.bbox.minlat, area.bbox.maxlat) == (-90.0, 90.0)
        assert (area.bbox.minlon, area.bbox.maxlon) == (-180.0, 180.0)

    async def test_los_presets_traen_geometria_y_bbox_coherentes(self, service, user_id):
        """El bbox declarado tiene que contener a la geometría, o point_in_area
        descartaría en la etapa 1 eventos que sí están dentro del polígono."""
        from src.services.geo_filter import bbox_of

        # bbox_of devuelve un Bbox, que es un TypedDict: se accede por clave.
        for area in await service.list_for_user(user_id):
            derivado = bbox_of(area.geometry)
            assert area.bbox.minlat <= derivado["minlat"] + 1e-9, area.slug
            assert area.bbox.maxlat >= derivado["maxlat"] - 1e-9, area.slug
            assert area.bbox.minlon <= derivado["minlon"] + 1e-9, area.slug
            assert area.bbox.maxlon >= derivado["maxlon"] - 1e-9, area.slug


class TestOwnership:
    async def test_lista_incluye_presets_y_propias(self, service, user_id):
        creada = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        slugs = [a.slug for a in await service.list_for_user(user_id)]
        assert creada.slug in slugs
        assert DEFAULT_AREA_SLUG in slugs

    async def test_no_veo_las_areas_de_otro_usuario(self, service, user_id, other_user_id):
        ajena = await service.create(other_user_id, "Ajena", BUENOS_AIRES)
        ids = {a.id for a in await service.list_for_user(user_id)}
        assert ajena.id not in ids

    async def test_leer_un_area_ajena_da_not_found(self, service, user_id, other_user_id):
        """404 y no 403 a propósito: distinguirlos filtraría la existencia de
        áreas ajenas por diferencia de código de estado."""
        ajena = await service.create(other_user_id, "Ajena", BUENOS_AIRES)
        with pytest.raises(AreaNotFoundError):
            await service.get_visible(ajena.id, user_id)

    async def test_borrar_un_area_ajena_da_not_found(self, service, user_id, other_user_id):
        ajena = await service.create(other_user_id, "Ajena", BUENOS_AIRES)
        with pytest.raises(AreaNotFoundError):
            await service.delete(ajena.id, user_id)
        # Y sigue existiendo para su dueño: el borrado no ocurrió a medias.
        assert await service.get_visible(ajena.id, other_user_id) is not None

    async def test_no_se_puede_editar_un_preset_del_sistema(self, service, user_id):
        default = await service.get_default()
        with pytest.raises(SystemAreaNotEditableError):
            await service.update(default.id, user_id, name="Secuestrada")


class TestAreaActiva:
    async def test_sin_seleccion_devuelve_el_default(self, service, user_id):
        area, is_default = await service.get_active(user_id)
        assert is_default is True
        assert area.slug == DEFAULT_AREA_SLUG

    async def test_con_seleccion_devuelve_la_elegida(self, service, user_id):
        propia = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        await service.set_active(user_id, propia.id)
        area, is_default = await service.get_active(user_id)
        assert is_default is False
        assert area.id == propia.id

    async def test_borrar_el_area_activa_vuelve_al_default(self, service, user_id):
        """El FK es ON DELETE SET NULL: si no lo fuera, borrar el área activa
        dejaría al usuario apuntando a una fila inexistente."""
        propia = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        await service.set_active(user_id, propia.id)
        await service.delete(propia.id, user_id)

        area, is_default = await service.get_active(user_id)
        assert is_default is True
        assert area.slug == DEFAULT_AREA_SLUG

    async def test_set_active_none_vuelve_al_default(self, service, user_id):
        propia = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        await service.set_active(user_id, propia.id)
        await service.set_active(user_id, None)

        area, is_default = await service.get_active(user_id)
        assert is_default is True

    async def test_no_puedo_activar_un_area_ajena(self, service, user_id, other_user_id):
        ajena = await service.create(other_user_id, "Ajena", BUENOS_AIRES)
        with pytest.raises(AreaNotFoundError):
            await service.set_active(user_id, ajena.id)


class TestFiltroDeReporte:
    """El recorte de /report por área activa (commit 0435402).

    Ejercita build_report() con el área resuelta de la base real, sin tocar la
    red: las fuentes externas se mockean, el área NO. Lo que se prueba acá es
    el recorte y su efecto en KPIs, no el fetch.
    """

    async def _build(self, monkeypatch, eventos, area=None):
        from src.models.event import SeismicEvent
        from src.services import report_service

        async def fake_fetch(window, sources):
            return ([SeismicEvent(**e) for e in eventos], [], [], [])

        monkeypatch.setattr(report_service, "_fetch_parallel", fake_fetch)
        return await report_service.build_report(sources=["usgs"], area=area)

    @staticmethod
    def _evt(id_, lat, lon):
        return {
            "id": id_,
            "fuentes": ["USGS"],
            "hora_utc": "2026-07-29T12:00:00Z",
            "lat": lat,
            "lon": lon,
            "mag": 5.0,
        }

    async def test_sin_area_no_filtra_y_usa_el_bbox_de_settings(self, monkeypatch):
        """Regresión del contrato: area=None conserva el comportamiento previo,
        que es lo que mantiene a /events y /alerts sin cambios."""
        from src.config.settings import settings

        eventos = [self._evt("a", 35.6, 139.6), self._evt("b", -33.4, -70.6)]
        rep = await self._build(monkeypatch, eventos)
        assert len(rep.eventos) == 2
        assert rep.region_monitorizada == settings.bbox

    async def test_con_area_recorta_los_eventos(self, monkeypatch, service):
        from src.services.geo_filter import area_to_filter_dict

        japon = next(
            a for a in await service.list_for_user(
                await self._any_user(service)
            ) if a.slug == "japon"
        )
        eventos = [
            self._evt("tokio", 35.68, 139.65),      # dentro
            self._evt("santiago", -33.45, -70.67),  # fuera
            self._evt("seul", 37.57, 126.98),       # fuera
        ]
        rep = await self._build(monkeypatch, eventos, area_to_filter_dict(japon))
        assert [e.id for e in rep.eventos] == ["tokio"]

    async def test_los_kpis_se_calculan_sobre_lo_filtrado(self, monkeypatch, service):
        """El filtro va ANTES de compute_kpis_and_alerts: un reporte con 1
        evento y un total de 3 sería incoherente."""
        from src.services.geo_filter import area_to_filter_dict

        japon = next(
            a for a in await service.list_for_user(
                await self._any_user(service)
            ) if a.slug == "japon"
        )
        eventos = [
            self._evt("tokio", 35.68, 139.65),
            self._evt("santiago", -33.45, -70.67),
            self._evt("seul", 37.57, 126.98),
        ]
        rep = await self._build(monkeypatch, eventos, area_to_filter_dict(japon))
        assert rep.kpis.total_eventos == len(rep.eventos) == 1

    async def test_region_monitorizada_conserva_su_shape(self, monkeypatch, service):
        """dashboard/lib/types.ts y scripts/seismic-cli.py dependen de estas
        cuatro claves exactas: si cambian, se rompen los dos consumidores."""
        from src.services.geo_filter import area_to_filter_dict

        japon = next(
            a for a in await service.list_for_user(
                await self._any_user(service)
            ) if a.slug == "japon"
        )
        rep = await self._build(monkeypatch, [], area_to_filter_dict(japon))
        assert sorted(rep.region_monitorizada.keys()) == [
            "maxlat", "maxlon", "minlat", "minlon",
        ]
        assert rep.region_monitorizada == {
            "minlat": 30.0, "maxlat": 46.0, "minlon": 128.0, "maxlon": 148.0,
        }

    async def test_area_global_no_descarta_nada(self, monkeypatch, service):
        """Control: el default no debe recortar, o los anónimos perderían
        eventos sin haber elegido nada."""
        from src.services.geo_filter import area_to_filter_dict

        eventos = [
            self._evt("tokio", 35.68, 139.65),
            self._evt("santiago", -33.45, -70.67),
            self._evt("kiwi", -41.3, 174.8),
        ]
        rep = await self._build(
            monkeypatch, eventos, area_to_filter_dict(await service.get_default())
        )
        assert len(rep.eventos) == 3

    @staticmethod
    async def _any_user(service):
        """Los presets del sistema son visibles para cualquier usuario; se usa
        un UUID cualquiera sólo para poder listarlos."""
        from uuid import uuid4

        return uuid4()


class TestDegradacionSinAreaService:
    """REGRESIÓN: /report no debe caerse si el área no se puede resolver.

    Cuando /report pasó a personalizarse por área (commit 0435402) quedó
    dependiendo de app.state.auth_service y app.state.area_service. Ninguno de
    los dos tenía red: si faltaban, el AttributeError salía como HTTP 500 y un
    endpoint que era público y robusto se volvía frágil. Lo detectaron los
    test_report_* de test_api.py, que corren con un TestClient sin lifespan.

    El área es una PERSONALIZACIÓN: su falla degrada al reporte global, no
    tumba el monitoreo sísmico, que es la función principal del endpoint.
    """

    async def test_sin_auth_service_el_anonimo_no_explota(self):
        """Sin cookie no hace falta ningún service: get_current_user_optional
        tiene que cortar antes de tocar app.state."""
        from starlette.requests import Request

        scope = {"type": "http", "method": "GET", "path": "/report", "headers": []}
        user = await get_current_user_optional(Request(scope))
        assert user is None

    async def test_con_cookie_y_sin_auth_service_propaga_no_devuelve_none(self):
        """Con cookie SÍ hay que validar: si el service falta es un error de
        configuración del servidor y debe propagarse, NO disfrazarse de
        anónimo. Tragarse esto convertiría un 500 legítimo en 'sos anónimo',
        que es peor: esconde el problema."""
        from starlette.datastructures import State
        from starlette.requests import Request

        class _App:
            state = State()

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/report",
            "headers": [(b"cookie", b"session=cualquier-cosa")],
            "app": _App(),
        }
        with pytest.raises(AttributeError):
            await get_current_user_optional(Request(scope))

    # El escenario end-to-end (GET /report con app.state vacío => 200 y no
    # 500) NO se duplica acá: ya lo cubren los test_report_* de
    # tests/integration/test_api.py, que usan un TestClient sin lifespan y son
    # los que detectaron esta regresión en primer lugar. Un segundo test del
    # mismo camino sólo agregaría mantenimiento.


class TestAdaptadorDeFiltro:
    """area_to_filter_dict(): el bug que no falla ruidosamente.

    Si el bbox no llega PLANO, point_in_area lo recalcula por evento y el
    descarte barato de la etapa 1 sale más caro que la prueba exacta que
    existe para evitar. No rompe nada visible — por eso se testea.
    """

    async def test_expone_el_bbox_plano_que_espera_point_in_area(self, service):
        from src.services.geo_filter import area_to_filter_dict

        d = area_to_filter_dict(await service.get_default())
        for k in ("bbox_minlat", "bbox_maxlat", "bbox_minlon", "bbox_maxlon"):
            assert k in d, f"falta {k}: point_in_area recalcularía el bbox"
        assert isinstance(d["geometry"], dict)

    async def test_bbox_public_coincide_con_el_bbox_del_area(self, service):
        from src.services.geo_filter import area_to_filter_dict

        area = await service.get_default()
        d = area_to_filter_dict(area)
        assert d["bbox_public"] == {
            "minlat": area.bbox.minlat,
            "maxlat": area.bbox.maxlat,
            "minlon": area.bbox.minlon,
            "maxlon": area.bbox.maxlon,
        }


class TestCreacion:
    async def test_el_bbox_lo_deriva_el_service(self, service, user_id):
        """El cliente no puede declarar un bbox incoherente con su geometría."""
        area = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        assert (area.bbox.minlat, area.bbox.maxlat) == (-35.0, -34.0)
        assert (area.bbox.minlon, area.bbox.maxlon) == (-59.0, -57.0)

    async def test_el_area_creada_no_es_del_sistema(self, service, user_id):
        area = await service.create(user_id, "Mi zona", BUENOS_AIRES)
        assert area.is_system is False

    async def test_geometria_invalida_es_rechazada(self, service, user_id):
        from src.services.geo_filter import InvalidGeometryError

        with pytest.raises(InvalidGeometryError):
            await service.create(user_id, "Rota", {"type": "Point", "coordinates": [0, 0]})
