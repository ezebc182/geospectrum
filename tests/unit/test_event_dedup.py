"""
Tests del dedupe de eventos en streaming (PR-W4, T3).

Qué se fija acá: que el worker no cree dos filas para el mismo sismo cuando
llega por USGS y por EMSC, y que una revisión posterior de EMSC actualice la
fila en vez de duplicarla.

El criterio (Δt ≤ 120 s, dist ≤ 30 km) es el MISMO de merge_service, y estos
tests lo verifican en los dos bordes: justo adentro y justo afuera. Si alguien
afloja el umbral en un lado y no en el otro, /report y el worker empezarían a
contar sismos distintos.
"""

import pytest

from src.models.event import SeismicEvent
from src.services.event_dedup import (
    MATCH_DISTANCE_KM,
    MATCH_WINDOW_SECONDS,
    canonical_id,
    find_duplicate,
    has_changes,
    is_same_event,
    merge_into,
)


def build_event(**overrides) -> SeismicEvent:
    """Evento base: M4.5 en el norte de Chile."""
    data = {
        "id": "usgs_us7000abcd",
        "fuentes": ["USGS"],
        "hora_utc": "2026-08-21T12:00:00Z",
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


class TestIsSameEvent:
    def test_el_mismo_sismo_por_dos_fuentes_matchea(self):
        usgs = build_event()
        # EMSC reporta el mismo sismo: 40 s después, 12 km corrido.
        emsc = build_event(
            id="emsc_1234567",
            fuentes=["EMSC"],
            hora_utc="2026-08-21T12:00:40Z",
            lat=-23.6,
            lon=-68.25,
            mag=4.7,
        )
        assert is_same_event(usgs, emsc) is True

    def test_dos_sismos_lejanos_en_el_tiempo_no_matchean(self):
        a = build_event()
        # 121 s: un segundo MÁS que la ventana. Borde de afuera.
        b = build_event(id="emsc_x", hora_utc="2026-08-21T12:02:01Z")
        assert is_same_event(a, b) is False

    def test_dos_sismos_lejanos_en_el_espacio_no_matchean(self):
        a = build_event()
        # Mismo instante, ~111 km al sur (1 grado de latitud).
        b = build_event(id="emsc_x", lat=-24.5)
        assert is_same_event(a, b) is False

    def test_el_borde_de_la_ventana_temporal_todavia_matchea(self):
        a = build_event()
        b = build_event(id="emsc_x", hora_utc="2026-08-21T12:02:00Z")
        assert abs(MATCH_WINDOW_SECONDS - 120.0) < 1e-9
        assert is_same_event(a, b) is True

    def test_una_hora_imparseable_no_matchea(self):
        """
        Preferimos un duplicado visible a fusionar dos sismos reales por un
        error de parseo. Un match silencioso perdería un evento.
        """
        a = build_event()
        b = build_event(id="emsc_x", hora_utc="no-es-una-fecha")
        assert is_same_event(a, b) is False

    def test_la_constante_de_distancia_es_la_de_merge_service(self):
        assert MATCH_DISTANCE_KM == 30.0


class TestCanonicalId:
    def test_conserva_el_id_de_la_fuente(self):
        """
        No se inventa un hash de lat/lon/hora: dos reportes del mismo sismo
        difieren justo en esos valores, así que el hash daría ids distintos
        para el mismo evento y no resolvería nada.
        """
        assert canonical_id(build_event()) == "usgs_us7000abcd"


class TestFindDuplicate:
    def test_encuentra_el_reporte_previo_del_mismo_sismo(self):
        persistido = build_event()
        entrante = build_event(
            id="emsc_1234567", fuentes=["EMSC"], hora_utc="2026-08-21T12:00:30Z"
        )
        assert find_duplicate(entrante, [persistido]) is persistido

    def test_devuelve_none_para_un_sismo_nuevo(self):
        persistido = build_event()
        otro = build_event(id="usgs_otro", lat=35.0, lon=139.0, lugar="Tokio")
        assert find_duplicate(otro, [persistido]) is None

    def test_el_mismo_id_matchea_aunque_los_datos_cambien(self):
        """
        EMSC revisa un evento y corrige el epicentro más de 30 km. Sin este
        atajo por id, la revisión entraría como sismo nuevo y duplicaría.
        """
        persistido = build_event(id="emsc_1234567", fuentes=["EMSC"])
        revision = build_event(
            id="emsc_1234567", fuentes=["EMSC"], lat=-25.0, lon=-70.0, revisado=True
        )
        assert find_duplicate(revision, [persistido]) is persistido

    def test_sin_candidatos_no_hay_duplicado(self):
        assert find_duplicate(build_event(), []) is None


class TestMergeInto:
    def test_conserva_el_id_del_persistido(self):
        """
        El id de la fila ya existente es la PK que se va a actualizar: si la
        fusión devolviera el id del entrante, el UPDATE no encontraría la fila
        y se insertaría un duplicado.
        """
        persistido = build_event()
        entrante = build_event(id="emsc_1234567", fuentes=["EMSC"])
        assert merge_into(persistido, entrante).id == "usgs_us7000abcd"

    def test_acumula_las_fuentes(self):
        fused = merge_into(build_event(), build_event(id="emsc_x", fuentes=["EMSC"]))
        assert fused.fuentes == ["EMSC", "USGS"]

    def test_gana_la_magnitud_mayor(self):
        """Criterio conservador heredado de merge_service."""
        fused = merge_into(build_event(mag=4.5), build_event(id="emsc_x", mag=5.1))
        assert fused.mag == 5.1

    def test_una_revision_marca_el_evento_como_revisado(self):
        fused = merge_into(
            build_event(revisado=False), build_event(id="emsc_x", revisado=True)
        )
        assert fused.revisado is True

    def test_sentido_es_verdadero_si_alguna_fuente_lo_marca(self):
        fused = merge_into(
            build_event(sentido=False), build_event(id="emsc_x", sentido=True)
        )
        assert fused.sentido is True


class TestHasChanges:
    def test_un_reenvio_identico_no_tiene_cambios(self):
        """
        EMSC reenvía el mismo evento sin cambios. Sin este chequeo, cada
        reenvío despertaría a todos los clientes conectados para nada.
        """
        persistido = build_event()
        fused = merge_into(persistido, build_event())
        assert has_changes(persistido, fused) is False

    def test_una_magnitud_corregida_si_es_un_cambio(self):
        persistido = build_event(mag=4.5)
        fused = merge_into(persistido, build_event(id="emsc_x", mag=5.1))
        assert has_changes(persistido, fused) is True

    def test_una_fuente_nueva_es_un_cambio(self):
        """
        Aunque los números no cambien: que un sismo esté confirmado por dos
        redes es información para el usuario.
        """
        persistido = build_event()
        fused = merge_into(persistido, build_event(id="emsc_x", fuentes=["EMSC"]))
        assert has_changes(persistido, fused) is True


class TestCriterioCompartidoConMergeService:
    """
    El worker y /report tienen que contar los mismos sismos. Si alguien afloja
    el umbral en un lado y no en el otro, las dos vistas divergen en silencio.
    """

    def test_los_umbrales_son_los_documentados_en_merge_service(self):
        import inspect

        from src.services import merge_service

        doc = inspect.getsource(merge_service.merge_events)
        assert "dt_sec <= 120 and dist_km <= 30" in doc
        assert MATCH_WINDOW_SECONDS == 120.0
        assert MATCH_DISTANCE_KM == 30.0
