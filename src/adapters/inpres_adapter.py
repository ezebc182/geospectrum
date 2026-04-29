"""
Adaptador/scraper para INPRES (Instituto Nacional de Prevención Sísmica).

INPRES publica sismos en: https://www.inpres.gob.ar/desktop/
Este adapter scrapea el HTML público y expone JSON normalizado.

NOTA PRODUCTIVA:
- INPRES no tiene API JSON oficial estable
- El scraping de HTML es frágil y puede romperse si cambia la estructura
- En producción ideal: INPRES debería proveer API, o mantener este adapter
  como servicio separado con monitoreo de cambios de estructura
"""
import httpx
import re
from typing import List, Dict, Optional
from bs4 import BeautifulSoup
from datetime import datetime, timezone, timedelta
import logging

logger = logging.getLogger(__name__)


class INPRESAdapter:
    """Scraper del sitio público de INPRES."""

    def __init__(self, timeout: float = 5.0):
        self.timeout = timeout
        self.base_url = "https://www.inpres.gob.ar"
        self.ultimos_url = f"{self.base_url}/desktop/"

    async def fetch_recent_events(self) -> List[Dict]:
        """
        Scrapea últimos eventos del sitio INPRES.

        Returns:
            Lista de dicts con formato:
            {
                "hora_utc": "2025-10-28T22:26:39+00:00",
                "lat": -31.875,
                "lon": -68.296,
                "prof_km": 108.0,
                "mag": 4.0,
                "mag_tipo": "ML",
                "lugar": "43 km SE de San Juan, Argentina",
                "revisado": true,
                "sentido": true
            }
        """
        try:
            async with httpx.AsyncClient(timeout=self.timeout, follow_redirects=True) as client:
                response = await client.get(self.ultimos_url)
                response.raise_for_status()
                html = response.text
        except Exception as e:
            logger.error(f"Error fetching INPRES: {e}")
            return []

        return self._parse_html(html)

    def _parse_html(self, html: str) -> List[Dict]:
        """
        Parsea HTML de INPRES y extrae eventos.

        Estructura típica (puede variar):
        - Tabla con filas de eventos
        - Columnas: Fecha/Hora, Latitud, Longitud, Profundidad, Magnitud, Región
        - Clasificación por color (azul/negro/rojo)

        ADVERTENCIA: Esta función es específica a la estructura actual del sitio.
        Si INPRES cambia el HTML, esto se rompe y necesita ajuste.
        """
        soup = BeautifulSoup(html, "html5lib")
        events: List[Dict] = []

        # Estrategia: buscar tabla principal de eventos
        # Esto es heurístico y puede necesitar ajuste según estructura real
        tables = soup.find_all("table")

        for table in tables:
            rows = table.find_all("tr")

            for row in rows:
                try:
                    event = self._parse_row(row)
                    if event:
                        events.append(event)
                except Exception as e:
                    # Row malformada → skip
                    continue

        logger.info(f"Parsed {len(events)} events from INPRES")
        return events

    def _parse_row(self, row) -> Optional[Dict]:
        """
        Parsea una fila de tabla INPRES.

        Formato esperado (aproximado):
        | Fecha Hora Local | Lat | Lon | Prof | Mag | Región | [Color] |

        Returns:
            Dict normalizado o None si no es evento válido
        """
        cols = row.find_all("td")
        if len(cols) < 6:
            return None

        # Intentar extraer datos
        try:
            # Fecha/hora local (típicamente col 0)
            fecha_hora_str = cols[0].get_text(strip=True)

            # Coordenadas (cols 1 y 2)
            lat_str = cols[1].get_text(strip=True)
            lon_str = cols[2].get_text(strip=True)

            # Profundidad (col 3)
            prof_str = cols[3].get_text(strip=True)

            # Magnitud (col 4)
            mag_str = cols[4].get_text(strip=True)

            # Región (col 5)
            region = cols[5].get_text(strip=True)

            # Clasificación (color del texto o background)
            # azul = preliminar, negro = revisado, rojo = sentido
            revisado, sentido = self._determine_status(row, cols)

            # Parsear valores
            lat = self._parse_coord(lat_str)
            lon = self._parse_coord(lon_str)
            prof_km = self._parse_float(prof_str)
            mag = self._parse_float(mag_str)

            if lat is None or lon is None or mag is None:
                return None

            # Convertir hora local Argentina (UTC-3) a UTC
            hora_utc = self._parse_datetime_local_to_utc(fecha_hora_str, -3)
            if not hora_utc:
                return None

            return {
                "hora_utc": hora_utc,
                "lat": lat,
                "lon": lon,
                "prof_km": prof_km,
                "mag": mag,
                "mag_tipo": "ML",  # INPRES típicamente usa ML
                "lugar": region,
                "revisado": revisado,
                "sentido": sentido,
            }

        except Exception as e:
            return None

    def _determine_status(self, row, cols) -> tuple[bool, bool]:
        """
        Intenta determinar si evento está revisado/sentido según color.

        Returns:
            (revisado, sentido)
        """
        # Heurística: buscar atributos de estilo o clase
        row_html = str(row)

        # Rojo = sentido y revisado
        if "red" in row_html.lower() or "rojo" in row_html.lower():
            return True, True

        # Negro = revisado pero no necesariamente sentido
        if "black" in row_html.lower() or "negro" in row_html.lower():
            return True, False

        # Azul o sin color específico = preliminar
        return False, False

    def _parse_coord(self, coord_str: str) -> Optional[float]:
        """
        Parsea coordenada geográfica.

        Formatos posibles:
        - "-31.875"
        - "31.875 S" (sur)
        - "68.296 O" (oeste)
        """
        coord_str = coord_str.replace(",", ".").strip()

        # Extraer número
        match = re.search(r"-?\d+\.?\d*", coord_str)
        if not match:
            return None

        value = float(match.group())

        # Ajustar signo según hemisferio
        if "S" in coord_str.upper() or "O" in coord_str.upper() or "W" in coord_str.upper():
            value = -abs(value)

        return value

    def _parse_float(self, s: str) -> Optional[float]:
        """Extrae float de string."""
        s = s.replace(",", ".").strip()
        match = re.search(r"-?\d+\.?\d*", s)
        if match:
            try:
                return float(match.group())
            except ValueError:
                return None
        return None

    def _parse_datetime_local_to_utc(
        self, dt_str: str, tz_offset_hours: int
    ) -> Optional[str]:
        """
        Convierte datetime local Argentina a UTC ISO.

        Formatos esperados:
        - "2025-10-28 19:26:39"
        - "28/10/2025 19:26:39"
        - etc.

        Args:
            dt_str: String fecha/hora local
            tz_offset_hours: Offset timezone (Argentina = -3)

        Returns:
            String ISO UTC o None si falla
        """
        dt_str = dt_str.strip()

        # Intentar varios formatos
        formats = [
            "%Y-%m-%d %H:%M:%S",
            "%d/%m/%Y %H:%M:%S",
            "%Y-%m-%d %H:%M",
            "%d/%m/%Y %H:%M",
        ]

        for fmt in formats:
            try:
                naive = datetime.strptime(dt_str, fmt)
                local_tz = timezone(timedelta(hours=tz_offset_hours))
                aware_local = naive.replace(tzinfo=local_tz)
                utc_dt = aware_local.astimezone(timezone.utc)
                return utc_dt.isoformat()
            except ValueError:
                continue

        return None


# =============================================================================
# FastAPI app del adapter (servicio separado)
# =============================================================================

if __name__ == "__main__":
    """
    Este adapter puede correr como microservicio separado.

    Uso:
        python -m src.adapters.inpres_adapter

    Expone:
        GET /recent → JSON con últimos eventos INPRES
    """
    from fastapi import FastAPI
    import uvicorn

    adapter_app = FastAPI(title="INPRES Adapter", version="1.0.0")
    adapter = INPRESAdapter()

    @adapter_app.get("/health")
    async def health():
        return "ok"

    @adapter_app.get("/recent")
    async def get_recent():
        """Retorna últimos eventos scraped de INPRES."""
        events = await adapter.fetch_recent_events()
        return events

    uvicorn.run(adapter_app, host="0.0.0.0", port=8001)
