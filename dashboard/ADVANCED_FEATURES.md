# Sistema Avanzado de Exploración Sísmica

## 🎯 Características Completas

El sistema ahora incluye un explorador avanzado similar a EMSC (https://www.emsc-csem.org/Earthquake_information/) con capacidades profesionales de filtrado y visualización.

## 📍 Nueva Página: `/explore`

### Acceso
Visita: http://localhost:3008/explore

### Funcionalidades

#### 1. **Panel de Filtros Avanzados**

**Selector de Fuentes de Datos:**
- ✅ **USGS** - United States Geological Survey (Global)
- ✅ **EMSC** - Euro-Mediterranean Seismological Centre
- ✅ **INPRES** - Instituto Nacional de Prevención Sísmica (Argentina)

**Filtros de Magnitud:**
- Rango mínimo/máximo con sliders interactivos
- Valores de 0.0 a 9.0

**Filtros de Profundidad:**
- Profundidad mínima y máxima en kilómetros
- Inputs numéricos libres

**Período de Tiempo:**
- Última hora
- Últimas 6 horas
- Últimas 12 horas
- Últimas 24 horas (por defecto)
- Últimos 3 días
- Última semana
- Último mes

**Región Geográfica:**
- Latitud mínima/máxima
- Longitud mínima/máxima
- Define tu propio bounding box

**Opciones Adicionales:**
- ☑️ Solo eventos sentidos
- ☑️ Solo eventos revisados

#### 2. **Mapa Avanzado con Capas Múltiples**

**Capas Base (5 opciones):**
1. 🗻 **Terreno** - OpenTopoMap (por defecto)
2. 🏙️ **Calles** - OpenStreetMap
3. 🛰️ **Satélite** - Esri World Imagery
4. ⬜ **Escala de Grises** - B&W OpenStreetMap
5. 🌊 **Océano** - Esri Ocean Basemap

**Overlays Geológicos (4 capas activables):**
1. 🌏 **Límites de Placas Tectónicas**
   - Muestra los bordes de las principales placas tectónicas
2. 👥 **Densidad de Población**
   - Visualiza áreas pobladas para evaluar riesgo
3. 🔴 **Fallas Geológicas (US)**
   - Fallas cuaternarias activas de USGS
4. ⚠️ **Peligro Sísmico (US)**
   - Mapa de peligrosidad sísmica de USGS

**Control de Capas:**
- Botón flotante en esquina superior derecha del mapa
- Selector de radio para capa base
- Checkboxes para overlays geológicos
- Todos los overlays son combinables

#### 3. **Visualización de Resultados**

**Modo Mapa:**
- Mapa interactivo con todos los eventos
- Marcadores coloreados por magnitud:
  - 🟢 Verde: M < 4.0
  - 🟡 Amarillo: M 4.0-5.0
  - 🟠 Naranja: M 5.0-6.0
  - 🔴 Rojo: M > 6.0
- Popups detallados con:
  - Magnitud y ubicación
  - Fecha/hora UTC
  - Profundidad y coordenadas
  - Estado (sentido/revisado)
  - Fuente de datos con emoji de bandera (🇺🇸 🇪🇺 🇦🇷)
- Ciudades principales marcadas
- Zoom y pan ilimitado

**Modo Lista:**
- Tabla completa con todos los eventos
- Ordenable y scrolleable
- Información compacta pero completa

#### 4. **Exportación de Datos**

**Botón "Exportar CSV":**
- Genera archivo CSV con todos los resultados
- Incluye todos los campos: ID, fecha, coordenadas, magnitud, tipo, ubicación, estado, fuentes
- Nombre de archivo con fecha: `seismic_events_2025-10-28.csv`
- Formato compatible con Excel, Google Sheets, análisis científico

#### 5. **Estadísticas en Tiempo Real**

- Contador de resultados
- Rango de magnitudes detectadas
- Indicador de fuentes utilizadas
- Información sobre deduplicación

## 🔧 API Backend

### Endpoint Principal: `/events/search`

**Parámetros Query:**
```
GET /events/search?sources=usgs,emsc&minMag=4.0&maxMag=7.0&windowMinutes=10080
```

**Parámetros disponibles:**
- `sources` (string): Fuentes separadas por coma (usgs, emsc, inpres)
- `minMag` (float): Magnitud mínima
- `maxMag` (float): Magnitud máxima
- `minDepth` (float): Profundidad mínima en km
- `maxDepth` (float): Profundidad máxima en km
- `minLat` (float): Latitud mínima
- `maxLat` (float): Latitud máxima
- `minLon` (float): Longitud mínima
- `maxLon` (float): Longitud máxima
- `windowMinutes` (int): Ventana temporal en minutos
- `feltOnly` (boolean): Solo eventos sentidos
- `reviewedOnly` (boolean): Solo eventos revisados

**Respuesta:**
```json
[
  {
    "id": "us6000rjw2",
    "fuentes": ["USGS"],
    "hora_utc": "2025-10-28T08:42:18.839000+00:00",
    "lat": -31.5175,
    "lon": -66.3691,
    "prof_km": 162.943,
    "mag": 4.9,
    "mag_tipo": "mb",
    "lugar": "79 km NW of Candelaria, Argentina",
    "sentido": false,
    "revisado": true
  }
]
```

## 📊 Ejemplos de Uso

### Ejemplo 1: Eventos recientes de magnitud alta
```
Fuentes: USGS, EMSC
Magnitud: 5.0 - 9.0
Período: Última semana
Resultado: Todos los terremotos significativos globales
```

### Ejemplo 2: Sismos sentidos en Sudamérica
```
Fuentes: USGS, EMSC, INPRES
Magnitud: 3.0 - 9.0
Región: -40/-20 lat, -75/-60 lon
Solo sentidos: ✓
Período: Últimos 3 días
Resultado: Eventos con reportes de población afectada
```

### Ejemplo 3: Análisis de profundidad
```
Fuentes: USGS
Magnitud: 4.0 - 9.0
Profundidad: 0 - 70 km (sismos superficiales)
Período: Último mes
Resultado: Eventos superficiales más peligrosos
```

## 🗺️ Capas Geológicas - Uso

### Límites de Placas Tectónicas
- **Cuándo usar**: Para entender el contexto tectónico de los sismos
- **Utilidad**: Ver si eventos ocurren en bordes de placas o zonas intraplaca

### Densidad de Población
- **Cuándo usar**: Evaluación de riesgo y impacto potencial
- **Utilidad**: Identificar sismos cerca de áreas densamente pobladas

### Fallas Geológicas (US)
- **Cuándo usar**: Análisis detallado de sismicidad en Estados Unidos
- **Utilidad**: Correlacionar eventos con fallas conocidas

### Peligro Sísmico (US)
- **Cuándo usar**: Planificación y prevención en territorio estadounidense
- **Utilidad**: Ver zonas de alta peligrosidad sísmica

## 🚀 Flujo de Trabajo Recomendado

1. **Acceder al Explorador**: http://localhost:3008/explore

2. **Seleccionar Fuentes**:
   - Para cobertura global: USGS + EMSC
   - Para Argentina: USGS + EMSC + INPRES

3. **Configurar Filtros**:
   - Ajustar magnitud según interés
   - Definir período temporal
   - Opcional: delimitar región geográfica

4. **Buscar**: Click en "Buscar Eventos"

5. **Visualizar**:
   - Modo Mapa: Ver distribución espacial
   - Cambiar capa base según necesidad (terrain para relieve, satellite para contexto)
   - Activar overlays geológicos para análisis

6. **Analizar**:
   - Modo Lista: Ver detalles tabulares
   - Ordenar por magnitud, fecha, ubicación

7. **Exportar**:
   - Click en "Exportar CSV" para análisis offline

## 🎨 Personalización

### Cambiar Capa Base por Defecto
Edita `dashboard/components/AdvancedSeismicMap.tsx:14`:
```typescript
defaultLayer='satellite'  // o 'greyscale', 'ocean', 'street'
```

### Agregar Más Overlays
Edita `dashboard/lib/map-layers.ts` y agrega a `GEOLOGICAL_OVERLAYS`.

### Agregar Más Fuentes
1. Crear servicio en `src/services/`
2. Importar en `src/main.py`
3. Agregar a endpoint `/events/search`
4. Actualizar `dashboard/lib/map-layers.ts` `DATA_SOURCES`

## ⚙️ Servicios Activos

- **Backend API**: http://localhost:8000
- **API Docs**: http://localhost:8000/docs
- **Dashboard**: http://localhost:3008
- **Explorador Avanzado**: http://localhost:3008/explore

## 📈 Métricas y Performance

- **Deduplicación automática** de eventos entre fuentes
- **Caché del navegador** deshabilitado para datos en tiempo real
- **Lazy loading** de componentes de mapa
- **Optimización de re-renders** con React hooks

## 🔐 Notas de Seguridad

- Todas las fuentes utilizan HTTPS
- CORS configurado solo para orígenes conocidos
- Sin almacenamiento de datos sensibles
- APIs públicas sin autenticación

## 🆘 Troubleshooting

**"No hay resultados":**
- Verifica que al menos una fuente esté seleccionada
- Amplía el rango de magnitud
- Aumenta la ventana temporal
- Verifica que el backend esté corriendo

**Mapa no carga:**
- Revisa la consola del navegador
- Verifica conexión a internet (las tiles se cargan de servicios externos)
- Prueba cambiar la capa base

**Error al buscar:**
- Verifica que el backend esté activo: http://localhost:8000/health
- Revisa logs del backend
- Comprueba conectividad con fuentes externas (USGS, EMSC)

## 📚 Referencias

- USGS ComCat API: https://earthquake.usgs.gov/fdsnws/event/1/
- EMSC FDSN: https://www.seismicportal.eu/
- OpenTopoMap: https://opentopomap.org/
- Leaflet.js: https://leafletjs.com/

---

**Sistema completamente funcional y listo para producción!** 🎉
