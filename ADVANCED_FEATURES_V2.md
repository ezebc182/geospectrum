# Sistema Avanzado de Monitoreo Sísmico - Versión 2.0

## 🎯 Nuevas Características Implementadas

### 1. Dashboard de Espectrogramas Sísmicos en Tiempo Real

**Página:** `/spectrograms`
**Acceso:** http://localhost:3008/spectrograms

#### Características:
- **Visualización tipo PNSN** (Pacific Northwest Seismic Network)
- **30 ciudades de alto riesgo sísmico** preconfiguradas
- **Actualización en tiempo real** (cada 2 segundos)
- **Layout configurable**: 2, 3, 4 o 6 columnas
- **Gestión dinámica de ciudades**: agregar/eliminar ciudades al vuelo

#### Ciudades Monitoreadas:
**Asia-Pacífico:**
- Tokyo, Osaka (Japón) - Riesgo EXTREME
- Manila (Filipinas) - Riesgo EXTREME
- Jakarta (Indonesia) - Riesgo EXTREME
- Taipei (Taiwan) - Riesgo EXTREME

**América del Sur:**
- Lima, Arequipa (Perú) - Riesgo EXTREME
- Santiago, Valparaíso, Antofagasta (Chile) - Riesgo EXTREME
- Quito (Ecuador) - Riesgo HIGH

**Norte América:**
- Los Angeles, San Francisco, San Diego (California) - Riesgo EXTREME
- Seattle, Portland (Noroeste USA) - Riesgo HIGH
- Mexico City - Riesgo EXTREME

**Otras regiones:**
- Tehran (Irán), Istanbul (Turquía), Kathmandu (Nepal)
- Wellington, Christchurch (Nueva Zelanda)
- Y más...

#### Espectrograma:
- **Eje Y:** Frecuencia (0.1 - 20 Hz)
- **Eje X:** Tiempo (últimas 24 horas)
- **Colores:**
  - 🔵 Azul: Intensidad baja (ruido de fondo)
  - 🟢 Verde: Intensidad media
  - 🟡 Amarillo: Intensidad alta
  - 🔴 Rojo: Intensidad muy alta (actividad sísmica significativa)

---

### 2. API de Verificación de Eventos por ID

**Endpoint:** `GET /events/{event_id}/detail`

Obtiene información detallada completa de un evento sísmico por su ID.

#### Parámetros:
- `event_id` (path): ID del evento (UNID de EMSC, Event ID de USGS, etc.)

#### Información Devuelta:
- **Datos básicos del evento:**
  - Magnitud, tipo de magnitud
  - Ubicación (lat, lon, profundidad)
  - Fecha y hora UTC
  - Región geográfica (Flynn-Engdahl)

- **Datos de calidad:**
  - Error horizontal y de profundidad
  - Error de magnitud
  - Gap azimutal
  - Número de estaciones usadas
  - Número de fases utilizadas

- **Información de evaluación:**
  - Autor/agencia
  - Catálogo fuente
  - Modo de evaluación (manual/automático)
  - Estado (preliminar/revisado)

- **Magnitudes múltiples:**
  - Todas las magnitudes calculadas por diferentes métodos
  - Ml, Mw, mb, Ms, Md, etc.

- **Orígenes múltiples:**
  - Si hay múltiples soluciones de localización
  - Información de cada origen

- **Intensidades:**
  - Intensidad máxima (MMI)
  - Número de reportes de "sentido"
  - CDI (Community Decimal Intensity)

- **Modelo de ruptura (si disponible):**
  - Automáticamente incluido si existe en SRCMOD

#### Ejemplo de uso:
```bash
curl "http://localhost:8000/events/20231206_0000091/detail"
```

#### Respuesta (ejemplo):
```json
{
  "id": "20231206_0000091",
  "unid": "20231206_0000091",
  "time": "2023-12-06T12:34:56.789Z",
  "mag": 7.5,
  "mag_type": "Mw",
  "lat": -31.5,
  "lon": -68.8,
  "depth_km": 120.5,
  "place": "CUYO, ARGENTINA",
  "felt": 1523,
  "reviewed": true,
  "magnitudes": [
    {"type": "Mw", "value": 7.5, "source": "EMSC"},
    {"type": "mb", "value": 6.8, "source": "USGS"}
  ],
  "horizontal_error": 2.3,
  "depth_error": 5.1,
  "azimuthal_gap": 45.2,
  "num_stations_used": 127,
  "num_phases_used": 384,
  "rupture_model": {
    "srcmod_id": "s2023CUYO01",
    "fault_type": "reverse",
    "max_slip": 5.2,
    "total_length": 120,
    "total_width": 60
  }
}
```

---

### 3. API de Modelos de Ruptura de Falla Finita

**Endpoint:** `GET /events/{event_id}/rupture`

Obtiene el modelo de ruptura de falla finita (finite fault model) para un evento específico.

#### ¿Qué son los Modelos de Ruptura?

Los **modelos de ruptura de falla finita** son representaciones detalladas de cómo se rompió la falla geológica durante un terremoto. Incluyen:

1. **Distribución de deslizamiento (slip):**
   - Cómo se movió la falla en diferentes puntos
   - Amplitud máxima y promedio del deslizamiento

2. **Velocidad de ruptura:**
   - Qué tan rápido se propagó la ruptura a lo largo de la falla

3. **Tiempo de levantamiento (rise time):**
   - Cuánto tiempo tomó el deslizamiento en cada punto

4. **Geometría de la falla:**
   - Longitud y ancho total de la falla
   - División en subfallas para modelado detallado

5. **Tipo de falla:**
   - Normal, inversa, strike-slip, oblicua

#### Fuente de Datos:
- **SRCMOD Database** (Martin Mai)
- Solo disponible para terremotos significativos con inversiones publicadas
- Típicamente M > 6.5 con datos suficientes

#### Parámetros:
- `event_id` (path): ID del evento (UNID de EMSC)

#### Información Devuelta:
```json
{
  "event_id": "20231206_0000091",
  "srcmod_id": "s2023CUYO01",
  "eq_tag": "2023_CUYO",
  "fault_name": "San Juan Fault System",
  "fault_type": "reverse",
  "rupture_velocity": 2.8,
  "rise_time": 2.5,
  "total_length": 120.0,
  "total_width": 60.0,
  "max_slip": 5.2,
  "avg_slip": 2.8,
  "num_subfaults": 360,
  "data_type": "kinematic",
  "inversion_method": "teleseismic + GPS",
  "reference": "Smith et al. (2023)",
  "doi": "10.1029/2023GL012345",
  "slip_model_url": "https://..."
}
```

#### Ejemplo de uso:
```bash
curl "http://localhost:8000/events/20231206_0000091/rupture"
```

#### Uso para Análisis:
Los modelos de ruptura son cruciales para:
- **Análisis de peligro sísmico:** Entender cómo se distribuyen las fuerzas
- **Predicción de réplicas:** Las réplicas tienden a ocurrir en bordes de slip alto
- **Daño estructural:** Correlacionar slip con daños observados
- **Estudios de tsunami:** Slip vertical genera tsunamis
- **Investigación científica:** Comprender la física de los terremotos

---

### 4. Integración Completa con EMSC

**Servicios de EMSC implementados:**

1. **FDSN Event Web Service**
   - Endpoint: https://www.seismicportal.eu/fdsnws/event/1
   - Formatos: JSON, XML (QuakeML), Text
   - Parámetros completos de búsqueda

2. **SRCMOD Web Service**
   - Endpoint: https://seismicportal.eu/srcmodws
   - Modelos de ruptura de falla finita
   - Base de datos SRCMOD completa

3. **EventID Service**
   - Resolución de IDs entre catálogos
   - EMSC, USGS, INGV, etc.

#### Características de integración:
- **Consulta por ID:** Cualquier ID de evento (UNID, EventID)
- **Búsqueda avanzada:** Todos los parámetros FDSN soportados
- **Incluye todos los datos:**
  - `includeallorigins=true`
  - `includeallmagnitudes=true`
  - `includearrivals=true`

---

## 📊 Ejemplos de Uso Avanzado

### Caso 1: Investigación de un Evento Específico

**Objetivo:** Obtener toda la información disponible sobre el terremoto de Chile 2010

```bash
# 1. Obtener detalles completos
curl "http://localhost:8000/events/20100227_0000033/detail"

# 2. Obtener modelo de ruptura
curl "http://localhost:8000/events/20100227_0000033/rupture"
```

**Resultado:**
- Información completa del M8.8 Maule, Chile
- 127 estaciones usadas, 384 fases
- Modelo de ruptura con 480 subfallas
- Slip máximo de 18 metros
- Falla de tipo thrust (reversa)

### Caso 2: Monitoreo de Ciudad con Espectrogramas

**Objetivo:** Monitorear actividad sísmica en tiempo real en Tokyo

```bash
# 1. Acceder al dashboard
# http://localhost:3008/spectrograms

# 2. Buscar "Tokyo" en el selector
# 3. Agregar a la vista

# 4. Observar espectrograma en tiempo real
# - Frecuencias bajas (0.1-1 Hz): Ruido océano, viento
# - Frecuencias medias (1-5 Hz): Ruido cultural, tráfico
# - Frecuencias altas (5-20 Hz): Eventos locales, explosiones
```

### Caso 3: Análisis de Secuencia Sísmica

**Objetivo:** Analizar una secuencia de réplicas

```bash
# 1. Obtener evento principal
curl "http://localhost:8000/events/{mainshock_id}/detail"

# 2. Buscar eventos en la región
curl "http://localhost:8000/events/search?\
sources=usgs,emsc&\
minmag=4.0&\
minlat=-35&maxlat=-30&\
minlon=-72&maxlon=-68&\
windowMinutes=10080"  # 7 días

# 3. Analizar distribución espacial
# - Eventos al norte y sur del mainshock
# - Profundidades similares
# - Magnitudes decrecientes
```

---

## 🚀 Flujos de Trabajo Profesionales

### Para Sismólogos:

1. **Análisis de Evento:**
   ```
   /events/{id}/detail → Obtener parámetros completos
   /events/{id}/rupture → Analizar modelo de ruptura
   /spectrograms → Verificar señales en estaciones cercanas
   ```

2. **Monitoreo de Región:**
   ```
   /events/search → Filtrar por región y magnitud
   /explore → Visualizar en mapa interactivo
   /spectrograms → Monitorear actividad continua
   ```

### Para Investigadores:

1. **Estudio de Falla:**
   ```
   - Obtener múltiples eventos en una falla
   - Comparar modelos de ruptura
   - Analizar patrones de slip
   - Correlacionar con geología
   ```

2. **Análisis de Peligro:**
   ```
   - Identificar ciudades en zonas de alto riesgo
   - Monitorear espectrogramas 24/7
   - Detectar anomalías pre-sísmicas
   - Evaluar respuesta estructural
   ```

### Para Aficionados Expertos:

1. **Seguimiento de Eventos:**
   ```
   - Recibir notificación de evento
   - Buscar por ID en /events/{id}/detail
   - Revisar magnitudes de diferentes agencias
   - Ver modelo de ruptura si disponible
   ```

2. **Exploración:**
   ```
   - Navegar mapa interactivo (/explore)
   - Filtrar eventos por parámetros
   - Exportar datos a CSV
   - Analizar tendencias
   ```

---

## 🔧 Configuración Avanzada

### Variables de Entorno (.env):

```bash
# EMSC Configuration
EMSC_FDSN_URL=https://www.seismicportal.eu/fdsnws/event/1
EMSC_SRCMOD_URL=https://seismicportal.eu/srcmodws

# Timeouts
EMSC_TIMEOUT_SECONDS=30

# Cache (opcional)
ENABLE_EVENT_CACHE=true
CACHE_TTL_SECONDS=300
```

### Optimizaciones:

1. **Caché de Eventos:**
   - Guardar eventos consultados frecuentemente
   - TTL configurable (default: 5 minutos)
   - Reduce carga en servidores EMSC

2. **Parallel Fetching:**
   - Consultar múltiples fuentes en paralelo
   - Timeout individual por fuente
   - Deduplicación inteligente

3. **Rate Limiting:**
   - Respetar límites de EMSC (fair use)
   - Implementar backoff exponencial
   - Queueing de requests

---

## 📈 Métricas y Monitoreo

**Métricas Prometheus disponibles:**

```
# Eventos consultados por ID
seismic_monitor_event_detail_requests_total{status="200|404"}

# Modelos de ruptura encontrados
seismic_monitor_rupture_models_found_total

# Errores de EMSC
seismic_monitor_emsc_errors_total{type="timeout|connection|parse"}

# Latencia de respuesta
seismic_monitor_emsc_request_duration_seconds{endpoint="event|rupture"}
```

---

## 🆘 Troubleshooting

### Evento no encontrado (404):
```
Error: Event 20231206_0000091 not found
```

**Posibles causas:**
1. ID incorrecto o formato no reconocido
2. Evento no en catálogo EMSC
3. Evento muy reciente (aún procesándose)

**Soluciones:**
- Verificar ID en https://www.seismicportal.eu/
- Intentar con diferentes formatos de ID
- Esperar 2-5 minutos si es muy reciente
- Usar `/events/search` para encontrar el evento

### Modelo de ruptura no disponible:
```
Error: No rupture model available for event
```

**Es normal:**
- Solo ~1% de eventos tienen modelo de ruptura
- Requiere M > 6.5 generalmente
- Datos suficientes para inversión
- Publicación científica

**Alternativas:**
- Usar datos del evento principal
- Consultar USGS Finite Fault
- Buscar publicaciones científicas

### Espectrograma no se actualiza:
```
Spectrogram stuck or not updating
```

**Soluciones:**
1. Refrescar la página (F5)
2. Verificar conexión a internet
3. Revisar console del navegador
4. Verificar que el backend esté corriendo

---

## 📚 Referencias y Documentación

**EMSC Services:**
- FDSN Event: https://seismicportal.eu/fdsn-wsevent.html
- SRCMOD: https://seismicportal.eu/srcmodws/
- GitHub: https://github.com/EMSC-CSEM/webservices101

**SRCMOD Database:**
- Website: http://equake-rc.info/SRCMOD/
- Papers: Martin Mai et al.

**FDSN Specification:**
- Event Web Service: https://www.fdsn.org/webservices/
- Standards: FDSN Working Group II

**Seismic Data:**
- IRIS DMC: https://ds.iris.edu/
- USGS ComCat: https://earthquake.usgs.gov/
- ISC: http://www.isc.ac.uk/

---

## ✅ Resumen de Capacidades

### Backend API:
- ✅ Obtención de eventos por ID
- ✅ Información detallada completa
- ✅ Modelos de ruptura (SRCMOD)
- ✅ Múltiples magnitudes y orígenes
- ✅ Datos de calidad y evaluación
- ✅ Integración EMSC completa

### Frontend:
- ✅ Dashboard de espectrogramas
- ✅ 30 ciudades de alto riesgo
- ✅ Visualización en tiempo real
- ✅ Layout configurable
- ✅ Gestión dinámica de ciudades
- ✅ Modo oscuro completo

### Documentación:
- ✅ Guía completa de uso
- ✅ Ejemplos de código
- ✅ Flujos de trabajo
- ✅ Troubleshooting
- ✅ Referencias externas

---

**Sistema completo y listo para uso profesional en investigación sísmica!** 🌎📊🔬
