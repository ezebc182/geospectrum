# Muro SPECTRONET: tiras apiladas, armador manual, métricas de dominio y foco de eventos

**Fecha:** 2026-08-20 · **Estado:** diseño aprobado en chat · **Referencia visual:** muro de SPECTRONET.ORG (2018) — columnas por región, tiras finas apiladas sin gaps, etiqueta blanca sobre negro a la izquierda.

## Decisiones del usuario (2026-08-20)

1. Prioridad: este trabajo va ANTES que el PR A del helicorder (que queda planificado en `docs/superpowers/plans/2026-08-20-station-detail-pr-a-helicorder.md`).
2. Persistencia de muros: **servidor, por usuario** (tabla + CRUD), para dejar la cartelera corriendo en cualquier dispositivo.
3. Layout: **columnas por región con encabezados de grupo** (réplica SPECTRONET).
4. Métricas: reemplazar los badges vagos (Extreme/High) por métricas específicas del consumidor de sismología/vulcanología.
5. Foco de eventos en /globe **configurable**: rotación aleatoria entre últimos eventos, o fijo en el último recibido moviéndose solo al llegar uno nuevo.

## 1. Tira SPECTRONET (`SpectronetStrip`)

- Wrapper del `LiveSpectrogramCanvas` variante `strip` existente, con la etiqueta FUERA del canvas: columna de texto a la izquierda (nombre de estación/ciudad, blanco sobre negro, mayúsculas, tipografía condensada), tira de espectrograma a la derecha.
- Altura de tira: ~28 px; **cero gap vertical** entre tiras del mismo grupo.
- Banda de métricas compacta opcional (toggle global del muro): RSAM · FI · latencia (ver §3).
- Estado sin datos: la etiqueta queda y el área de tira va en negro con un punto rojo — el muro no "salta" cuando una estación se cae (el failover existente sigue actuando por debajo).

## 2. Layout de muro y armador manual

### Modelo de datos (servidor)

Tabla `walls`:

```sql
CREATE TABLE walls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    layout JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
```

`layout` (JSONB):

```json
{
  "columns": [
    {
      "groups": [
        { "title": "KAMCHATKA", "channels": ["IU.PET.00.BHZ"] },
        { "title": "JAPÓN", "channels": ["IU.MAJO.00.BHZ", "II.ERM.00.BHZ"] }
      ]
    }
  ],
  "showMetrics": true
}
```

- Validación server-side: máx. 8 columnas, máx. 120 canales por muro, canales con formato SCNL.
- Endpoints: `GET /walls` (los del usuario), `POST /walls`, `PUT /walls/{id}`, `DELETE /walls/{id}` — ownership por usuario (patrón de áreas de interés existente).
- **Muro default de fábrica** "Global" (no editable, `id` reservado `global`): las estaciones vivas del catálogo agrupadas por región, generado server-side desde `LIVE_CANDIDATES_BY_CITY` — así /globe funciona sin configurar nada.

### Armador (en `/spectrograms`)

- v1 sin drag & drop: panel con el catálogo de canales (los de `live-channels` + búsqueda), botones para agregar a un grupo, crear/renombrar grupos y columnas, reordenar con flechas ↑/↓, quitar.
- Preview en vivo del muro mientras se arma (mismas tiras reales).
- Guardar con nombre / duplicar un muro existente (incluido duplicar el default para editarlo).

### Renderizado del muro

- `/globe` (cartelera): selector de muro guardado (default: "Global"); el muro elegido reemplaza el grid actual de tiras. Selección persistida en `localStorage` + query param `?wall=<id>` para kiosks.
- `/spectrograms`: pestaña/vista "Muro" con el mismo componente, además de la vista de tarjetas existente.
- Columnas verticales con encabezado de grupo (texto blanco, fondo negro, borde fino); las tiras del grupo apiladas sin gap; scroll vertical si no entra.

## 3. Métricas de dominio (por estación)

Todas derivan de datos existentes o del módulo `swarm_rsam.py` (se adelanta del PR D del detalle de estación):

| Métrica | Definición | Fuente |
|---|---|---|
| RSAM | media móvil de \|señal demeaned\| por período (default 600 s, `RsamDefaults.config`) | `swarm_rsam.py` sobre el buffer del ingestor |
| Frecuencia dominante (Hz) | frecuencia del bin de mayor potencia de la última columna | columna espectral |
| Frequency Index | `log10(mean_dB(5–15 Hz) / mean_dB(1–5 Hz))` — negativo = LP/fluidos, positivo = VT/fractura | columna espectral |
| Pico dB | máximo de la última columna (comparable entre estaciones por la escala fija 20–120) | columna espectral |
| Eventos/hora | `countEvents` paridad SWARM: `v >= threshold && v >= v[i-2]*ratio` (threshold=50, ratio=1.3) | RSAM |
| Latencia (s) | ahora − timestamp de la última columna | watchdog/columna |

- Distribución: el ingestor calcula RSAM/métricas por canal y las publica en un canal Redis `metrics:{channel}` + endpoint `GET /stations/{channel}/metrics` (snapshot). El frontend las recibe por el WS existente o polling ligero (decisión de diseño fino en el plan).
- En la tarjeta de `/spectrograms`: fila de métricas completa reemplaza el badge Extreme/High.
- En la tira del muro: banda compacta `RSAM · FI · lat` si `showMetrics`.

## 4. Foco de eventos en /globe (configurable)

Dos modos, seleccionables en la UI de broadcast y persistidos en `localStorage` + query param `?focus=`:

- **`random`** (default): cada N segundos (default 20) la cámara apunta a un evento elegido al azar entre los últimos M eventos (default 20, últimas 24 h), con su ring de magnitud.
- **`latest`**: la cámara queda FIJA en el último evento recibido; solo se mueve (transición animada) cuando entra un evento nuevo por el feed de 30 s.
- El modo y sus parámetros viven en un objeto `FocusConfig` testeable (elección del próximo objetivo separada de la animación de cámara, para testear sin three.js).

### Sincronización globo ↔ sidebar

- Al hacer **clic en un evento del globo**, la fila correspondiente del sidebar de eventos se resalta y se scrollea a la vista.
- Cuando el **foco automático** (random o latest) apunta a un evento, esa fila también se resalta — el sidebar siempre cuenta QUÉ está mirando la cámara.
- Un solo estado compartido `focusedEventId` (contexto/estado del broadcast); el resaltado es un estilo de fila, no una re-consulta.

## 5. Entrega

1. **PR-W1** — Tiras + layout SPECTRONET en `/globe` con el muro default "Global" server-side + modos de foco de eventos.
2. **PR-W2** — Tabla `walls` + migración + CRUD + armador manual en `/spectrograms` + selector de muro en `/globe`.
3. **PR-W3** — `swarm_rsam.py` + métricas por canal (ingestor → Redis → API) + banda de métricas en tiras y tarjetas.

Después retoma el PR A del helicorder (plan ya escrito).

## Fuera de alcance

Drag & drop del armador, muros públicos/compartidos entre usuarios, export de imagen del muro, alarmas sonoras por métricas.

## Restricciones heredadas

- Memoria del OOM (PR #25): nada de recomputar espectros server-side para el muro — las tiras consumen el WS/history existente.
- i18n ES/EN con paridad de claves; identificadores en inglés, comentarios en español; TDD estricto; verificación por mutación en detectores y en el Frequency Index.
