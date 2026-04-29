"""
Servicio para obtener datos de ondas sísmicas desde FDSN y generar espectrogramas
Usa ObsPy para procesar datos reales de estaciones sísmicas
"""

import io
import base64
import asyncio
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from typing import Optional, Tuple, Dict
import logging

import numpy as np
from obspy.clients.fdsn import Client
from obspy import UTCDateTime
from obspy.signal.trigger import plot_trigger
from PIL import Image
import matplotlib
matplotlib.use('Agg')  # Backend sin GUI
import matplotlib.pyplot as plt
from matplotlib import colors
from scipy import signal

logger = logging.getLogger(__name__)

# Thread pool para operaciones bloqueantes de ObsPy
_executor = ThreadPoolExecutor(max_workers=4)

# Mapeo de códigos de red por país/región
NETWORK_CODES = {
    'US': 'US',      # United States National Network
    'CI': 'CI',      # California Integrated Seismic Network
    'NC': 'NC',      # Northern California Seismic Network
    'UW': 'UW',      # Pacific Northwest Seismic Network
    'AK': 'AK',      # Alaska Seismic Network
    'JP': 'JP',      # Japanese National Network
    'CL': 'C',       # Chile National Network
    'PE': 'PE',      # Peru National Network
    'NZ': 'NZ',      # GeoNet New Zealand
    'TW': 'TW',      # Taiwan Seismic Network
    'TU': 'TU',      # Turkish National Network
    'IR': 'IR',      # Iranian Seismic Network
}

class SpectrogramService:
    """Servicio para generar espectrogramas desde datos FDSN"""

    # Lista de servidores FDSN con sus características (ordenados por confiabilidad)
    FDSN_SERVERS = [
        {"name": "IRIS", "coverage": "global", "priority": 1},       # IRIS DMC - Más confiable y completo
        {"name": "USGS", "coverage": "global", "priority": 2},       # US Geological Survey
        {"name": "GEOFON", "coverage": "global", "priority": 3},     # GFZ Potsdam - Bueno para Europa/Asia
        {"name": "ORFEUS", "coverage": "europe", "priority": 4},     # ORFEUS - Europa
        {"name": "RESIF", "coverage": "europe", "priority": 5},      # RESIF - Francia/Europa
        {"name": "INGV", "coverage": "mediterranean", "priority": 6}, # INGV - Italia/Mediterráneo
    ]

    # Estaciones pre-configuradas para ciudades importantes (para acelerar búsqueda)
    KNOWN_STATIONS = {
        # Japón - Red muy densa
        "tokyo": [{"network": "JP", "station": "TNPH", "channel": "BHZ"},
                  {"network": "JP", "station": "TKSB", "channel": "BHZ"}],
        "osaka": [{"network": "JP", "station": "OSKH", "channel": "BHZ"}],

        # USA - USGS/IRIS excelente cobertura
        "los_angeles": [{"network": "CI", "station": "PAS", "channel": "BHZ"},
                        {"network": "CI", "station": "USC", "channel": "BHZ"}],
        "san_francisco": [{"network": "BK", "station": "BRIB", "channel": "BHZ"},
                          {"network": "NC", "station": "BKS", "channel": "BHZ"}],
        "seattle": [{"network": "UW", "station": "LON", "channel": "HHZ"}],

        # Chile - Red nacional
        "santiago": [{"network": "C", "station": "GO01", "channel": "HHZ"},
                     {"network": "C1", "station": "PB01", "channel": "HHZ"}],

        # Perú
        "lima": [{"network": "PE", "station": "LIMA", "channel": "HHZ"}],

        # Nueva Zelanda - GeoNet
        "wellington": [{"network": "NZ", "station": "WEL", "channel": "HHZ"}],
        "christchurch": [{"network": "NZ", "station": "CHC", "channel": "HHZ"}],

        # México
        "mexico_city": [{"network": "MX", "station": "PPIG", "channel": "BHZ"}],
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
            logger.info(f"Initialized with {len(self.clients)} FDSN servers: {list(self.clients.keys())}")

    def _get_stations_sync(
        self,
        latitude: float,
        longitude: float,
        max_radius: float = 5.0,  # Incrementado de 2.0 a 5.0 grados
        network: Optional[str] = None
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
                            "source_server": server_name
                        }
                        # Evitar duplicados
                        if not any(s["network"] == station_info["network"] and
                                 s["station"] == station_info["station"] for s in all_stations):
                            all_stations.append(station_info)

                logger.info(f"{server_name}: Found {len([s for s in all_stations if s['source_server'] == server_name])} stations")

                # Si encontramos suficientes estaciones, podemos detenernos
                if len(all_stations) >= 5:
                    break

            except Exception as e:
                logger.warning(f"{server_name}: Error getting stations: {e}")
                continue

        logger.info(f"Total: Found {len(all_stations)} unique stations near ({latitude}, {longitude}) from {len(self.clients)} servers")
        return all_stations

    async def get_stations_near_location(
        self,
        latitude: float,
        longitude: float,
        max_radius: float = 5.0,  # Incrementado de 2.0 a 5.0
        network: Optional[str] = None,
        timeout: int = 30  # Incrementado timeout para múltiples servidores
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
                    _executor,
                    self._get_stations_sync,
                    latitude,
                    longitude,
                    max_radius,
                    network
                ),
                timeout=timeout
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
        source_server: Optional[str] = None
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
                    endtime=end_time
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
        source_server: Optional[str] = None
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
                    source_server
                ),
                timeout=timeout
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
        fmax: float = 20.0
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
            # Usar el primer trace
            trace = stream[0]

            # Preprocesamiento
            trace.detrend('demean')
            trace.filter('bandpass', freqmin=fmin, freqmax=fmax, corners=2, zerophase=True)

            # Calcular espectrograma
            fs = trace.stats.sampling_rate
            data = trace.data

            # Parámetros para la FFT
            nperseg = int(fs * 60)  # Ventana de 60 segundos
            noverlap = int(nperseg * 0.9)  # 90% overlap

            f, t, Sxx = signal.spectrogram(
                data,
                fs=fs,
                window='hann',
                nperseg=nperseg,
                noverlap=noverlap,
                scaling='density'
            )

            # Convertir a dB
            Sxx_db = 10 * np.log10(Sxx + 1e-10)

            # Crear figura
            fig, ax = plt.subplots(figsize=(width/100, height/100), dpi=100)

            # Plot espectrograma
            im = ax.pcolormesh(
                t / 3600,  # Convertir a horas
                f,
                Sxx_db,
                cmap='viridis',
                shading='gouraud',
                vmin=np.percentile(Sxx_db, 5),
                vmax=np.percentile(Sxx_db, 95)
            )

            # Configurar ejes
            ax.set_ylabel('Frecuencia [Hz]')
            ax.set_xlabel('Tiempo [horas desde ahora]')
            ax.set_ylim([fmin, fmax])
            ax.set_xlim([t[0]/3600, t[-1]/3600])

            # Ajustar para que se vea limpio
            plt.tight_layout(pad=0.5)

            # Convertir a imagen
            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', dpi=100)
            buf.seek(0)
            plt.close(fig)

            # Convertir a base64
            img_base64 = base64.b64encode(buf.read()).decode('utf-8')

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
        height: int = 400
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
            # Simular ruido de fondo con variación día/noche
            Sxx = np.random.randn(freq_bins, time_blocks) * 5

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
                Sxx[:, max(0, event_time-event_width):min(time_blocks, event_time+event_width)] += np.random.randn(freq_bins, 1) * 10

            # Crear ejes de frecuencia y tiempo
            f = np.linspace(0.1, 20, freq_bins)
            t = np.linspace(0, 24, time_blocks)

            # Crear figura
            fig, ax = plt.subplots(figsize=(width/100, height/100), dpi=100)

            # Plot espectrograma
            im = ax.pcolormesh(
                t,
                f,
                Sxx,
                cmap='viridis',
                shading='gouraud',
                vmin=np.percentile(Sxx, 5),
                vmax=np.percentile(Sxx, 95)
            )

            # Configurar ejes
            ax.set_ylabel('Frecuencia [Hz]', fontsize=8)
            ax.set_xlabel('Tiempo [horas]', fontsize=8)
            ax.set_ylim([0.1, 20])
            ax.set_xlim([0, 24])
            ax.tick_params(labelsize=7)

            # Ajustar para que se vea limpio
            plt.tight_layout(pad=0.3)

            # Convertir a imagen
            buf = io.BytesIO()
            plt.savefig(buf, format='png', bbox_inches='tight', dpi=100)
            buf.seek(0)
            plt.close(fig)

            # Convertir a base64
            img_base64 = base64.b64encode(buf.read()).decode('utf-8')

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
        city_id: Optional[str] = None
    ) -> Dict:
        """
        Generar espectrograma para una ubicación geográfica
        ACTUALMENTE USA SOLO SINTÉTICOS para garantizar respuesta rápida

        Args:
            latitude: Latitud
            longitude: Longitud
            network_code: Código de red preferido (opcional)
            duration_hours: Duración en horas
            city_id: ID de la ciudad (opcional, para usar estaciones conocidas)

        Returns:
            Dict con espectrogram base64 y metadata
        """
        # POR AHORA: Solo generar espectrogramas sintéticos
        # TODO: Implementar FDSN en background workers para no bloquear
        logger.info(f"Generating synthetic spectrogram for {city_id or 'location'}")
        synthetic_image = self.generate_synthetic_spectrogram(
            latitude, longitude, city_id
        )

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
                    "data_type": "synthetic"
                }
            }

        return {
            "success": False,
            "error": "Failed to generate spectrogram",
            "image": None,
            "metadata": None
        }


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
