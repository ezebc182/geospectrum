"""
Modelos de datos para eventos sísmicos.
"""

from pydantic import BaseModel, Field
from typing import List, Optional


class SeismicEvent(BaseModel):
    """Evento sísmico normalizado (fusión USGS + INPRES)."""

    id: str = Field(..., description="ID único interno")
    fuentes: List[str] = Field(default_factory=list, description="Fuentes: USGS, INPRES")
    hora_utc: str = Field(..., description="Timestamp UTC ISO8601")
    lat: float = Field(..., description="Latitud epicentro")
    lon: float = Field(..., description="Longitud epicentro")
    prof_km: Optional[float] = Field(None, description="Profundidad en km")
    mag: float = Field(..., description="Magnitud")
    mag_tipo: Optional[str] = Field(None, description="Tipo: Mw, ML, Md, etc")
    lugar: Optional[str] = Field(None, description="Descripción lugar")
    sentido: bool = Field(False, description="Si fue percibido por población")
    revisado: bool = Field(False, description="Si fue revisado por sismólogo")

    class Config:
        json_schema_extra = {
            "example": {
                "id": "us12345",
                "fuentes": ["USGS", "INPRES"],
                "hora_utc": "2025-10-28T22:26:39Z",
                "lat": -31.875,
                "lon": -68.296,
                "prof_km": 108.0,
                "mag": 4.2,
                "mag_tipo": "Mw",
                "lugar": "43 km SE de San Juan, Argentina",
                "sentido": True,
                "revisado": True,
            }
        }


class KPIs(BaseModel):
    """KPIs calculados sobre la ventana de análisis."""

    total_eventos: int = Field(..., description="Número total de eventos")
    tasa_eventos_por_hora: float = Field(..., description="Tasa horaria de eventos")
    magnitud_max: Optional[float] = Field(None, description="Magnitud máxima registrada")
    magnitud_promedio_ponderada_por_energia: Optional[float] = Field(
        None, description="Magnitud promedio ponderada por energía liberada"
    )
    profundidad_media_M_ge_4: Optional[float] = Field(
        None, description="Profundidad media de eventos M≥4"
    )
    eventos_sentidos: int = Field(..., description="Cantidad de eventos sentidos")
    porcentaje_eventos_sentidos: float = Field(..., description="% de eventos sentidos")
    minutos_desde_M_ge_5: Optional[float] = Field(
        None, description="Minutos desde último evento M≥5"
    )


class Alert(BaseModel):
    """Alerta operativa generada por el sistema."""

    tipo: str = Field(..., description="enjambre | evento_significativo | actividad_sentida")
    descripcion: str = Field(..., description="Descripción legible")
    eventos_relacionados: List[str] = Field(default_factory=list, description="IDs eventos")


class MonitorReport(BaseModel):
    """Reporte completo del sistema de monitoreo."""

    timestamp_utc_generacion: str = Field(..., description="Timestamp generación reporte")
    region_monitorizada: dict = Field(..., description="Bounding box región")
    data_source_errors: List[str] = Field(
        default_factory=list, description="Errores al consultar fuentes externas"
    )
    kpis: KPIs
    alertas: List[Alert] = Field(default_factory=list)
    eventos: List[SeismicEvent] = Field(default_factory=list)

    class Config:
        json_schema_extra = {
            "example": {
                "timestamp_utc_generacion": "2025-10-28T23:59:59Z",
                "region_monitorizada": {"minlat": -40, "maxlat": -20, "minlon": -75, "maxlon": -60},
                "data_source_errors": [],
                "kpis": {
                    "total_eventos": 4,
                    "tasa_eventos_por_hora": 4.0,
                    "magnitud_max": 4.2,
                    "magnitud_promedio_ponderada_por_energia": 3.8,
                    "profundidad_media_M_ge_4": 102.5,
                    "eventos_sentidos": 1,
                    "porcentaje_eventos_sentidos": 0.25,
                    "minutos_desde_M_ge_5": 1800,
                },
                "alertas": [],
                "eventos": [],
            }
        }
