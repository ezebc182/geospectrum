"""
Tests del adapter de INPRES.

Contexto de por qué existen: hasta el 2026-08-22 este adapter no tenía UN SOLO
test, y no funcionaba. Scrapeaba una tabla HTML que llega vacía (INPRES la
rellena por JavaScript) buscando columnas que no existen en la página real, y
decidía si un sismo fue "sentido" preguntando si la subcadena "red" aparecía en
el HTML crudo de la fila — cualquier `border` o `credential` marcaba el sismo
como sentido y revisado.

Los datos vienen de `https://www.inpres.gob.ar/mapa/sismos.xml`, un XML
estructurado que el propio sitio consume. El fixture `inpres_sismos.xml` es una
captura REAL de ese endpoint (2026-08-22), no una invención: testear contra un
XML imaginado sería repetir exactamente el error que este trabajo corrige.

Las tres cosas que se fijan acá:

1. **`idSismo` es la hora UTC.** Los campos `fecha`/`hora` son hora local
   argentina y NO traen el año. Derivar el timestamp de ahí obliga a inferir el
   año y se rompe en el cambio de año y en cada cruce de medianoche.
2. **`color_link` se mapea por valor exacto**, con default preliminar. Ante un
   valor desconocido un monitor sísmico debe afirmar LO MENOS posible.
3. **Un XML roto no puede pasar por "no hubo sismos".** Silencio y cero eventos
   tienen que ser distinguibles.
"""

from pathlib import Path

import pytest

from src.adapters.inpres_adapter import INPRESAdapter

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "inpres_sismos.xml"


@pytest.fixture
def xml_real() -> str:
    """XML capturado del endpoint real de INPRES el 2026-08-22."""
    return FIXTURE.read_text(encoding="utf-8")


@pytest.fixture
def adapter() -> INPRESAdapter:
    return INPRESAdapter()


def build_xml(*items: str) -> str:
    """Arma un XML con los <item> que se le pasen."""
    return "<?xml version='1.0' encoding='UTF-8'?><lista>" + "".join(items) + "</lista>"


ITEM_COMPLETO = """
  <item>
    <idSismo>20260821205948</idSismo>
    <fecha>21/08</fecha>
    <hora>17:59</hora>
    <latitud>-29.567</latitud>
    <longitud>-67.561</longitud>
    <prof>115</prof>
    <mg>2.6</mg>
    <prov>LA RIOJA</prov>
    <link>"../mapa/20260821205948"</link>
    <color_link>000</color_link>
  </item>
"""


class TestParseoDelXmlReal:
    """Contra la captura real del endpoint, no contra un XML inventado."""

    def test_extrae_los_treinta_eventos_del_fixture(self, adapter, xml_real):
        events = adapter.parse_xml(xml_real)

        assert len(events) == 30

    def test_el_primer_evento_conserva_todos_los_campos(self, adapter, xml_real):
        primero = adapter.parse_xml(xml_real)[0]

        assert primero["lat"] == -29.567
        assert primero["lon"] == -67.561
        assert primero["prof_km"] == 115.0
        assert primero["mag"] == 2.6
        assert primero["lugar"] == "LA RIOJA"
        assert primero["mag_tipo"] == "ML"

    def test_las_coordenadas_del_fixture_caen_en_argentina_y_chile(self, adapter, xml_real):
        """
        Blindaje contra el bug de `_parse_coord`, que forzaba el signo con
        `-abs()` cuando encontraba una "O" o una "S" en el string. Todo el
        catálogo de INPRES está en el hemisferio sur y al oeste de Greenwich:
        una latitud positiva o una longitud fuera de rango delatan el parseo.
        """
        events = adapter.parse_xml(xml_real)

        assert all(-56.0 <= e["lat"] <= -20.0 for e in events)
        assert all(-76.0 <= e["lon"] <= -52.0 for e in events)


class TestHoraUtcDesdeIdSismo:
    """`idSismo` es YYYYMMDDHHMMSS en UTC — verificado contra el sitio real."""

    def test_convierte_id_sismo_a_iso_utc(self, adapter):
        events = adapter.parse_xml(build_xml(ITEM_COMPLETO))

        assert events[0]["hora_utc"] == "2026-08-21T20:59:48+00:00"

    def test_el_cruce_de_medianoche_no_retrocede_un_dia(self, adapter):
        """
        Caso real del fixture: idSismo 20260821004116 (00:41 UTC del 21) trae
        `fecha=20/08` y `hora=21:41`, que es la hora LOCAL del día anterior.
        Un parser que use fecha/hora local pone este sismo un día antes.
        """
        item = ITEM_COMPLETO.replace("20260821205948", "20260821004116").replace(
            "<fecha>21/08</fecha><hora>17:59</hora>", "<fecha>20/08</fecha><hora>21:41</hora>"
        )

        events = adapter.parse_xml(build_xml(item))

        assert events[0]["hora_utc"].startswith("2026-08-21T00:41:16")

    def test_el_id_sismo_se_conserva_como_identificador_estable(self, adapter):
        """
        Sin esto el service generaba `uuid4()` en cada fetch: el mismo sismo
        era un evento distinto en cada llamada, y el dedup no tenía de dónde
        agarrarse.
        """
        events = adapter.parse_xml(build_xml(ITEM_COMPLETO))

        assert events[0]["id_externo"] == "20260821205948"


class TestEstadoSegunColorLink:
    """
    Leyenda oficial del sitio:
      azul (00f) = determinado preliminarmente, "puede estar errado"
      negro (000) = revisado por un sismólogo
      rojo  (f00) = sentido, revisado por un sismólogo
    """

    @pytest.mark.parametrize(
        "color,revisado,sentido",
        [
            ("00f", False, False),
            ("000", True, False),
            ("f00", True, True),
        ],
    )
    def test_mapea_cada_color_a_su_estado(self, adapter, color, revisado, sentido):
        item = ITEM_COMPLETO.replace("<color_link>000</color_link>", f"<color_link>{color}</color_link>")

        evento = adapter.parse_xml(build_xml(item))[0]

        assert evento["revisado"] is revisado
        assert evento["sentido"] is sentido

    def test_un_color_desconocido_cae_en_preliminar(self, adapter):
        """
        El parser viejo devolvía (revisado=True, sentido=True) ante cualquier
        cosa que contuviera "red". El default correcto es el contrario: no
        afirmar que un sismo fue sentido por la población sin evidencia.
        """
        item = ITEM_COMPLETO.replace("<color_link>000</color_link>", "<color_link>abc</color_link>")

        evento = adapter.parse_xml(build_xml(item))[0]

        assert evento["revisado"] is False
        assert evento["sentido"] is False

    def test_sin_color_link_cae_en_preliminar(self, adapter):
        item = ITEM_COMPLETO.replace("<color_link>000</color_link>", "")

        evento = adapter.parse_xml(build_xml(item))[0]

        assert evento["revisado"] is False
        assert evento["sentido"] is False


class TestItemsInvalidos:
    """Un item roto se descarta; no debe tumbar los que sí están bien."""

    @pytest.mark.parametrize("campo", ["latitud", "longitud", "mg", "idSismo"])
    def test_descarta_el_item_al_que_le_falta_un_campo_esencial(self, adapter, campo):
        roto = ITEM_COMPLETO.replace(f"<{campo}>", "<x_>").replace(f"</{campo}>", "</x_>")

        events = adapter.parse_xml(build_xml(roto, ITEM_COMPLETO))

        assert len(events) == 1

    def test_descarta_el_item_con_numeros_no_parseables(self, adapter):
        roto = ITEM_COMPLETO.replace("<mg>2.6</mg>", "<mg>N/D</mg>")

        events = adapter.parse_xml(build_xml(roto, ITEM_COMPLETO))

        assert len(events) == 1

    def test_descarta_el_item_con_id_sismo_no_temporal(self, adapter):
        roto = ITEM_COMPLETO.replace("20260821205948", "sin-fecha")

        events = adapter.parse_xml(build_xml(roto, ITEM_COMPLETO))

        assert len(events) == 1

    @pytest.mark.parametrize(
        "id_malformado",
        [
            "2026082120594",  # 13 dígitos: le falta uno
            "202608212059",  # 12 dígitos: le faltan los segundos
            "2026082120594a",  # 14 caracteres pero uno no es dígito
            "",
        ],
    )
    def test_descarta_el_item_con_id_sismo_de_largo_incorrecto(self, adapter, id_malformado):
        """
        `strptime` con "%Y%m%d%H%M%S" NO exige dos dígitos por campo: acepta
        `2026082120594` (13 dígitos) y lo lee como 20:59:04, comiéndose el
        último dígito y corriendo la hora en silencio. Un id mal formado tiene
        que descartar el item, no colar un timestamp casi-correcto.
        """
        roto = ITEM_COMPLETO.replace("20260821205948", id_malformado)

        events = adapter.parse_xml(build_xml(roto, ITEM_COMPLETO))

        assert len(events) == 1
        assert events[0]["id_externo"] == "20260821205948"

    def test_la_profundidad_faltante_no_descarta_el_evento(self, adapter):
        """`prof_km` es opcional en el modelo: su ausencia no invalida el sismo."""
        sin_prof = ITEM_COMPLETO.replace("<prof>115</prof>", "")

        events = adapter.parse_xml(build_xml(sin_prof))

        assert len(events) == 1
        assert events[0]["prof_km"] is None


class TestXmlCorrupto:
    """
    Un XML ilegible NO puede confundirse con "no hubo sismos". Esa confusión
    es la que dejó a INPRES apagado en producción sin que nadie se enterara.
    """

    @pytest.mark.parametrize(
        "basura",
        ["", "   ", "<lista><item>", "no soy xml", "<html><body>502 Bad Gateway</body></html>"],
    )
    def test_el_xml_ilegible_levanta_error_en_vez_de_devolver_vacio(self, adapter, basura):
        with pytest.raises(ValueError):
            adapter.parse_xml(basura)

    def test_una_lista_legitimamente_vacia_devuelve_cero_eventos(self, adapter):
        """Sin sismos recientes es un resultado válido, no un error."""
        events = adapter.parse_xml(build_xml())

        assert events == []


class TestXmlMalicioso:
    """
    El feed viene de un tercero por HTTP: hay que tratarlo como entrada hostil.

    Verificado en Python 3.12: el parser de la stdlib bloquea las entidades
    EXTERNAS (XXE) pero expande las internas, así que una bomba de entidades
    llega a agotar la memoria del proceso. De ahí `defusedxml`.
    """

    def test_rechaza_una_bomba_de_entidades(self, adapter):
        bomba = (
            '<?xml version="1.0"?><!DOCTYPE lolz ['
            '<!ENTITY lol "lol">'
            '<!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;">'
            '<!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">'
            "]><lista>&lol3;</lista>"
        )

        with pytest.raises(ValueError, match="seguridad"):
            adapter.parse_xml(bomba)

    def test_rechaza_una_entidad_externa(self, adapter):
        """XXE: leer un archivo del disco o disparar una request desde el server."""
        xxe = (
            '<?xml version="1.0"?>'
            '<!DOCTYPE d [<!ENTITY x SYSTEM "file:///etc/passwd">]>'
            "<lista>&x;</lista>"
        )

        with pytest.raises(ValueError):
            adapter.parse_xml(xxe)
