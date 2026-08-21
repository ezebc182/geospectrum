# Detalle de estación estilo SWARM

**Fecha:** 2026-08-20 · **Estado:** aprobado por diseño en chat · **Base:** SWARM v3.4.0 (USGS, CC0) — guía oficial + fuente de `swarm`/`volcano-core` ya inventariado (ver memoria `inventario-reutilizables-swarm`).

## Objetivo

Al hacer clic en una tarjeta del muro (o al confirmar una ciudad en Add City), abrir una vista de detalle de la estación con las cuatro vistas clásicas de SWARM: **Helicorder**, **Espectrograma**, **Onda + Espectro** y **RSAM**. Filosofía SWARM: defaults sensatos + configuración manual del usuario, sin magia adaptativa.

## Decisiones ya tomadas (usuario, 2026-08-20)

1. Forma de UI: **página de detalle con pestañas** (no workspace multi-panel).
2. Alcance v1: **las cuatro pestañas** entran.
3. Los parámetros espectrales y de escala son los de SWARM, ya portados en `src/services/swarm_spectra.py` (PR #25).

## Ruta y navegación

- Ruta nueva: `/stations/[channel]` (App Router, grupo `(app)`, protegida como el resto).
- `channel` = ID SCNL completo (`IU.MAJO.00.BHZ`), URL-encoded.
- Entrada: clic en la tarjeta del muro (`/live`) y link en el flujo Add City. La tarjeta conserva su comportamiento actual; el clic navega.
- Header del detalle: ciudad, SCNL, estado live/estático, selector de pestaña. i18n ES/EN con next-intl como el resto de la app.

## Backend (FastAPI)

### Nuevos endpoints

1. **`GET /stations/{channel}/waveform?minutes=&filter=`**
   - Fuente: FDSN dataselect vía ObsPy (cliente existente), cache TTL tipo espectrograma.
   - Respuesta: forma de onda **decimada min/max por píxel** (`{times, mins, maxs, sampling_rate, unit}`) — nunca crudo de 8.6M muestras al navegador.
   - `filter=bp` aplica Butterworth paridad SWARM: orden 4, 1–10 Hz, `scipy.signal.filtfilt` (zero-phase). Sin filtro por defecto.
   - Sirve a Helicorder (24h) y a WaveView (ventanas cortas con zoom).

2. **`GET /stations/{channel}/rsam?hours=`**
   - Módulo nuevo `src/services/swarm_rsam.py` (TDD): RSAM = media móvil de |señal demeaned| por período (default 600 s, como `RsamDefaults.config`).
   - Detector de eventos `countEvents` paridad SWARM: evento si `v >= threshold && v >= v[i-2] * ratio` (defaults threshold=50, ratio=1.3, maxLength=300 s).
   - Respuesta: `{times, rsam, events: [{time}], threshold}`.

3. **`GET /stations/{channel}/spectra?start=&end=&filter=`**
   - Espectro FFT de la ventana exacta pedida (para la pestaña Onda+Espectro): Kaiser beta=5 sobre la ventana completa, `20·log10`, ejes log-log (defaults SWARM: 0–25 Hz).
   - Se calcula sobre la señal SIN decimar en el backend — el cliente nunca computa FFT sobre datos decimados.

4. **Espectrograma**: reusa `/spectrograms/{channel}/history` + WS `/ws/spectrogram/{channel}` tal cual (nada nuevo).

### Restricciones

- Memoria: toda decimación se hace server-side; ningún endpoint nuevo puede retener arrays > ~70 MB transitorios (lección del OOM, PR #25).
- El waveform de 24 h se decima a `width*2` puntos min/max ANTES de serializar.

## Frontend

### Componentes (lógica de dibujo en libs puras testeables, patrón jet2/spectrogram-scale)

1. **`HelicorderCanvas`** + `lib/helicorder-layout.ts`:
   - Filas de `timeChunk` (default 30 min; opciones 15/30/60) con wrap modular del tiempo (paridad `HelicorderRenderer.java`).
   - Bias re-calculado POR FILA; clipping clampado y pintado en rojo (`clipValue` auto: percentil alto de |amplitud| del día).
   - Colores: ciclo de 4 azules `rgb(0,0,255)/(0,0,205)/(0,0,155)/(0,0,105)`, fondo blanco.
   - Ticks por densidad SWARM: ≤30 min → mayor por minuto; <180 → 5 min; <360 → 10 min; ≥360 → 20 min. Hora local a la izquierda, UTC a la derecha.
2. **Espectrograma grande**: reusa las columnas y `jet2`/`powerDbToT`; agrega ejes tiempo/frecuencia y colorbar 20–120 dB.
3. **`WaveView`** + `lib/waveform-scale.ts`: render min/max, zoom por arrastre (caja amarilla `rgba(255,255,0,0.5)`, paridad SWARM) que re-pide la ventana al backend; toggle Butterworth; espectro FFT log-log de la ventana visible (pedido al endpoint /spectra con la ventana exacta).
4. **`RsamChart`**: línea con umbral rojo horizontal y marcas de eventos contados.

### Settings manuales (filosofía SWARM)

- Panel por pestaña con defaults de `WaveDefaults.config`/`RsamDefaults.config`, editables y persistidos en `localStorage` por canal:
  - Helicorder: `timeChunk`, `barMult` (exageración de amplitud), `clipValue` manual.
  - Espectrograma: min/max power (default 20/120), min/max freq (default 0/25).
  - RSAM: período, threshold, ratio.
- v1 NO incluye: picking P/S/coda, clipboard multi-onda, particle motion, kiosk, alarmas de audio (quedan para fases siguientes; el inventario ya tiene los parámetros).

## Testing

- TDD en todo: `swarm_rsam.py` con señales sintéticas (media conocida, eventos fabricados que el detector debe contar y falsos graduales que NO); decimación min/max (extremos preservados); `helicorder-layout` (mapeo tiempo↔fila/píxel, wrap modular, elección de ticks); `waveform-scale` (zoom, clamp).
- Integración ligera de endpoints con los patrones existentes de `tests/unit` (sin red: streams sintéticos ObsPy).
- Verificación por mutación en los detectores (lección de memoria: tests verdes con la feature rota no cuentan).

## Entrega (4 PRs)

1. **PR A — Helicorder**: endpoint waveform + página `/stations/[channel]` con pestañas (solo Helicorder activa) + libs + tests.
2. **PR B — Espectrograma grande**: pestaña con ejes/colorbar; reuso de history/WS.
3. **PR C — Onda + Espectro**: zoom, Butterworth, espectro de ventana.
4. **PR D — RSAM**: `swarm_rsam.py` + endpoint + chart + settings.

## Fuera de alcance (fases futuras)

Picking P/S/coda con S-P→distancia y coda→magnitud, clasificaciones de eventos (paleta de 15 tipos), clipboard, particle motion, modo kiosk, alarmas sonoras, chooser/agrupación por región.
