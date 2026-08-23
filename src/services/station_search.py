"""Búsqueda de estaciones por código contra FDSN.

Complementa al catálogo estático (`station_catalog`, 75 candidatas de las 27
ciudades del muro): esto permite llegar a CUALQUIER estación del mundo que
FDSN conozca, que es lo que el helicorder puede dibujar igual — no depende de
la base ni del ingestor.

LIMITACIÓN VERIFICADA contra IRIS el 2026-08-23, no asumida:

    get_stations(station="*USC*")  -> 2 estaciones (CI.USC, BK.AUSC) en 1,3 s
    get_stations(station="MAJO")   -> 1 estación en 1,2 s
    get_stations(station="NEV*")   -> HTTP 204, sin datos
    get_stations(station="*NEV*")  -> HTTP 204, sin datos

FDSN filtra por el CÓDIGO de la estación, no por el nombre del sitio. El nombre
("Univ Southern Ca") viene en la respuesta pero no es filtrable. Por eso un
término como "nevado" no debe salir a la red: es una llamada de ~1,2 s con
cero resultados garantizados. El filtrado por nombre de ciudad se resuelve en
el cliente contra el catálogo, que sí tiene `city_id`.
"""

from typing import Any, Optional

# Preferencia de canal vertical para el SCNL que se ofrece al helicorder.
# El orden es por ancho de banda: BHZ (banda ancha) es lo que mejor rinde en
# una ventana de 24 h; SHZ (corto período) es el último recurso.
VERTICAL_CHANNEL_PREFERENCE = ("BHZ", "HHZ", "EHZ", "SHZ")

# Los códigos SEED de estación son de 1 a 5 caracteres alfanuméricos. Con 1
# solo carácter el wildcard `*X*` traería miles de estaciones y una espera
# inútil, así que el piso para salir a la red son 2.
MIN_CODE_LENGTH = 2
MAX_CODE_LENGTH = 5


def is_searchable_code(term: str) -> bool:
    """¿El término parece un código de estación que vale consultar en FDSN?

    Devuelve False para nombres de sitio ("nevado"), nombres de ciudad con
    espacios ("los angeles") y SCNL completos ("CI.USC..BHZ"): ninguno de esos
    da resultados en FDSN, y evitarlos ahorra ~1,2 s de espera por tecleo.
    """
    cleaned = term.strip()
    if not (MIN_CODE_LENGTH <= len(cleaned) <= MAX_CODE_LENGTH):
        return False
    return cleaned.isalnum()


def build_station_pattern(term: str) -> str:
    """Patrón FDSN para el término, sin pasarse de MAX_CODE_LENGTH caracteres.

    Los wildcards se agregan sólo si entran. Verificado contra IRIS el
    2026-08-23: el servidor valida el patrón COMPLETO contra el largo del
    código SEED (5), así que `*MAJO*` (6 caracteres) devuelve
    FDSNBadRequestException mientras que `MAJO*` (5) devuelve 3 estaciones.

    - "usc"   (3) -> "*USC*"  coincidencia interna: encuentra CI.USC y BK.AUSC
    - "majo"  (4) -> "MAJO*"  sólo prefijo: `*MAJO*` sería BadRequest
    - "R195D" (5) -> "R195D"  exacto: ya ocupa el largo máximo
    """
    code = term.strip().upper()
    espacio_libre = MAX_CODE_LENGTH - len(code)

    if espacio_libre >= 2:
        return f"*{code}*"
    if espacio_libre == 1:
        # Un solo wildcard: se elige sufijo (prefijo del código) porque quien
        # escribe "majo" busca MAJO, no una estación que lo contenga al final.
        return f"{code}*"
    return code


def _pick_vertical_channel(channels: list[str]) -> Optional[str]:
    """El mejor canal vertical disponible, o None si no hay ninguno."""
    available = {str(c).upper() for c in channels}
    for preferred in VERTICAL_CHANNEL_PREFERENCE:
        if preferred in available:
            return preferred
    return None


def normalize_fdsn_stations(raw_stations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Aplana la respuesta de ObsPy a dicts JSON-serializables con SCNL.

    Descarta las estaciones sin canal vertical usable: sin canal Z no hay
    helicorder que dibujar, y ofrecer el link sería mandar al usuario a un 404.

    Los numéricos se pasan por `float()` a propósito: ObsPy devuelve escalares
    de numpy, que pasan `isinstance(x, float)` pero revientan `json.dumps`
    (misma trampa que ya apareció en `build_waveform_response`).
    """
    normalized: list[dict[str, Any]] = []
    seen: set[str] = set()

    for station in raw_stations:
        channel = _pick_vertical_channel(station.get("channels") or [])
        if channel is None:
            continue

        network = str(station.get("network", ""))
        code = str(station.get("station", ""))
        # Location vacío: el endpoint de waveform lo resuelve con `*`.
        scnl = f"{network}.{code}..{channel}"
        if scnl in seen:
            continue
        seen.add(scnl)

        latitude = station.get("latitude")
        longitude = station.get("longitude")
        site_name = station.get("site_name")

        normalized.append(
            {
                "channel": scnl,
                "network": network,
                "station": code,
                "site_name": str(site_name) if site_name else None,
                "latitude": float(latitude) if latitude is not None else None,
                "longitude": float(longitude) if longitude is not None else None,
                "source_server": station.get("source_server"),
            }
        )

    return normalized
