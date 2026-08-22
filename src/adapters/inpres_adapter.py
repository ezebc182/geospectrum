"""
Adaptador para INPRES (Instituto Nacional de Prevención Sísmica, Argentina).

INPRES publica sus sismos en `https://www.inpres.gob.ar/mapa/sismos.xml`, un XML
estructurado que el propio sitio consume: la tabla de
`https://www.inpres.gob.ar/desktop/` llega VACÍA por HTTP y se rellena en el
navegador con ese XML. Por eso acá no hay scraping de HTML — no habría nada que
scrapear, y el XML además trae latitud y longitud, que la tabla ni siquiera
publica.

Formato de cada `<item>`:

    idSismo    20260821205948   timestamp UTC YYYYMMDDHHMMSS (identificador estable)
    fecha      21/08            hora LOCAL argentina, sin año
    hora       17:59            idem
    latitud    -29.567
    longitud   -67.561
    prof       115              km
    mg         2.6              magnitud (INPRES usa ML)
    prov       LA RIOJA         región
    color_link 000              estado del evento (ver COLOR_TO_STATUS)

El timestamp sale de `idSismo` y no de `fecha`/`hora`: esos dos son hora local
y no traen el año, así que habría que inferirlo — y la inferencia se rompe en
cada cruce de medianoche y en el cambio de año. `idSismo` ya viene en UTC.
"""

import logging
from datetime import datetime, timezone
from typing import Dict, List, Optional
from xml.etree.ElementTree import Element  # sólo el tipo; el parseo va por defusedxml

import httpx
from defusedxml import ElementTree as ET
from defusedxml.common import DefusedXmlException

logger = logging.getLogger(__name__)

SISMOS_XML_URL = "https://www.inpres.gob.ar/mapa/sismos.xml"

# Largo exacto de `idSismo`: YYYYMMDDHHMMSS.
ID_SISMO_LEN = 14

# Leyenda oficial publicada por INPRES:
#   azul  = "Sismo determinado preliminarmente" + "pueden estar errados"
#   negro = "Sismo revisado por un sismólogo"
#   rojo  = "Sismo sentido revisado por un sismólogo"
COLOR_TO_STATUS: Dict[str, tuple[bool, bool]] = {
    "00f": (False, False),  # azul  → preliminar
    "000": (True, False),   # negro → revisado, no sentido
    "f00": (True, True),    # rojo  → revisado y sentido
}

# Ante un color desconocido no se afirma que el sismo fue sentido por la
# población: un monitor sísmico, en la duda, informa lo MENOS posible.
STATUS_DESCONOCIDO = (False, False)


class INPRESAdapter:
    """Cliente del feed XML de INPRES."""

    def __init__(self, timeout: float = 5.0, url: str = SISMOS_XML_URL):
        self.timeout = timeout
        self.url = url

    async def fetch_recent_events(self) -> List[Dict]:
        """
        Descarga y parsea los últimos eventos publicados por INPRES.

        Raises:
            httpx.HTTPError: la descarga falló (timeout, conexión, status >= 400)
            ValueError: el cuerpo no es un XML de sismos legible

        Los errores se propagan a propósito. Devolver `[]` ante un fallo haría
        indistinguible "INPRES está caído" de "no hubo sismos", que es
        exactamente cómo esta fuente terminó apagada en producción sin que
        nadie se enterara.
        """
        async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
            response = await client.get(self.url)
            response.raise_for_status()
            body = response.text

        events = self.parse_xml(body)
        logger.info("INPRES: %d eventos parseados", len(events))
        return events

    def parse_xml(self, xml_text: str) -> List[Dict]:
        """
        Parsea el XML de INPRES a dicts normalizados.

        Un `<item>` inválido se descarta sin tumbar al resto: el feed es de un
        tercero y una fila rota no puede costarnos los otros 29 sismos. En
        cambio un XML entero ilegible SÍ levanta, porque no es un caso de dato
        faltante sino de fuente rota.
        """
        try:
            root = ET.fromstring(xml_text)
        except DefusedXmlException as e:
            # XML malicioso (bomba de entidades / entidad externa). Se registra
            # como advertencia porque no es un feed roto: es un ataque.
            logger.warning("INPRES: XML rechazado por defusedxml: %s", type(e).__name__)
            raise ValueError(f"INPRES: XML rechazado por seguridad: {type(e).__name__}") from e
        except ET.ParseError as e:
            raise ValueError(f"INPRES: XML ilegible: {e}") from e

        if root.tag != "lista":
            raise ValueError(f"INPRES: se esperaba <lista>, llegó <{root.tag}>")

        events: List[Dict] = []
        for item in root.findall("item"):
            event = self._parse_item(item)
            if event:
                events.append(event)

        return events

    def _parse_item(self, item: Element) -> Optional[Dict]:
        """Normaliza un `<item>`; devuelve None si le falta algo esencial."""
        id_sismo = (item.findtext("idSismo") or "").strip()
        hora_utc = self._id_sismo_to_utc(id_sismo)

        lat = self._parse_float(item.findtext("latitud"))
        lon = self._parse_float(item.findtext("longitud"))
        mag = self._parse_float(item.findtext("mg"))

        if hora_utc is None or lat is None or lon is None or mag is None:
            logger.debug("INPRES: item descartado (idSismo=%r)", id_sismo)
            return None

        revisado, sentido = self._parse_status(item.findtext("color_link"))
        lugar = (item.findtext("prov") or "").strip() or None

        return {
            "id_externo": id_sismo,
            "hora_utc": hora_utc,
            "lat": lat,
            "lon": lon,
            "prof_km": self._parse_float(item.findtext("prof")),
            "mag": mag,
            "mag_tipo": "ML",
            "lugar": lugar,
            "revisado": revisado,
            "sentido": sentido,
        }

    @staticmethod
    def _id_sismo_to_utc(id_sismo: str) -> Optional[str]:
        """
        `20260821205948` → `2026-08-21T20:59:48+00:00`.

        El largo se valida ANTES de `strptime` porque `%Y%m%d%H%M%S` no exige
        dos dígitos por campo: con `202608212059` (le faltan los segundos)
        no falla, lee `2059` como `20:5x` y devuelve 20:05:09 — 54 minutos
        corrido, en silencio. Un id mal formado tiene que descartar el evento,
        no colar una hora casi-correcta.
        """
        if len(id_sismo) != ID_SISMO_LEN or not id_sismo.isdigit():
            return None

        try:
            dt = datetime.strptime(id_sismo, "%Y%m%d%H%M%S")
        except ValueError:
            return None

        return dt.replace(tzinfo=timezone.utc).isoformat()

    @staticmethod
    def _parse_status(color_link: Optional[str]) -> tuple[bool, bool]:
        """Traduce `color_link` a `(revisado, sentido)`."""
        if not color_link:
            return STATUS_DESCONOCIDO

        return COLOR_TO_STATUS.get(color_link.strip().lower(), STATUS_DESCONOCIDO)

    @staticmethod
    def _parse_float(raw: Optional[str]) -> Optional[float]:
        """
        Convierte a float o devuelve None.

        No se "rescatan" números de strings sucios con una regex: en el feed de
        INPRES los valores vienen limpios, y adivinar un número dentro de un
        texto inesperado es cómo se cuelan datos incorrectos en un monitor
        sísmico. Si no es un float, el item se descarta.
        """
        if raw is None:
            return None

        try:
            return float(raw.strip().replace(",", "."))
        except ValueError:
            return None
