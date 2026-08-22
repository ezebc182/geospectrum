"""
Tests de `fetch_inpres_events`.

Este módulo es la otra punta del bug que dejó a INPRES apagado en producción
sin que nadie se enterara. Tenía dos problemas encadenados:

1. Sin `INPRES_PROXY_URL` devolvía `([], None)`. En el contrato de las fuentes
   `(eventos, error)`, un error `None` significa ÉXITO: el sistema informaba
   "INPRES funcionó, hubo 0 sismos" mientras la fuente estaba muerta.
2. La única forma de obtener datos era ese proxy, que apuntaba a un
   microservicio que **nadie desplegó nunca** — el adapter sólo corría bajo
   `if __name__ == "__main__"`.

Ahora el adapter se usa in-process: no hay servicio fantasma que desplegar. El
proxy sigue soportado por si algún día se configura uno.

Se testea con `INPRESAdapter` real y el HTTP mockeado con `pytest-httpx` (ya
pineado en requirements): lo que interesa verificar es el pegamento
service↔adapter, no volver a testear el parseo, que ya tiene sus propios tests.
"""

from pathlib import Path

import httpx
import pytest
from pytest_httpx import HTTPXMock

from src.adapters.inpres_adapter import SISMOS_XML_URL
from src.services.inpres_service import fetch_inpres_events

FIXTURE = Path(__file__).resolve().parents[1] / "fixtures" / "inpres_sismos.xml"

pytestmark = pytest.mark.asyncio

# Ventana amplísima: el fixture es una captura de agosto de 2026 y los eventos
# envejecen con el reloj real. Los tests de la ventana usan XML construido a
# medida, con timestamps relativos a "ahora".
VENTANA_ENORME = 60 * 24 * 365 * 50


@pytest.fixture
def xml_real() -> str:
    return FIXTURE.read_text(encoding="utf-8")


def item_xml(id_sismo: str, mag: str = "3.5", color: str = "000") -> str:
    return f"""
      <item>
        <idSismo>{id_sismo}</idSismo>
        <latitud>-31.163</latitud>
        <longitud>-68.357</longitud>
        <prof>104</prof>
        <mg>{mag}</mg>
        <prov>SAN JUAN</prov>
        <color_link>{color}</color_link>
      </item>
    """


def lista_xml(*items: str) -> str:
    return "<?xml version='1.0' encoding='UTF-8'?><lista>" + "".join(items) + "</lista>"


class TestFetchExitoso:
    async def test_devuelve_eventos_del_feed_sin_error(self, httpx_mock: HTTPXMock, xml_real):
        httpx_mock.add_response(status_code=200, text=xml_real)

        events, error = await fetch_inpres_events(VENTANA_ENORME)

        assert error is None
        assert len(events) == 30

    async def test_los_eventos_salen_marcados_como_inpres(self, httpx_mock: HTTPXMock, xml_real):
        httpx_mock.add_response(status_code=200, text=xml_real)

        events, _ = await fetch_inpres_events(VENTANA_ENORME)

        assert all(e.fuentes == ["INPRES"] for e in events)

    async def test_el_id_del_evento_es_estable_entre_llamadas(self, httpx_mock: HTTPXMock, xml_real):
        """
        Antes se generaba `uuid4()` en cada fetch: el mismo sismo era un evento
        distinto cada vez y el dedup no tenía de dónde agarrarse.
        """
        httpx_mock.add_response(status_code=200, text=xml_real)

        primera, _ = await fetch_inpres_events(VENTANA_ENORME)
        segunda, _ = await fetch_inpres_events(VENTANA_ENORME)

        assert [e.id for e in primera] == [e.id for e in segunda]


class TestVentanaTemporal:
    async def test_descarta_los_eventos_anteriores_a_la_ventana(self, httpx_mock: HTTPXMock):
        viejo = item_xml("20200101120000")
        httpx_mock.add_response(status_code=200, text=lista_xml(viejo))

        events, error = await fetch_inpres_events(60)

        assert error is None
        assert events == []


class TestFuenteCaida:
    """
    El punto del arreglo: una fuente caída NO puede parecer una fuente sin
    sismos. El contrato es `(eventos, error)` y `error=None` significa éxito.
    """

    async def test_un_500_devuelve_error_y_no_exito_vacio(self, httpx_mock: HTTPXMock):
        httpx_mock.add_response(status_code=500)

        events, error = await fetch_inpres_events(60)

        assert events == []
        assert error is not None
        assert "INPRES" in error

    async def test_un_timeout_devuelve_error(self, httpx_mock: HTTPXMock):
        httpx_mock.add_exception(httpx.TimeoutException("timeout"))

        events, error = await fetch_inpres_events(60)

        assert events == []
        assert error is not None
        assert "TIMEOUT" in error.upper()

    async def test_un_fallo_de_conexion_devuelve_error(self, httpx_mock: HTTPXMock):
        httpx_mock.add_exception(httpx.ConnectError("sin ruta"))

        events, error = await fetch_inpres_events(60)

        assert events == []
        assert error is not None

    async def test_un_cuerpo_que_no_es_xml_devuelve_error(self, httpx_mock: HTTPXMock):
        """Un portal cautivo o un 200 con HTML de error no es "cero sismos"."""
        httpx_mock.add_response(status_code=200, text="<html><body>Bad Gateway</body></html>")

        events, error = await fetch_inpres_events(60)

        assert events == []
        assert error is not None


class TestListaVaciaLegitima:
    async def test_un_feed_sin_sismos_es_exito_con_cero_eventos(self, httpx_mock: HTTPXMock):
        """Distinto de una fuente caída: acá SÍ corresponde error None."""
        httpx_mock.add_response(status_code=200, text=lista_xml())

        events, error = await fetch_inpres_events(60)

        assert events == []
        assert error is None
