"""
Servicio avanzado de EMSC para obtener detalles de eventos, modelos de ruptura y datos sísmicos
Basado en: https://seismicportal.eu/fdsn-wsevent.html y https://seismicportal.eu/srcmodws/
Documentación oficial: https://www.seismicportal.eu/fdsnws/event/1/docs
"""

import httpx
from typing import Optional, Dict, Any, List
from datetime import datetime
import logging

logger = logging.getLogger(__name__)


class EMSCDetailService:
    """
    Servicio para obtener detalles completos de eventos sísmicos de EMSC
    incluyendo modelos de ruptura (SRCMOD) y datos de forma de onda

    Servicios implementados:
    - FDSN Event Web Service: Para datos de eventos
    - SRCMOD Web Service: Para modelos de ruptura de falla finita
    - EventID Service: Para resolver IDs entre diferentes catálogos
    """

    BASE_URL = "https://www.seismicportal.eu"
    FDSN_EVENT_URL = f"{BASE_URL}/fdsnws/event/1"
    SRCMOD_URL = f"{BASE_URL}/srcmodws"  # SRCMOD database
    EVENTID_URL = f"{BASE_URL}/eventid/api"  # EventID service

    @classmethod
    async def get_event_by_id(cls, event_id: str) -> Optional[Dict[str, Any]]:
        """
        Obtener evento completo por UNID (Unified ID de EMSC) o EventID

        Args:
            event_id: UNID de EMSC (ej: "20231206_0000091") o EventID

        Returns:
            Diccionario con información detallada del evento
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Intentar primero con formato JSON (QuakeML)
                url = f"{cls.FDSN_EVENT_URL}/query"
                params = {
                    "eventid": event_id,
                    "format": "json",
                    "includeallmagnitudes": "true",
                    "includeallorigins": "true",
                    "includearrivals": "true"
                }

                response = await client.get(url, params=params)

                if response.status_code == 200:
                    data = response.json()

                    if "features" in data and len(data["features"]) > 0:
                        event = data["features"][0]
                        properties = event.get("properties", {})
                        geometry = event.get("geometry", {})
                        coordinates = geometry.get("coordinates", [None, None, None])

                        # Extraer información detallada
                        event_detail = {
                            "id": event_id,
                            "unid": properties.get("unid"),
                            "time": properties.get("time"),
                            "mag": properties.get("mag"),
                            "mag_type": properties.get("magtype"),
                            "lat": coordinates[1] if len(coordinates) > 1 else None,
                            "lon": coordinates[0] if len(coordinates) > 0 else None,
                            "depth_km": coordinates[2] if len(coordinates) > 2 else None,
                            "place": properties.get("flynn_region") or properties.get("place"),
                            "felt": properties.get("felt"),
                            "reviewed": properties.get("status") == "reviewed",
                            "type": properties.get("type"),
                            "url": properties.get("url"),

                            # Información adicional
                            "magnitudes": properties.get("magnitudes", []),
                            "origins": properties.get("origins", []),
                            "arrivals": properties.get("arrivals", []),
                            "author": properties.get("auth"),
                            "source_catalog": properties.get("source_catalog"),
                            "evaluation_mode": properties.get("evaluation_mode"),
                            "evaluation_status": properties.get("evaluation_status"),

                            # Parámetros de calidad
                            "horizontal_error": properties.get("horizontal_error"),
                            "depth_error": properties.get("depth_error"),
                            "mag_error": properties.get("mag_error"),
                            "azimuthal_gap": properties.get("azimuthal_gap"),
                            "num_stations_used": properties.get("num_stations_used"),
                            "num_phases_used": properties.get("num_phases_used"),

                            # Datos de intensidad si están disponibles
                            "max_intensity": properties.get("maxmmi"),
                            "felt_reports": properties.get("felt"),
                            "cdi": properties.get("cdi"),  # Community Decimal Intensity
                            "mmi": properties.get("mmi"),  # Modified Mercalli Intensity
                        }

                        return event_detail

                return None

        except Exception as e:
            logger.error(f"Error obteniendo evento {event_id}: {e}")
            return None

    @classmethod
    async def get_rupture_model(cls, event_id: str) -> Optional[Dict[str, Any]]:
        """
        Obtener modelo de ruptura de falla finita (finite fault) si está disponible

        Args:
            event_id: UNID de EMSC

        Returns:
            Diccionario con información del modelo de ruptura (SRCMOD)
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                # Endpoint de SRCMOD asociado con EMSC
                url = f"{cls.BASE_URL}/srcmod/query"
                params = {
                    "unid": event_id,
                    "format": "json"
                }

                response = await client.get(url, params=params)

                if response.status_code == 200:
                    data = response.json()

                    if data and len(data) > 0:
                        rupture = data[0]

                        return {
                            "event_id": event_id,
                            "srcmod_id": rupture.get("srcmod_id"),
                            "eq_tag": rupture.get("eq_tag"),
                            "fault_name": rupture.get("fault_name"),
                            "fault_type": rupture.get("fault_type"),
                            "rupture_velocity": rupture.get("rupture_velocity"),
                            "rise_time": rupture.get("rise_time"),
                            "total_length": rupture.get("total_length"),
                            "total_width": rupture.get("total_width"),
                            "max_slip": rupture.get("max_slip"),
                            "avg_slip": rupture.get("avg_slip"),
                            "num_subfaults": rupture.get("num_subfaults"),
                            "data_type": rupture.get("data_type"),  # static o kinematic
                            "inversion_method": rupture.get("inversion_method"),
                            "reference": rupture.get("reference"),
                            "doi": rupture.get("doi"),
                            "slip_model_url": rupture.get("slip_model_url"),
                        }

                return None

        except Exception as e:
            logger.error(f"Error obteniendo modelo de ruptura para {event_id}: {e}")
            return None

    @classmethod
    async def get_event_with_rupture(cls, event_id: str) -> Optional[Dict[str, Any]]:
        """
        Obtener evento completo con modelo de ruptura si está disponible

        Args:
            event_id: UNID de EMSC

        Returns:
            Diccionario combinado con evento y modelo de ruptura
        """
        event = await cls.get_event_by_id(event_id)

        if not event:
            return None

        # Intentar obtener modelo de ruptura
        rupture_model = await cls.get_rupture_model(event_id)

        if rupture_model:
            event["rupture_model"] = rupture_model
        else:
            event["rupture_model"] = None

        return event

    @classmethod
    async def search_events_with_details(
        cls,
        start_time: Optional[datetime] = None,
        end_time: Optional[datetime] = None,
        min_mag: Optional[float] = None,
        max_mag: Optional[float] = None,
        min_lat: Optional[float] = None,
        max_lat: Optional[float] = None,
        min_lon: Optional[float] = None,
        max_lon: Optional[float] = None,
        min_depth: Optional[float] = None,
        max_depth: Optional[float] = None,
        limit: int = 100
    ) -> List[Dict[str, Any]]:
        """
        Buscar eventos con detalles completos

        Returns:
            Lista de eventos con información detallada
        """
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                url = f"{cls.FDSN_EVENT_URL}/query"
                params = {
                    "format": "json",
                    "limit": limit,
                    "includeallmagnitudes": "true",
                }

                if start_time:
                    params["starttime"] = start_time.strftime("%Y-%m-%dT%H:%M:%S")
                if end_time:
                    params["endtime"] = end_time.strftime("%Y-%m-%dT%H:%M:%S")
                if min_mag is not None:
                    params["minmag"] = min_mag
                if max_mag is not None:
                    params["maxmag"] = max_mag
                if min_lat is not None:
                    params["minlat"] = min_lat
                if max_lat is not None:
                    params["maxlat"] = max_lat
                if min_lon is not None:
                    params["minlon"] = min_lon
                if max_lon is not None:
                    params["maxlon"] = max_lon
                if min_depth is not None:
                    params["mindepth"] = min_depth
                if max_depth is not None:
                    params["maxdepth"] = max_depth

                response = await client.get(url, params=params)

                if response.status_code == 200:
                    data = response.json()
                    events = []

                    for feature in data.get("features", []):
                        props = feature.get("properties", {})
                        coords = feature.get("geometry", {}).get("coordinates", [None, None, None])

                        events.append({
                            "id": props.get("unid") or props.get("id"),
                            "time": props.get("time"),
                            "mag": props.get("mag"),
                            "mag_type": props.get("magtype"),
                            "lat": coords[1] if len(coords) > 1 else None,
                            "lon": coords[0] if len(coords) > 0 else None,
                            "depth_km": coords[2] if len(coords) > 2 else None,
                            "place": props.get("flynn_region") or props.get("place"),
                            "felt": props.get("felt"),
                            "reviewed": props.get("status") == "reviewed",
                            "url": props.get("url"),
                        })

                    return events

                return []

        except Exception as e:
            logger.error(f"Error buscando eventos: {e}")
            return []

    @classmethod
    async def get_nearby_stations(
        cls,
        lat: float,
        lon: float,
        radius_km: float = 200
    ) -> List[Dict[str, Any]]:
        """
        Obtener estaciones sísmicas cercanas a una ubicación
        Útil para vincular con datos de espectrograma

        Args:
            lat: Latitud
            lon: Longitud
            radius_km: Radio de búsqueda en km

        Returns:
            Lista de estaciones cercanas
        """
        try:
            # Esto usaría FDSN Station web service
            # Por ahora retornamos estructura vacía
            # En producción se implementaría con:
            # https://www.seismicportal.eu/fdsnws/station/1/query

            return []

        except Exception as e:
            logger.error(f"Error obteniendo estaciones cercanas: {e}")
            return []
