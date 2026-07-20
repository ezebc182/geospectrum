# GeoSpectrum Dashboard

**Next.js 15 + TypeScript + Tailwind CSS + Recharts + Leaflet**

Dashboard web interactivo para visualización en tiempo real de actividad sísmica.

---

## Features

- **Dashboard Principal**: KPIs, alertas, mapa de epicentros, tabla de eventos
- **Monitoreo en Vivo**: Actualización automática configurable (10s/30s/60s)
- **Análisis Avanzado**: Gráficas de magnitud vs tiempo, distribución de profundidades
- **Mapa Interactivo**: Leaflet con epicentros coloreados por magnitud
- **Modo Dark/Light**: Toggle de tema con persistencia
- **Responsive**: Diseño optimizado para mobile, tablet y desktop
- **Auto-refresh**: SWR con revalidación automática

---

## Quick Start

### Instalar dependencias

```bash
cd dashboard
npm install
```

### Configurar backend API

Editar `.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000

# Debe coincidir EXACTAMENTE con AUTH_SECRET_KEY del backend (src/config/settings.py).
# Usada por dashboard/middleware.ts (Edge) para validar la firma HS256 del JWT de
# sesión sin round-trip a /auth/me. NO llevar el prefijo NEXT_PUBLIC_ — no debe
# llegar nunca al bundle del cliente.
AUTH_SECRET_KEY=
```

### Ejecutar desarrollo

```bash
npm run dev
```

Dashboard disponible en `http://localhost:3000`

### Build producción

```bash
npm run build
npm start
```

---

## Stack Tecnológico

| Librería          | Propósito                         |
|-------------------|-----------------------------------|
| **Next.js 15**    | Framework React con App Router    |
| **TypeScript**    | Tipado estático                   |
| **Tailwind CSS**  | Styling utility-first             |
| **Recharts**      | Gráficas interactivas (scatter, bar) |
| **Leaflet**       | Mapas interactivos                |
| **React Leaflet** | Wrapper React para Leaflet        |
| **SWR**           | Data fetching con cache           |
| **Lucide React**  | Iconos                            |
| **date-fns**      | Formateo de fechas                |
| **next-themes**   | Dark mode                         |

---

## Estructura

```
dashboard/
├── app/
│   ├── page.tsx              # Dashboard principal
│   ├── live/page.tsx         # Monitoreo en vivo
│   ├── analytics/page.tsx    # Análisis avanzado
│   ├── layout.tsx            # Layout principal
│   ├── providers.tsx         # Theme provider
│   └── globals.css           # Estilos globales
├── components/
│   ├── Header.tsx            # Header con navegación
│   ├── KPICard.tsx           # Card de KPI individual
│   ├── AlertBanner.tsx       # Banner de alertas
│   ├── EventsTable.tsx       # Tabla de eventos
│   ├── SeismicMap.tsx        # Mapa Leaflet
│   ├── MagnitudeTimeChart.tsx       # Gráfica magnitud vs tiempo
│   └── DepthDistributionChart.tsx   # Distribución de profundidades
├── lib/
│   ├── api.ts                # Cliente API
│   ├── types.ts              # Tipos TypeScript
│   └── utils.ts              # Utilidades
├── public/                   # Assets estáticos
└── package.json
```

---

## Componentes Principales

### Dashboard Principal (`/`)

- **KPIs**: Total eventos, magnitud máxima, profundidad media, eventos sentidos
- **Alertas**: Banner con alertas activas (enjambres, eventos significativos)
- **Mapa**: Epicentros con círculos coloreados por magnitud
- **Tabla**: Eventos recientes con filtros

### Monitoreo en Vivo (`/live`)

- **Auto-refresh**: Actualización configurable (10s/30s/60s)
- **Mapa grande**: Vista ampliada de epicentros
- **Feed de eventos**: Stream en tiempo real
- **Alertas activas**: Destacadas en tiempo real

### Análisis Avanzado (`/analytics`)

- **Magnitud vs Tiempo**: Scatter plot interactivo
- **Distribución de Profundidades**: Bar chart por rangos
- **Tabla completa**: Todos los eventos con ordenamiento

---

## Customización

### Colores de Magnitud

Editar `lib/utils.ts`:

```typescript
export function getMagnitudeColor(mag: number): string {
  if (mag >= 7) return '#b91c1c'; // M7+ catastrófico
  if (mag >= 6) return '#dc2626'; // M6+ destructivo
  if (mag >= 5) return '#f59e0b'; // M5+ severo
  // ...
}
```

### Intervalo de Refresh

Editar `app/page.tsx`:

```typescript
const { data } = useSWR('/report', reportFetcher, {
  refreshInterval: 60000, // Cambiar a tu preferencia
});
```

### Tema por Defecto

Editar `app/providers.tsx`:

```typescript
<ThemeProvider attribute="class" defaultTheme="dark"> // light | dark | system
```

---

## Deployment

### Vercel (Recomendado)

```bash
# Conectar repo y deploy automático
vercel --prod
```

### Docker

```bash
# Build
docker build -t seismic-dashboard .

# Run
docker run -p 3000:3000 -e NEXT_PUBLIC_API_URL=http://api:8000 seismic-dashboard
```

### Docker Compose

Agregar al `docker-compose.yml` principal:

```yaml
dashboard:
  build:
    context: ./dashboard
  ports:
    - "3000:3000"
  environment:
    NEXT_PUBLIC_API_URL: http://geospectrum:8000
  depends_on:
    - geospectrum
```

---

## API Client

El dashboard consume la API del backend FastAPI:

| Endpoint     | Método | Descripción                     |
|--------------|--------|---------------------------------|
| `/report`    | GET    | Reporte completo (KPIs + alertas + eventos) |
| `/events`    | GET    | Solo eventos                    |
| `/alerts`    | GET    | Solo alertas                    |
| `/health`    | GET    | Health check                    |

Cliente tipado en `lib/api.ts` con SWR para cache automático.

---

## Performance

- **Code Splitting**: Automático por página (Next.js)
- **Image Optimization**: next/image para assets
- **SWR Cache**: Reduce requests redundantes
- **Dynamic Imports**: Leaflet cargado solo client-side
- **Tailwind Purge**: CSS mínimo en producción

---

## Troubleshooting

### Leaflet no se muestra

Verificar que `leaflet.css` se está cargando:

```typescript
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
```

### API no responde

Verificar `.env.local`:

```bash
NEXT_PUBLIC_API_URL=http://localhost:8000
```

Y que el backend esté corriendo:

```bash
curl http://localhost:8000/health
```

### Dark mode no persiste

Verificar que `next-themes` está instalado:

```bash
npm install next-themes
```

---

## Roadmap

- [ ] Export PDF de reportes
- [ ] Notificaciones push (Web Push API)
- [ ] Filtros avanzados de eventos
- [ ] Comparación histórica (última hora vs última semana)
- [ ] Predicción de réplicas (ML)

---

## License

MIT
