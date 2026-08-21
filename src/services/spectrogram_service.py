"""
Servicio para obtener datos de ondas sísmicas desde FDSN y generar espectrogramas
Usa ObsPy para procesar datos reales de estaciones sísmicas
"""

import io
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from typing import Optional, Dict, List
import logging

import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
import matplotlib

matplotlib.use("Agg")  # Backend sin GUI
import matplotlib.pyplot as plt
from src.services.swarm_spectra import MAX_POWER_DB, MIN_POWER_DB, swarm_spectrogram_db

logger = logging.getLogger(__name__)

# Thread pool para operaciones bloqueantes de ObsPy
_executor = ThreadPoolExecutor(max_workers=4)

# Mapeo de códigos de red por país/región
NETWORK_CODES = {
    "US": "US",  # United States National Network
    "CI": "CI",  # California Integrated Seismic Network
    "NC": "NC",  # Northern California Seismic Network
    "UW": "UW",  # Pacific Northwest Seismic Network
    "AK": "AK",  # Alaska Seismic Network
    "JP": "JP",  # Japanese National Network
    "CL": "C",  # Chile National Network
    "PE": "PE",  # Peru National Network
    "NZ": "NZ",  # GeoNet New Zealand
    "TW": "TW",  # Taiwan Seismic Network
    "TU": "TU",  # Turkish National Network
    "IR": "IR",  # Iranian Seismic Network
}

# Canales SEED completos (con location code) para las ciudades que además
# tienen streaming en vivo vía SeedLink (ver src/services/seedlink_ingestor.py,
# DEFAULT_CHANNELS). El location code no se puede derivar de antemano —
# ObsPy lo resuelve recién con el primer paquete real — así que estos valores
# están verificados contra la red real. city_id debe coincidir con
# dashboard/lib/seismic-cities.ts.
#
# Cómo se armó esta lista (2026-08-03, ampliación de 3 a 26 ciudades)
# -------------------------------------------------------------------
# NO se escribió a mano. El precedente de KNOWN_STATIONS abajo muestra por qué:
# las estaciones originales (JP.TNPH, C.GO01, PE.LIMA…) devolvían HTTP 204
# porque alguien las dedujo del código de país en vez de consultarlas.
#
# El procedimiento fue, para cada ciudad de seismic-cities.ts:
#   1. `Client("rtserve.earthscope.org").get_info(level="station")` → las 4326
#      estaciones que el servidor SeedLink de EarthScope transmite en vivo.
#   2. FDSN `get_stations(maxradius=3°, channel="BHZ,HHZ")` → las estaciones de
#      banda ancha cercanas, con sus coordenadas reales.
#   3. Intersección de las dos, ordenada por distancia a la ciudad.
#   4. `get_waveforms()` sobre la más cercana: si devuelve muestras, el canal
#      sirve, y el location code sale de `trace.stats.location`.
#
# El paso 4 no es opcional: 4 estaciones que figuraban en el catálogo del
# servidor NO transmitían (CM.RUS, UW.SEA, KO.BALB, NU.MASN). Estar listado y
# estar emitiendo son cosas distintas.
#
# Los tres formatos de location code que aparecen abajo —"00", "10" y vacío—
# son reales y salieron del paso 4. Adivinarlos es justamente lo que rompe.
#
# Ausencias conocidas (re-verificadas 2026-08-20):
#   - manila y jakarta: sin estación en vivo a menos de 333 km.
#   - tehran: IRIS no devuelve inventario para esa zona (FDSN 204).
#   - istanbul: la más cercana que transmite (HT.ALN, Alexandroupoli) está a
#     247 km. Sirve para sismicidad regional, no para eventos locales de la
#     falla Norte de Anatolia.
# Candidatas por ciudad, en orden de preferencia (primaria primero). Las
# estaciones se caen de a una y perseguir a la "viva de hoy" editando el
# catálogo es un juego perdido: el failover lo resuelve resolve_live_catalog
# contra las columnas frescas de TimescaleDB. Toda candidata nueva se agrega
# VERIFICADA contra rtserve (INFO + get_waveforms), nunca desde el mapa FDSN.
# Respaldos verificados el 2026-08-20 contra rtserve (get_waveforms con
# muestras y lag < 90s). Primarias promovidas solo con mejora dramática:
# valparaiso (VA01 a 4 km vs 50), portauprince (PAPH1 a 3,7 km vs 116),
# istanbul (ALN a 247 km vs 388), managua (NANN a 26 km vs 72) y santiago
# (MT18 llevaba >12h muda; queda última como candidata histórica).
LIVE_CANDIDATES_BY_CITY: Dict[str, List[str]] = {
    # Asia-Pacífico
    "tokyo": ["JP.JYT..BHZ", "IU.MAJO.00.BHZ", "JP.JSG..BHZ"],
    "osaka": ["JP.JWT..BHZ", "PS.INU..BHZ", "G.INU.00.BHZ"],
    "taipei": ["IU.TATO.00.BHZ", "TW.YHNB..BHZ", "TW.NACB..BHZ"],
    "guam": ["IU.GUMO.00.BHZ", "MI.FLX..BHZ"],
    "kathmandu": ["NK.KKN..BHZ", "IO.EVN..BHZ"],
    # Sudamérica
    "lima": ["II.NNA.00.BHZ"],
    "arequipa": ["C1.AP01..BHZ"],
    "santiago": ["C1.MT05..BHZ", "C1.MT14..BHZ", "C1.MT16..BHZ", "C1.MT18..BHZ"],
    "valparaiso": ["C1.VA01..BHZ", "C1.MT02..BHZ", "C1.VA06..BHZ"],
    "antofagasta": ["C.GO02..BHZ", "C1.AF02..BHZ", "C1.AF01..BHZ"],
    "quito": ["EC.PULU..HHZ", "EC.ANTS..HHZ", "EC.SLOR..HHZ"],
    # CM.RUS revivió: en julio no transmitía (por eso Bogotá no estaba) y el
    # 20/8 verificó con lag 25s. La cobertura es regional (170 km).
    "bogota": ["CM.RUS.00.HHZ", "CM.HEL.00.HHZ"],
    # Centroamérica y Caribe
    "mexicocity": ["G.UNM.00.BHZ", "MG.TXMV..HHZ", "MX.TLIG..BHZ"],
    "sanjose": ["G.HDC.00.BHZ", "TC.TCS1..HHZ", "OV.VPCC..HHZ"],
    "managua": ["NU.NANN..HHZ", "GE.BOAB..BHZ", "OV.VRBA..HHZ"],
    "portauprince": ["AY.PAPH1..HHZ", "CU.SDDR.00.BHZ", "ZC.JIDR..BHZ"],
    # Norteamérica
    "losangeles": ["CI.USC..BHZ", "CI.PASC.00.BHZ", "CI.DJJ..BHZ"],
    # Barrett (46 km de San Diego): la red AZ entera no existe en
    # rtserve.earthscope.org — AZ.SIO5 nunca transmitió ni una columna.
    # Verificado 2026-08-19 con INFO + get_waveforms contra el servidor real.
    # BAR es intermitente (viva el 19/8, muda el 20/8): por eso los respaldos.
    "sandiego": ["CI.BAR..BHZ", "CI.PLM..BHZ", "CI.MUR..BHZ"],
    "sanfrancisco": ["BK.MCCM.00.BHZ", "BK.SAO.00.BHZ", "BK.CMB.00.BHZ"],
    "portland": ["UO.PF27..HHZ", "UO.COOPR..HHZ", "UO.GRESH..HHZ"],
    "seattle": ["UW.LON..HHZ", "UW.SP2..HHZ", "UW.MORSE..HHZ"],
    "vancouver": ["CN.QEPB..HHZ", "CN.BOIB..HHZ", "CN.GOBB..HHZ"],
    "anchorage": ["AK.RC01..BHZ", "AK.FIRE..BHZ", "AT.PMR..BHZ"],
    # Europa / Mediterráneo
    "istanbul": ["HT.ALN..HHZ", "GE.TIRR..BHZ", "HL.RDO..HHZ"],
    # Oceanía
    "wellington": ["IU.SNZO.00.BHZ", "NZ.BFZ.10.HHZ", "NZ.KHZ.10.HHZ"],
    "auckland": ["NZ.HIZ.10.HHZ", "NZ.OUZ.10.HHZ", "NZ.URZ.10.HHZ"],
    "christchurch": ["NZ.KHZ.10.HHZ", "NZ.RPZ.10.HHZ", "NZ.ODZ.10.HHZ"],
}

def resolve_live_catalog(
    candidates_by_city: Dict[str, List[str]], active_channels: Optional[set]
) -> List[Dict[str, str]]:
    """Resuelve el canal vivo de cada ciudad entre sus candidatas.

    Perseguir a la estación "viva de hoy" editando el catálogo es un juego
    perdido (CI.BAR transmitía el 19/8 y estaba muda el 20/8): cada ciudad
    lista candidatas VERIFICADAS en orden de preferencia y gana la primera
    con columnas frescas en TimescaleDB.

    `active_channels=None` significa "no se pudo consultar la base": se
    devuelve la primaria de cada ciudad — mejor ofrecer de más que esconder
    canales que sí transmiten. Un set vacío es una respuesta real ("nada
    fresco") y no devuelve ninguna ciudad.
    """
    result = []
    for city_id, candidates in candidates_by_city.items():
        if active_channels is None:
            chosen = candidates[0] if candidates else None
        else:
            chosen = next((c for c in candidates if c in active_channels), None)
        if chosen is not None:
            result.append({"city_id": city_id, "channel": chosen})
    return result


def station_catalog(
    candidates_by_city: Dict[str, List[str]], active_channels: Optional[set]
) -> List[Dict[str, object]]:
    """Catálogo COMPLETO de subestaciones: una entrada por candidata.

    resolve_live_catalog devuelve la ganadora de cada ciudad (lo que el
    dashboard consume por default); esto expone las 75 que el ingestor
    realmente está ingestando, para que el usuario elija subestación como
    en SWARM (comparar MT05 vs MT14 de Santiago, por ejemplo).

    `is_live` es informativo: una candidata muda se ofrece igual, con el
    badge en gris. active_channels=None ("no se pudo consultar la base",
    misma semántica que resolve_live_catalog) no marca nada como vivo en
    vez de mentir.
    """
    catalog: List[Dict[str, object]] = []
    for city_id, candidates in candidates_by_city.items():
        for index, channel in enumerate(candidates):
            parts = channel.split(".")
            catalog.append(
                {
                    "channel": channel,
                    "city_id": city_id,
                    "network": parts[0] if len(parts) > 0 else "",
                    "station": parts[1] if len(parts) > 1 else "",
                    "is_live": bool(active_channels) and channel in active_channels,
                    "is_primary": index == 0,
                }
            )
    return catalog


class SpectrogramService:
    """Servicio para generar espectrogramas desde datos FDSN"""

    # Lista de servidores FDSN con sus características (ordenados por confiabilidad)
    FDSN_SERVERS = [
        {
            "name": "IRIS",
            "coverage": "global",
            "priority": 1,
        },  # IRIS DMC - Más confiable y completo
        {"name": "USGS", "coverage": "global", "priority": 2},  # US Geological Survey
        {
            "name": "GEOFON",
            "coverage": "global",
            "priority": 3,
        },  # GFZ Potsdam - Bueno para Europa/Asia
        {"name": "ORFEUS", "coverage": "europe", "priority": 4},  # ORFEUS - Europa
        {"name": "RESIF", "coverage": "europe", "priority": 5},  # RESIF - Francia/Europa
        {"name": "INGV", "coverage": "mediterranean", "priority": 6},  # INGV - Italia/Mediterráneo
    ]

    # Estaciones pre-configuradas para ciudades importantes (para acelerar búsqueda)
    # Verificadas contra IRIS (get_waveforms, ventana 24h) el 2026-07-08.
    # Las originales (JP.TNPH, JP.TKSB, C.GO01, C1.PB01, PE.LIMA, NZ.WEL, MX.PPIG, etc.)
    # no devolvían datos (HTTP 204) — estaciones dadas de baja o códigos incorrectos.
    KNOWN_STATIONS = {
        # Japón - red GSN (IU) e II, más confiables que la red nacional JP en IRIS
        "tokyo": [
            {"network": "IU", "station": "MAJO", "channel": "BHZ"},
            {"network": "IU", "station": "TATO", "channel": "BHZ"},
        ],
        "osaka": [{"network": "II", "station": "ERM", "channel": "BHZ"}],
        # USA - USGS/IRIS excelente cobertura
        # NOTA: los IDs deben coincidir con dashboard/lib/seismic-cities.ts (sin guión bajo)
        "losangeles": [
            {"network": "CI", "station": "USC", "channel": "BHZ"},
            {"network": "AZ", "station": "FRD", "channel": "BHZ"},
        ],
        "sanfrancisco": [
            {"network": "BK", "station": "CMB", "channel": "BHZ"},
            {"network": "BK", "station": "SAO", "channel": "BHZ"},
        ],
        "seattle": [{"network": "UW", "station": "LON", "channel": "HHZ"}],
        # Chile - Red nacional
        "santiago": [
            {"network": "C1", "station": "CO01", "channel": "HHZ"},
            {"network": "IU", "station": "LCO", "channel": "BHZ"},
        ],
        # Perú - II.NNA (verificado, reemplaza al IU.NNA original que fallaba)
        "lima": [{"network": "II", "station": "NNA", "channel": "BHZ"}],
        "arequipa": [{"network": "BV", "station": "SOEP", "channel": "EHZ"}],
        # Nueva Zelanda - GeoNet (vía IU/GSN, la red nacional NZ no respondía)
        "wellington": [{"network": "IU", "station": "SNZO", "channel": "BHZ"}],
        "christchurch": [{"network": "IU", "station": "SNZO", "channel": "BHZ"}],
        "auckland": [{"network": "NZ", "station": "BKZ", "channel": "HHZ"}],
        # México
        "mexicocity": [
            {"network": "IU", "station": "TEIG", "channel": "BHZ"},
            {"network": "G", "station": "UNM", "channel": "BHZ"},
        ],
        # Resto de ciudades de alto riesgo (dashboard/lib/seismic-cities.ts).
        # Sin estación verificada con datos recientes -> quedan en fallback sintético:
        # manila, jakarta, tehran, valparaiso.
        "taipei": [{"network": "IU", "station": "TATO", "channel": "BHZ"}],
        "quito": [{"network": "EC", "station": "ANTS", "channel": "HHZ"}],
        "bogota": [{"network": "CM", "station": "HEL", "channel": "HHZ"}],
        "vancouver": [{"network": "AM", "station": "R195D", "channel": "EHZ"}],
        "istanbul": [{"network": "HL", "station": "RDO", "channel": "HHZ"}],
        "kathmandu": [{"network": "IO", "station": "EVN", "channel": "BHZ"}],
        "anchorage": [{"network": "AK", "station": "BAE", "channel": "BHZ"}],
        "antofagasta": [{"network": "C", "station": "GO02", "channel": "BHZ"}],
        "guam": [{"network": "IU", "station": "GUMO", "channel": "BHZ"}],
        "portauprince": [{"network": "AY", "station": "CAPH", "channel": "HHZ"}],
        "sandiego": [{"network": "AE", "station": "113A", "channel": "HHZ"}],
        "portland": [{"network": "AM", "station": "R195D", "channel": "EHZ"}],
        "managua": [{"network": "CU", "station": "TGUH", "channel": "BHZ"}],
        "sanjose": [{"network": "G", "station": "HDC", "channel": "BHZ"}],
    }

    def __init__(self, fdsn_servers: Optional[list] = None):
        """
        Initialize spectrogram service with multiple FDSN servers

        Args:
            fdsn_servers: Lista de servidores FDSN a utilizar (default: usa todos)
        """
        self.servers = fdsn_servers or [s["name"] for s in self.FDSN_SERVERS]
        self.clients = {}

        # Inicializar clientes para cada servidor
        for server in self.servers:
            try:
                self.clients[server] = Client(server)
                logger.info(f"Connected to FDSN server: {server}")
            except Exception as e:
                logger.warning(f"Failed to connect to {server}: {e}")

        if not self.clients:
            logger.error("No FDSN servers available!")
        else:
            logger.info(
                f"Initialized with {len(self.clients)} FDSN servers: {list(self.clients.keys())}"
            )

    def _get_stations_sync(
        self,
        latitude: float,
        longitude: float,
        max_radius: float = 5.0,  # Incrementado de 2.0 a 5.0 grados
        network: Optional[str] = None,
    ) -> list:
        """
        Synchronous wrapper for ObsPy get_stations (for thread executor)
        Intenta múltiples servidores FDSN hasta encontrar estaciones
        """
        if not self.clients:
            return []

        all_stations = []

        # Intentar con cada servidor FDSN disponible
        for server_name, client in self.clients.items():
            try:
                logger.info(f"Trying {server_name} for stations near ({latitude}, {longitude})...")

                inventory = client.get_stations(
                    latitude=latitude,
                    longitude=longitude,
                    maxradius=max_radius,
                    network=network,
                    level="channel",
                    channel="BHZ,HHZ,EHZ,SHZ",  # Más tipos de canales
                )

                for net in inventory:
                    for sta in net:
                        station_info = {
                            "network": net.code,
                            "station": sta.code,
                            "latitude": sta.latitude,
                            "longitude": sta.longitude,
                            "channels": [ch.code for ch in sta],
                            "source_server": server_name,
                        }
                        # Evitar duplicados
                        if not any(
                            s["network"] == station_info["network"]
                            and s["station"] == station_info["station"]
                            for s in all_stations
                        ):
                            all_stations.append(station_info)

                logger.info(
                    f"{server_name}: Found {len([s for s in all_stations if s['source_server'] == server_name])} stations"
                )

                # Si encontramos suficientes estaciones, podemos detenernos
                if len(all_stations) >= 5:
                    break

            except Exception as e:
                logger.warning(f"{server_name}: Error getting stations: {e}")
                continue

        logger.info(
            f"Total: Found {len(all_stations)} unique stations near ({latitude}, {longitude}) from {len(self.clients)} servers"
        )
        return all_stations

    async def get_stations_near_location(
        self,
        latitude: float,
        longitude: float,
        max_radius: float = 5.0,  # Incrementado de 2.0 a 5.0
        network: Optional[str] = None,
        timeout: int = 30,  # Incrementado timeout para múltiples servidores
    ) -> list:
        """
        Obtener estaciones sísmicas cerca de una ubicación

        Args:
            latitude: Latitud
            longitude: Longitud
            max_radius: Radio máximo en grados
            network: Código de red (opcional)
            timeout: Timeout en segundos

        Returns:
            Lista de estaciones disponibles
        """
        if not self.clients:
            return []

        try:
            # Run blocking ObsPy call in thread pool with timeout
            loop = asyncio.get_event_loop()
            stations = await asyncio.wait_for(
                loop.run_in_executor(
                    _executor, self._get_stations_sync, latitude, longitude, max_radius, network
                ),
                timeout=timeout,
            )
            return stations

        except asyncio.TimeoutError:
            logger.error(f"Timeout getting stations near ({latitude}, {longitude})")
            return []
        except Exception as e:
            logger.error(f"Error getting stations: {e}")
            return []

    def _get_waveform_sync(
        self,
        network: str,
        station: str,
        location: str = "*",
        channel: str = "BHZ",
        duration_hours: int = 24,
        source_server: Optional[str] = None,
    ) -> Optional[any]:
        """
        Synchronous wrapper for ObsPy get_waveforms (for thread executor)
        Intenta múltiples servidores FDSN si no se especifica uno
        """
        if not self.clients:
            logger.error("No FDSN clients available")
            return None

        end_time = UTCDateTime()
        start_time = end_time - (duration_hours * 3600)

        logger.info(f"Fetching waveform: {network}.{station}.{location}.{channel}")
        logger.info(f"Time range: {start_time} to {end_time}")

        # Si se especificó un servidor fuente, intentar primero con ese
        servers_to_try = []
        if source_server and source_server in self.clients:
            servers_to_try.append(source_server)
            # Agregar los demás como fallback
            servers_to_try.extend([s for s in self.clients.keys() if s != source_server])
        else:
            servers_to_try = list(self.clients.keys())

        # Intentar con cada servidor hasta obtener datos
        for server_name in servers_to_try:
            try:
                client = self.clients[server_name]
                logger.info(f"Trying {server_name} for waveform data...")

                stream = client.get_waveforms(
                    network=network,
                    station=station,
                    location=location,
                    channel=channel,
                    starttime=start_time,
                    endtime=end_time,
                )

                if len(stream) > 0:
                    logger.info(f"{server_name}: Retrieved {len(stream)} trace(s)")
                    return stream
                else:
                    logger.warning(f"{server_name}: No data retrieved")

            except Exception as e:
                logger.warning(f"{server_name}: Error fetching waveform data: {e}")
                continue

        logger.error(f"Failed to retrieve waveform from all servers for {network}.{station}")
        return None

    async def get_waveform_data(
        self,
        network: str,
        station: str,
        location: str = "*",
        channel: str = "BHZ",
        duration_hours: int = 24,
        timeout: int = 30,  # Incrementado para múltiples servidores
        source_server: Optional[str] = None,
    ) -> Optional[any]:
        """
        Obtener datos de forma de onda desde FDSN

        Args:
            network: Código de red (e.g., 'CI', 'US')
            station: Código de estación
            location: Código de ubicación (default: '*' = cualquiera)
            channel: Código de canal (default: 'BHZ' = vertical broadband)
            duration_hours: Duración en horas hacia atrás
            timeout: Timeout en segundos
            source_server: Servidor FDSN preferido (opcional)

        Returns:
            Stream de ObsPy con datos de onda o None
        """
        if not self.clients:
            logger.error("No FDSN clients available")
            return None

        try:
            # Run blocking ObsPy call in thread pool with timeout
            loop = asyncio.get_event_loop()
            stream = await asyncio.wait_for(
                loop.run_in_executor(
                    _executor,
                    self._get_waveform_sync,
                    network,
                    station,
                    location,
                    channel,
                    duration_hours,
                    source_server,
                ),
                timeout=timeout,
            )
            return stream

        except asyncio.TimeoutError:
            logger.error(f"Timeout fetching waveform {network}.{station}.{channel}")
            return None
        except Exception as e:
            logger.error(f"Error fetching waveform data: {e}")
            return None

    def generate_spectrogram_image(
        self,
        stream: any,
        width: int = 800,
        height: int = 400,
        fmin: float = 0.1,
        fmax: float = 20.0,
    ) -> Optional[str]:
        """
        Generar imagen de espectrograma desde stream de ObsPy

        Args:
            stream: Stream de ObsPy
            width: Ancho de la imagen en pixels
            height: Alto de la imagen en pixels
            fmin: Frecuencia mínima en Hz
            fmax: Frecuencia máxima en Hz

        Returns:
            Imagen en base64 o None si hay error
        """
        if stream is None or len(stream) == 0:
            return None

        try:
            # Un stream puede venir partido en varios traces si hay gaps de datos.
            # Usamos el más largo para maximizar la ventana de señal continua.
            trace = max(stream, key=lambda tr: tr.stats.npts)

            # Cálculo con paridad SWARM (Kaiser beta=5, 20*log10 de la FFT
            # cruda, sin bandpass): la escala fija 20-120 dB aplica tal cual.
            # max_columns limita las posiciones temporales a lo que la imagen
            # puede mostrar sin cambiar los dB de cada bin.
            fs = trace.stats.sampling_rate
            f, t, Sxx_db = swarm_spectrogram_db(trace.data, fs, max_columns=width * 2)

            # Crear figura
            fig, ax = plt.subplots(figsize=(width / 100, height / 100), dpi=100)

            # Plot espectrograma
            im = ax.pcolormesh(
                t / 3600,  # Convertir a horas
                f,
                Sxx_db,
                cmap="jet",  # paleta estilo SWARM (Jet2); ver dashboard/lib/jet2-palette.ts
                shading="auto",
                vmin=MIN_POWER_DB,  # escala fija de SWARM: el rojo es 120 dB
                vmax=MAX_POWER_DB,  # reales, no "el 5% más alto de la imagen"
            )

            # Configurar ejes
            ax.set_ylabel("Frecuencia [Hz]")
            ax.set_xlabel("Tiempo [horas desde ahora]")
            ax.set_ylim([fmin, fmax])
            ax.set_xlim([t[0] / 3600, t[-1] / 3600])

            # Ajustar para que se vea limpio
            plt.tight_layout(pad=0.5)

            # Convertir a imagen
            buf = io.BytesIO()
            plt.savefig(buf, format="png", bbox_inches="tight", dpi=100)
            buf.seek(0)
            plt.close(fig)

            # Convertir a base64
            img_base64 = base64.b64encode(buf.read()).decode("utf-8")

            return img_base64

        except Exception as e:
            logger.error(f"Error generating spectrogram: {e}")
            return None

    def generate_synthetic_spectrogram(
        self,
        latitude: float,
        longitude: float,
        city_id: Optional[str] = None,
        width: int = 800,
        height: int = 400,
    ) -> Optional[str]:
        """
        Generar espectrograma sintético realista basado en ubicación
        Usado como fallback cuando no hay datos FDSN disponibles
        OPTIMIZADO: Genera el espectrograma directamente sin procesar 24h de señal
        """
        try:
            # Generar espectrograma sintético directamente (mucho más rápido)
            # 144 bloques de 10 minutos = 24 horas
            time_blocks = 144  # 10 minutos cada uno
            freq_bins = 100  # 100 bins de frecuencia (0.1 a 20 Hz)

            # Crear matriz de espectrograma sintético
            # Simular ruido de fondo con variación día/noche, centrado en la
            # zona de ruido típica de la escala SWARM (20-120 dB)
            Sxx = 60 + np.random.randn(freq_bins, time_blocks) * 5

            # Añadir ruido océano (frecuencias bajas, constante)
            Sxx[0:10, :] += 20 + np.random.randn(10, time_blocks) * 3

            # Añadir ruido cultural (frecuencias medias, más de día que de noche)
            day_cycle = np.sin(2 * np.pi * np.arange(time_blocks) / time_blocks) * 0.5 + 0.5
            for i in range(20, 50):
                Sxx[i, :] += 15 * day_cycle + np.random.randn(time_blocks) * 2

            # Añadir eventos sísmicos aleatorios (picos en todas las frecuencias)
            num_events = np.random.randint(2, 5)
            for _ in range(num_events):
                event_time = np.random.randint(0, time_blocks)
                event_width = np.random.randint(1, 5)
                Sxx[
                    :, max(0, event_time - event_width) : min(time_blocks, event_time + event_width)
                ] += (np.random.randn(freq_bins, 1) * 10)

            # Crear ejes de frecuencia y tiempo
            f = np.linspace(0.1, 20, freq_bins)
            t = np.linspace(0, 24, time_blocks)

            # Crear figura
            fig, ax = plt.subplots(figsize=(width / 100, height / 100), dpi=100)

            # Plot espectrograma
            im = ax.pcolormesh(
                t,
                f,
                Sxx,
                cmap="jet",  # paleta estilo SWARM (Jet2); ver dashboard/lib/jet2-palette.ts
                shading="gouraud",
                vmin=MIN_POWER_DB,
                vmax=MAX_POWER_DB,
            )

            # Configurar ejes
            ax.set_ylabel("Frecuencia [Hz]", fontsize=8)
            ax.set_xlabel("Tiempo [horas]", fontsize=8)
            ax.set_ylim([0.1, 20])
            ax.set_xlim([0, 24])
            ax.tick_params(labelsize=7)

            # Ajustar para que se vea limpio
            plt.tight_layout(pad=0.3)

            # Convertir a imagen
            buf = io.BytesIO()
            plt.savefig(buf, format="png", bbox_inches="tight", dpi=100)
            buf.seek(0)
            plt.close(fig)

            # Convertir a base64
            img_base64 = base64.b64encode(buf.read()).decode("utf-8")

            return img_base64

        except Exception as e:
            logger.error(f"Error generating synthetic spectrogram: {e}")
            return None

    async def generate_spectrogram_for_location(
        self,
        latitude: float,
        longitude: float,
        network_code: Optional[str] = None,
        duration_hours: int = 24,
        city_id: Optional[str] = None,
    ) -> Dict:
        """
        Generar espectrograma para una ubicación geográfica.

        Intenta datos reales vía FDSN (estaciones conocidas para city_id,
        si no hay match usa búsqueda por radio). Si falla o no hay datos,
        cae a espectrograma sintético.

        Args:
            latitude: Latitud
            longitude: Longitud
            network_code: Código de red preferido (opcional)
            duration_hours: Duración en horas
            city_id: ID de la ciudad (opcional, para usar estaciones conocidas)

        Returns:
            Dict con espectrogram base64 y metadata
        """
        real_result = await self._try_real_spectrogram(
            latitude, longitude, network_code, duration_hours, city_id
        )
        if real_result:
            return real_result

        logger.info(f"Falling back to synthetic spectrogram for {city_id or 'location'}")
        synthetic_image = self.generate_synthetic_spectrogram(latitude, longitude, city_id)

        if synthetic_image:
            return {
                "success": True,
                "image": synthetic_image,
                "metadata": {
                    "network": "SYNTHETIC",
                    "station": city_id or "unknown",
                    "latitude": latitude,
                    "longitude": longitude,
                    "duration_hours": duration_hours,
                    "generated_at": datetime.utcnow().isoformat(),
                    "data_type": "synthetic",
                },
            }

        return {
            "success": False,
            "error": "Failed to generate spectrogram",
            "image": None,
            "metadata": None,
        }

    async def _try_real_spectrogram(
        self,
        latitude: float,
        longitude: float,
        network_code: Optional[str],
        duration_hours: int,
        city_id: Optional[str],
    ) -> Optional[Dict]:
        """
        Intenta generar un espectrograma con datos reales de FDSN.
        Devuelve None si no hay estaciones/datos disponibles (caller cae a sintético).
        """
        candidates = self.KNOWN_STATIONS.get(city_id, []) if city_id else []

        if not candidates:
            # Ubicación libre (no está en KNOWN_STATIONS): buscar estaciones
            # cercanas en vivo. Más lento (get_stations + get_waveforms) pero
            # cubre cualquier lat/lon en vez de limitarse a la lista fija.
            nearby = await self.get_stations_near_location(
                latitude, longitude, max_radius=3.0, network=network_code
            )
            candidates = [
                {"network": s["network"], "station": s["station"], "channel": s["channels"][0]}
                for s in nearby[:5]
                if s.get("channels")
            ]

        for candidate in candidates:
            stream = await self.get_waveform_data(
                network=candidate["network"],
                station=candidate["station"],
                channel=candidate["channel"],
                duration_hours=duration_hours,
            )
            if stream is None or len(stream) == 0:
                continue

            loop = asyncio.get_event_loop()
            image = await loop.run_in_executor(_executor, self.generate_spectrogram_image, stream)
            if not image:
                continue

            trace = max(stream, key=lambda tr: tr.stats.npts)
            return {
                "success": True,
                "image": image,
                "metadata": {
                    "network": trace.stats.network,
                    "station": trace.stats.station,
                    "channel": trace.stats.channel,
                    "latitude": latitude,
                    "longitude": longitude,
                    "duration_hours": duration_hours,
                    "generated_at": datetime.utcnow().isoformat(),
                    "data_type": "real",
                },
            }

        return None


# Singleton
_spectrogram_service: Optional[SpectrogramService] = None


def get_spectrogram_service() -> SpectrogramService:
    """
    Get singleton spectrogram service
    Inicializa con múltiples servidores FDSN: USGS, IRIS, GEOFON, ORFEUS
    """
    global _spectrogram_service
    if _spectrogram_service is None:
        # Usar todos los servidores disponibles
        _spectrogram_service = SpectrogramService()
    return _spectrogram_service
