"""Búsqueda de estaciones: normalización del término y forma de la respuesta.

La consulta FDSN en sí (red) vive en SpectrogramService.search_stations_by_code
y no se testea acá: lo que se prueba es la lógica pura que decide QUÉ se le
pide a FDSN y cómo se devuelve, que es donde están los errores caros.

Verificado contra IRIS el 2026-08-23: FDSN filtra por CÓDIGO de estación, no
por nombre del sitio. `*USC*` devuelve 2 estaciones; `NEV*` y `*NEV*` devuelven
204. Por eso un término como "nevado" NO debe salir a la red — sería una
llamada de ~1,2 s garantizada a cero resultados.
"""

import pytest

from src.services.station_search import (
    build_station_pattern,
    is_searchable_code,
    normalize_fdsn_stations,
)


class TestIsSearchableCode:
    """Qué términos justifican una llamada a FDSN."""

    @pytest.mark.parametrize("term", ["USC", "usc", "MAJO", "R195D", "AB", "113A"])
    def test_codigos_plausibles_salen_a_la_red(self, term):
        assert is_searchable_code(term) is True

    @pytest.mark.parametrize(
        "term",
        [
            "nevado",  # nombre de sitio: FDSN no lo indexa (verificado, 204)
            "los angeles",  # tiene espacio: es una ciudad, no un código
            "a",  # 1 char: el wildcard traería medio mundo
            "",
            "   ",
            "CI.USC..BHZ",  # SCNL completo: no es un código de estación suelto
        ],
    )
    def test_terminos_que_no_son_codigo_no_salen_a_la_red(self, term):
        assert is_searchable_code(term) is False

    @pytest.mark.parametrize("term", ["US.", "U-C", "a b", "US*", "CI..", "u/c"])
    def test_rechaza_no_alfanumericos_aunque_midan_lo_justo(self, term):
        # Estos entran por longitud (2-5) pero traen puntos, guiones, espacios
        # o wildcards. Sin el chequeo alfanumérico se le mandaría a FDSN un
        # patrón como `*US.*`, que no es un código válido.
        #
        # Este caso existe porque una mutación lo destapó: al reemplazar el
        # `isalnum()` por `return True`, los 22 tests seguían en verde — todos
        # los negativos caían por longitud y la regla estaba sin cubrir.
        assert is_searchable_code(term) is False

    def test_el_limite_superior_son_cinco_caracteres(self):
        # Los códigos SEED de estación son de 5 caracteres como máximo.
        assert is_searchable_code("ABCDE") is True
        assert is_searchable_code("ABCDEF") is False


class TestBuildStationPattern:
    """El patrón COMPLETO (wildcards incluidos) no puede pasar de 5 caracteres.

    Verificado contra IRIS el 2026-08-23 aislando el parámetro:

        *USC*  (5) -> 3 estaciones      MAJO* (5) -> 3 estaciones
        *LON*  (5) -> 17 estaciones     *MAJO (5) -> 3 estaciones
        *MAJO* (6) -> FDSNBadRequestException
        *ABCD* (6) -> FDSNBadRequestException

    No es el `level` ni el `channel`: es la longitud. El código SEED de
    estación mide 5 como máximo y el servidor valida el patrón contra ese
    largo. Envolver todo en `*...*` a ciegas rompe cualquier término de 4+
    caracteres — que son la mayoría de los códigos reales.
    """

    def test_terminos_cortos_van_con_doble_wildcard(self):
        # `*USC*` encuentra CI.USC y también BK.AUSC (coincidencia interna).
        assert build_station_pattern("usc") == "*USC*"

    def test_termino_de_cuatro_va_con_un_solo_wildcard(self):
        # `*MAJO*` daría 6 caracteres -> BadRequest. `MAJO*` mide 5 y anda.
        assert build_station_pattern("majo") == "MAJO*"

    def test_termino_de_cinco_va_sin_wildcard(self):
        # Ya ocupa el largo máximo: cualquier wildcard lo pasaría de 5.
        assert build_station_pattern("R195D") == "R195D"

    def test_el_patron_nunca_excede_cinco_caracteres(self):
        # El invariante que importa, sobre todos los largos aceptados.
        for term in ["ab", "usc", "majo", "R195D"]:
            assert len(build_station_pattern(term)) <= 5, term

    def test_normaliza_a_mayusculas(self):
        assert build_station_pattern("usc") == "*USC*"
        assert build_station_pattern("majo") == "MAJO*"

    def test_recorta_espacios(self):
        assert build_station_pattern("  usc  ") == "*USC*"


class TestNormalizeFdsnStations:
    """La respuesta de ObsPy se aplana a dicts JSON-serializables.

    Un objeto Inventory no se serializa, y los escalares de numpy revientan
    json.dumps (misma lección que build_waveform_response).
    """

    def test_aplana_a_scnl_con_metadatos(self):
        raw = [
            {
                "network": "CI",
                "station": "USC",
                "channels": ["BHZ", "BHN"],
                "site_name": "Univ Southern Ca",
                "latitude": 34.01,
                "longitude": -118.28,
            }
        ]
        result = normalize_fdsn_stations(raw)

        assert len(result) == 1
        assert result[0]["channel"] == "CI.USC..BHZ"
        assert result[0]["network"] == "CI"
        assert result[0]["station"] == "USC"
        assert result[0]["site_name"] == "Univ Southern Ca"

    def test_prefiere_canal_de_banda_ancha_vertical(self):
        # Con varios canales hay que elegir uno para el SCNL. El helicorder
        # quiere el vertical de banda ancha: BHZ > HHZ > EHZ > SHZ.
        raw = [{"network": "X", "station": "S1", "channels": ["SHZ", "HHZ", "BHZ"]}]
        assert normalize_fdsn_stations(raw)[0]["channel"] == "X.S1..BHZ"

        raw = [{"network": "X", "station": "S2", "channels": ["SHZ", "EHZ"]}]
        assert normalize_fdsn_stations(raw)[0]["channel"] == "X.S2..EHZ"

    def test_descarta_estaciones_sin_canal_vertical_usable(self):
        # Sin canal Z no hay helicorder posible: no ofrecer un link roto.
        raw = [{"network": "X", "station": "S3", "channels": ["BHN", "BHE"]}]
        assert normalize_fdsn_stations(raw) == []

    def test_deduplica_por_scnl(self):
        raw = [
            {"network": "CI", "station": "USC", "channels": ["BHZ"]},
            {"network": "CI", "station": "USC", "channels": ["BHZ"]},
        ]
        assert len(normalize_fdsn_stations(raw)) == 1

    def test_tolera_campos_ausentes(self):
        # No todos los servidores FDSN devuelven site name ni coordenadas.
        raw = [{"network": "X", "station": "S4", "channels": ["BHZ"]}]
        result = normalize_fdsn_stations(raw)

        assert result[0]["site_name"] is None
        assert result[0]["latitude"] is None

    def test_los_valores_son_tipos_nativos_de_python(self):
        # Guardarraíl explícito: numpy.float64 pasa isinstance(x, float) pero
        # revienta json.dumps. Esta app ya se quemó con eso en el waveform.
        import json

        raw = [
            {
                "network": "CI",
                "station": "USC",
                "channels": ["BHZ"],
                "latitude": 34.01,
                "longitude": -118.28,
            }
        ]
        json.dumps(normalize_fdsn_stations(raw))  # no debe lanzar
