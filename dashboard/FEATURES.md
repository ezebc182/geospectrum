# Dashboard Features - GeoSpectrum

## Mapa Interactivo Profesional con Ciudades

El dashboard ahora incluye un mapa mejorado que muestra:

### 🏙️ Ciudades Principales

El mapa muestra las ciudades más importantes de la región sísmica de Sudamérica:

**Argentina:**
- Buenos Aires, Córdoba, Rosario, Mendoza, San Juan, Tucumán, Salta, Mar del Plata, Neuquén

**Chile:**
- Santiago, Valparaíso, Concepción, Antofagasta, Temuco, Iquique, Valdivia, Coquimbo

**Perú:**
- Lima, Arequipa, Cusco, Trujillo

**Bolivia:**
- La Paz, Santa Cruz, Cochabamba

**Paraguay:**
- Asunción

**Uruguay:**
- Montevideo

### 🗺️ Capas de Mapa

El mapa incluye 3 opciones de visualización:

1. **Terreno (por defecto)** - OpenTopoMap: Mejor para análisis sísmico, muestra elevaciones y relieve
2. **Calles** - OpenStreetMap: Vista tradicional con calles y ciudades
3. **Satélite** - Esri World Imagery: Vista satelital real

### 📍 Marcadores

**Ciudades:**
- Marcadores negros cuadrados con borde blanco
- Tamaño proporcional a la población
- Labels con nombres de ciudades
- Popups con información: nombre, país, población

**Eventos Sísmicos:**
- Círculos de colores según magnitud:
  - 🟢 Verde: M < 4.0
  - 🟡 Amarillo: M 4.0 - 5.0
  - 🟠 Naranja: M 5.0 - 6.0
  - 🔴 Rojo: M > 6.0
- Tamaño proporcional a la magnitud
- Popups detallados con:
  - Magnitud
  - Ubicación
  - Fecha y hora
  - Profundidad
  - Coordenadas
  - Estado (sentido/revisado)
  - Fuente de datos

### 🎯 Región de Monitoreo

- Rectángulo rojo punteado que marca la región configurada
- Coordenadas configurables en `.env`:
  ```bash
  REGION_MINLAT=-40
  REGION_MAXLAT=-20
  REGION_MINLON=-75
  REGION_MAXLON=-60
  ```

### 📊 Leyenda Interactiva

Leyenda visual debajo del mapa que muestra:
- Escalas de magnitud con colores
- Símbolo de ciudades

## Páginas del Dashboard

### 1. Dashboard Principal (`/`)
- KPIs principales
- Alertas activas
- Mapa con ciudades y eventos
- Tabla de eventos recientes
- Auto-refresh cada 60 segundos

### 2. Monitoreo en Vivo (`/live`)
- Vista en tiempo real
- Mapa ampliado con ciudades
- Lista de eventos activos
- Refresh configurable (10s/30s/60s)
- Botón de actualización manual

### 3. Análisis (`/analytics`)
- Gráficos de magnitud vs tiempo
- Distribución de profundidad
- Análisis estadístico

## Características Técnicas

### Performance
- Carga dinámica de Leaflet (solo en cliente)
- Layer groups para organización eficiente
- Auto-limpieza de marcadores
- Optimización de re-renders

### Responsive
- Mobile-friendly
- Grid adaptativo
- Controles táctiles en mapas

### Dark Mode
- Soporte completo para tema oscuro
- Sin errores de hidratación
- Persistencia de preferencia

## Datos en Tiempo Real

El backend está obteniendo datos de:
- ✅ **USGS** (United States Geological Survey) - Global
- ⚠️ **INPRES** (en desarrollo) - Argentina local

Actualmente mostrando eventos sísmicos reales de las últimas 24 horas en la región de Sudamérica.

## Cómo Usar

1. **Iniciar Backend (Puerto 8000):**
   ```bash
   cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor
   ./scripts/run-local.sh
   ```

2. **Iniciar Dashboard (Puerto 3008):**
   ```bash
   cd dashboard
   npm install
   npm run dev
   ```

3. **Acceder:**
   - Dashboard: http://localhost:3008
   - API Backend: http://localhost:8000
   - API Docs: http://localhost:8000/docs

## Interacción con el Mapa

- **Zoom:** Rueda del ratón o controles +/-
- **Pan:** Arrastrar con el mouse
- **Información:** Click en marcadores para ver detalles
- **Cambiar capa:** Usar control de capas en esquina superior derecha
- **Filtrar:** Los eventos se actualizan automáticamente según el refresh interval
