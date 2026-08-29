# Espectrogramas: zoom, modal de ampliar y área contextual — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el espectrograma grande sea explorable (zoom/pan), que "Ampliar" abra un modal en vez de navegar, que la pantalla diga la verdad sobre qué estaciones transmiten en vivo, y cerrar el agujero de diseño que produjo tres bugs idénticos de propagación de área.

**Architecture:** El zoom se logra separando el **dominio del dato** (`frequencyAxis(columns)`) del **dominio visible** (viewport en estado de React). Las funciones `freqToFraction`/`timeToFraction` ya son puras y toman el eje por parámetro, así que no se tocan: se les pasa otro objeto eje. El modal reusa `SpectrogramLarge`, que ya existe. El agujero de área se cierra fusionando "leer el área" y "suscribirse al cambio" en un único hook indivisible.

**Tech Stack:** Next.js App Router, React 19, TypeScript, canvas 2D, vitest + testing-library, next-intl, SWR, FastAPI/Python (backend).

**Spec:** Este documento. Decisiones tomadas con el usuario en sesión 2026-08-24 (ver "Decisiones cerradas").

---

## Global Constraints

- **Idioma del código:** nombres de identificadores en inglés, comentarios en español. Los campos de la API en español son la excepción existente. (memoria: `convencion-idioma-codigo`)
- **Node:** usar el de nvm (v22.16.0), NO el del shell (v12). `export PATH` antes de correr tests. (memoria: `node-del-shell-es-viejo`)
- **Vitest:** `./node_modules/.bin/vitest` desde `dashboard/`. NUNCA `npx vitest` — se baja uno ajeno. (memoria: `npx-baja-vitest-de-internet`)
- **Python:** `./venv/bin/python -m pytest`, NO `pytest` pelado. El venv está en `venv/`, no `.venv/`. (memoria: `venv-esta-en-venv-no-punto-venv`)
- **Nunca buildear** después de los cambios (`next build` rompe el server de dev — comparten `.next`). (memoria: `next-build-rompe-el-server-de-dev`)
- **Commits:** conventional commits, sin ninguna atribución a IA.
- **i18n:** toda cadena visible va a `dashboard/messages/es.json` Y `en.json`. Paridad obligatoria.
- **Verificación por mutación:** un test que pasa no prueba nada hasta que se lo vio fallar. (memoria: `verificar-tests-por-mutacion`)
- **QA visual lo hace el usuario:** no hay MCP de navegador funcionando para canvas. Al terminar cada PR, entregar URL exacta + lista de qué mirar. (memoria: `qa-visual-lo-hace-el-usuario`)

## Decisiones cerradas

| # | Decisión | Elegido |
|---|---|---|
| 1 | Ejes del zoom | Ambos, independientes. Rueda = tiempo; Rueda+Shift = frecuencia; drag = pan |
| 2 | Zoom + WS en vivo | La vista se queda quieta. Botón "volver a vivo" para re-enganchar |
| 3 | Reset del zoom | Botón visible + doble clic + tecla Escape (los tres) |
| 4 | "Ampliar" | Abre modal con `SpectrogramLarge` + enlace al detalle de estación |
| 5 | Ciudades sin transmisión | Toggle SIEMPRE visible; "Vivo" deshabilitado con tooltip |
| 6 | Título de la página | "Espectrogramas" + renombrar ruta a `/spectrograms` con redirect |
| 7 | Selector de área | Hook `useActiveArea()` indivisible + contexto estación↔área |
| 8 | PNG/matplotlib | Borrar SOLO `generate_synthetic_spectrogram` (código muerto) |
| 9 | Eje que miente en `SpectrogramViewReal` | Arreglarlo ahora, como bug aparte |

## Hallazgos que fundamentan el plan

Verificados en esta sesión, con evidencia:

1. **El PNG NO está en el camino caliente.** `SortableSpectrogramCard.tsx:46` — `mode = chosenMode ?? (liveChannel ? 'live' : 'static')`. Sólo ~6 de 33 ciudades caen al PNG. El retiro grande ya lo hizo `live-channels`.
2. **`generate_synthetic_spectrogram` es código muerto con costo de CPU.** Backend lo renderiza con matplotlib (`spectrogram_service.py:692-775`, `plt.savefig` en `:763`); frontend lo descarta SIEMPRE (`SpectrogramViewReal.tsx:74`: `metadata?.network !== 'SYNTHETIC'`).
3. **"Ampliar" nunca fue un modal.** `SortableSpectrogramCard.tsx:151-158` es un `<Link href="/stations/...">`. Navega por diseño.
4. **Toggle y Ampliar sólo existen con canal vivo.** Líneas 114 y 150: ambos guardados por `{liveChannel && ...}`.
5. **El selector de área YA está en `/stations/[channel]`.** `app/(app)/layout.tsx:33` monta `<AreaHeader/>`; sólo hay 2 layouts. La página no lo consume: no importa `useAreaRefresh` ni `lib/areas`.
6. **Tres bugs idénticos por diseño opt-in.** `/explore` (cerrado, comentario en `explore/page.tsx:111-112`), `focusArea` en el overlay (cerrado `50632ee`), `/stations/[channel]` (abierto). Cuarto residual: `GlobeBroadcastOverlay.tsx:217` lee SWR pero no llama `useAreaRefresh` — grep confirmado, cero coincidencias.
7. **Cero tests del camino PNG.** No existe test de `GET /spectrograms/{city_id}` ni de las funciones matplotlib. `test_spectrogram_generated_at.py` inspecciona el fuente, no lo ejecuta.
8. **Cache key sin lat/lon.** `main.py:2600-2607` usa `spectrogram:{city_id}:{duration_hours}`, ignorando `latitude`, `longitude`, `network` que están en la firma (`:2588`).
9. **`useAreaRefresh` está bien escrito.** `handlerRef` evita re-suscripción, `runIdRef` descarta revalidaciones obsoletas, `mountedRef` evita setState post-unmount. No hay que arreglarlo — hay que hacer imposible olvidarlo.

---

## Alcance: cinco PRs independientes

Cada uno sale solo, se testea solo, se mergea solo. **No hacer un PR monolítico.**

| PR | Título | Depende de | Riesgo |
|----|--------|-----------|--------|
| A | Zoom y pan en `SpectrogramLarge` | — | Medio (perf) |
| B | Modal de "Ampliar" + honestidad del toggle | A | Bajo |
| C | Renombre `/spectrograms-live` → `/spectrograms` | — | Bajo |
| D | `useActiveArea()` + contexto estación↔área | — | Bajo |
| E | Borrar el sintético + arreglar el eje que miente | — | Bajo |

**Orden recomendado:** A → B (B necesita el zoom dentro del modal), y C/D/E en paralelo o cuando se quiera.

## Estructura de archivos

### PR A — Zoom y pan

- **Crear** `dashboard/lib/spectrogram-viewport.ts` — lógica pura del viewport (zoom, pan, clamp, reset). Sin React, sin canvas: todo testeable como función.
- **Crear** `dashboard/lib/spectrogram-viewport.test.ts`
- **Modificar** `dashboard/components/SpectrogramLarge.tsx` — estado de viewport, handlers de rueda/drag/teclado, clipping, filtro de columnas visibles.
- **Modificar** `dashboard/components/SpectrogramLarge.test.tsx`
- **Modificar** `dashboard/messages/es.json`, `en.json`

**Por qué un archivo aparte para el viewport:** las funciones de zoom/pan son matemática pura y son donde están los bugs sutiles (clamp invertido, zoom que no respeta el punto bajo el cursor). Aisladas se testean sin montar un canvas ni simular eventos. Es el mismo criterio con el que ya se separaron `spectrogram-time-axis.ts` y `spectrogram-frequency-axis.ts`.

### PR B — Modal de Ampliar

- **Crear** `dashboard/components/SpectrogramModal.tsx`
- **Crear** `dashboard/components/SpectrogramModal.test.tsx`
- **Modificar** `dashboard/components/SortableSpectrogramCard.tsx`
- **Modificar** `dashboard/components/SortableSpectrogramCard.test.tsx`
- **Modificar** `dashboard/messages/es.json`, `en.json`

### PR C — Renombre de ruta

- **Crear** `dashboard/app/(app)/spectrograms/page.tsx` (movido)
- **Crear** `dashboard/app/(app)/spectrograms-live/page.tsx` (redirect permanente)
- **Modificar** `dashboard/components/AppSidebar.tsx`, `dashboard/lib/toast-queue.ts`, tests, `messages/*.json`

### PR D — Área

- **Crear** `dashboard/lib/use-active-area.ts`
- **Crear** `dashboard/lib/use-active-area.test.ts`
- **Modificar** `dashboard/app/(app)/stations/[channel]/page.tsx`
- **Modificar** `dashboard/components/GlobeBroadcastOverlay.tsx`
- **Modificar** `dashboard/messages/es.json`, `en.json`

### PR E — Limpieza backend + eje

- **Modificar** `src/services/spectrogram_service.py` (borrar ~85 líneas)
- **Modificar** `dashboard/components/SpectrogramViewReal.tsx` (eje)
- **Crear** `tests/unit/test_no_synthetic_fallback.py`

---

# PR A — Zoom y pan en SpectrogramLarge

**Interfaces producidas (las usa PR B):**

```ts
// dashboard/lib/spectrogram-viewport.ts
export interface Viewport {
  fMin: number; fMax: number;      // frecuencia visible (Hz)
  startMs: number; endMs: number;  // tiempo visible (epoch ms)
}
export function fullViewport(f: FrequencyAxis, t: TimeAxis): Viewport
export function zoomTime(v: Viewport, factor: number, anchorFraction: number, limits: Viewport): Viewport
export function zoomFreq(v: Viewport, factor: number, anchorFraction: number, limits: Viewport): Viewport
export function panViewport(v: Viewport, dxFraction: number, dyFraction: number, limits: Viewport): Viewport
export function isFullView(v: Viewport, limits: Viewport): boolean
export function visibleColumnRange<T extends { endtime: string }>(cols: readonly T[], v: Viewport): [number, number]
```

### Task A1: Viewport puro — zoom temporal anclado al cursor

**Files:**
- Create: `dashboard/lib/spectrogram-viewport.ts`
- Test: `dashboard/lib/spectrogram-viewport.test.ts`

**Interfaces:**
- Consumes: `FrequencyAxis` de `@/lib/spectrogram-frequency-axis`, `TimeAxis` de `@/lib/spectrogram-time-axis`
- Produces: `Viewport`, `fullViewport`, `zoomTime`

- [ ] **Step 1: Escribir el test que falla**

```ts
// dashboard/lib/spectrogram-viewport.test.ts
import { describe, expect, it } from 'vitest';
import { fullViewport, zoomTime, type Viewport } from './spectrogram-viewport';

const LIMITS: Viewport = { fMin: 0, fMax: 20, startMs: 1_000_000, endMs: 2_000_000 };

describe('fullViewport', () => {
  it('arranca mostrando todo el dominio del dato', () => {
    const v = fullViewport({ fMin: 0, fMax: 20, mixedGrid: false }, { startMs: 1_000_000, endMs: 2_000_000 });
    expect(v).toEqual({ fMin: 0, fMax: 20, startMs: 1_000_000, endMs: 2_000_000 });
  });
});

describe('zoomTime', () => {
  it('acerca reduciendo el span a la mitad con factor 0.5', () => {
    const v = zoomTime(LIMITS, 0.5, 0.5, LIMITS);
    expect(v.endMs - v.startMs).toBe(500_000);
  });

  it('mantiene bajo el cursor el instante que estaba bajo el cursor', () => {
    // El punto al 25% del ancho es 1_250_000. Tras el zoom debe seguir al 25%.
    const v = zoomTime(LIMITS, 0.5, 0.25, LIMITS);
    const instanteAl25 = v.startMs + (v.endMs - v.startMs) * 0.25;
    expect(instanteAl25).toBeCloseTo(1_250_000, 0);
  });

  it('no deja alejarse más allá del dominio del dato', () => {
    const v = zoomTime(LIMITS, 4, 0.5, LIMITS);
    expect(v.startMs).toBe(LIMITS.startMs);
    expect(v.endMs).toBe(LIMITS.endMs);
  });

  it('no deja acercarse por debajo del span mínimo', () => {
    let v: Viewport = LIMITS;
    // 20 zooms de 0.5 llevarían el span a menos de 1 ms sin el piso.
    for (let i = 0; i < 20; i++) v = zoomTime(v, 0.5, 0.5, LIMITS);
    expect(v.endMs - v.startMs).toBeGreaterThanOrEqual(1000);
  });

  it('al llegar al borde derecho no se corre fuera del dominio', () => {
    const v = zoomTime(LIMITS, 0.5, 1, LIMITS);
    expect(v.endMs).toBeLessThanOrEqual(LIMITS.endMs);
    expect(v.startMs).toBeGreaterThanOrEqual(LIMITS.startMs);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: FAIL — `Failed to resolve import "./spectrogram-viewport"`.

- [ ] **Step 3: Implementación mínima**

```ts
/**
 * Viewport del espectrograma grande: QUÉ porción del dato se está mirando.
 *
 * Es un concepto distinto del EJE. El eje (`frequencyAxis`, `timeAxis`) es el
 * dominio de lo que hay en memoria; el viewport es el dominio de lo que se ve.
 * Antes del zoom coincidían siempre, y por eso vivían fusionados en un solo
 * objeto. Con zoom hay que separarlos: el dato sigue llegando por WS y el eje
 * crece, pero la vista TIENE que quedarse donde el usuario la dejó.
 *
 * Todo acá es función pura sobre números. Los bugs de zoom son casi siempre de
 * clamp (acercarse infinito, salirse del dominio, perder el punto bajo el
 * cursor) y aislados se testean sin montar un canvas.
 */

import type { FrequencyAxis } from './spectrogram-frequency-axis';
import type { TimeAxis } from './spectrogram-time-axis';

export interface Viewport {
  fMin: number;
  fMax: number;
  startMs: number;
  endMs: number;
}

/** Span temporal mínimo: por debajo de un segundo no hay más resolución que ver. */
const MIN_TIME_SPAN_MS = 1000;

/** Span de frecuencia mínimo, en Hz. */
const MIN_FREQ_SPAN_HZ = 0.5;

export function fullViewport(f: FrequencyAxis, t: TimeAxis): Viewport {
  return { fMin: f.fMin, fMax: f.fMax, startMs: t.startMs, endMs: t.endMs };
}

/**
 * Zoom sobre un rango 1D manteniendo fijo el punto que está bajo el cursor.
 *
 * `anchorFraction` es dónde cae el cursor dentro del rango visible (0 = borde
 * inicial, 1 = borde final). Sin ancla, todo zoom se haría desde el centro y
 * apuntar a un evento sería imposible: se escaparía de la pantalla al acercar.
 */
function zoomRange(
  min: number,
  max: number,
  factor: number,
  anchorFraction: number,
  limitMin: number,
  limitMax: number,
  minSpan: number,
): [number, number] {
  const span = max - min;
  if (!(span > 0)) return [limitMin, limitMax];

  const anchor = min + span * Math.min(1, Math.max(0, anchorFraction));
  const limitSpan = limitMax - limitMin;

  // El span nunca baja del piso ni sube del dominio completo: sin los dos topes
  // la rueda del mouse lleva a NaN o a un rango invertido.
  const nextSpan = Math.min(limitSpan, Math.max(minSpan, span * factor));

  let nextMin = anchor - (anchor - min) * (nextSpan / span);
  let nextMax = nextMin + nextSpan;

  // Corrimiento (no recorte) al chocar un borde: recortar cambiaría el span y
  // el zoom se sentiría trabado contra los extremos.
  if (nextMin < limitMin) {
    nextMin = limitMin;
    nextMax = limitMin + nextSpan;
  }
  if (nextMax > limitMax) {
    nextMax = limitMax;
    nextMin = limitMax - nextSpan;
  }
  return [nextMin, nextMax];
}

export function zoomTime(
  v: Viewport,
  factor: number,
  anchorFraction: number,
  limits: Viewport,
): Viewport {
  const [startMs, endMs] = zoomRange(
    v.startMs, v.endMs, factor, anchorFraction,
    limits.startMs, limits.endMs, MIN_TIME_SPAN_MS,
  );
  return { ...v, startMs, endMs };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: PASS, 6 tests.

- [ ] **Step 5: Verificar por mutación**

Cambiar en `zoomRange` la línea del ancla por `const anchor = min + span * 0.5;` (zoom siempre desde el centro). Correr los tests.
Esperado: FALLA `mantiene bajo el cursor el instante que estaba bajo el cursor`.
**Revertir la mutación** y confirmar que vuelve a PASS. Si el test NO falló, el test no sirve — arreglarlo antes de seguir.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/spectrogram-viewport.ts dashboard/lib/spectrogram-viewport.test.ts
git commit -m "feat(espectrogramas): viewport puro con zoom temporal anclado al cursor"
```

### Task A2: Zoom en frecuencia, pan y reset

**Files:**
- Modify: `dashboard/lib/spectrogram-viewport.ts`
- Test: `dashboard/lib/spectrogram-viewport.test.ts`

**Interfaces:**
- Consumes: `zoomRange` (privada, de A1), `Viewport`
- Produces: `zoomFreq`, `panViewport`, `isFullView`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// agregar a dashboard/lib/spectrogram-viewport.test.ts
import { isFullView, panViewport, zoomFreq } from './spectrogram-viewport';

describe('zoomFreq', () => {
  it('acerca en frecuencia sin tocar el rango temporal', () => {
    const v = zoomFreq(LIMITS, 0.5, 0.5, LIMITS);
    expect(v.fMax - v.fMin).toBe(10);
    expect(v.startMs).toBe(LIMITS.startMs);
    expect(v.endMs).toBe(LIMITS.endMs);
  });

  it('no deja acercarse por debajo del span mínimo en Hz', () => {
    let v: Viewport = LIMITS;
    for (let i = 0; i < 20; i++) v = zoomFreq(v, 0.5, 0.5, LIMITS);
    expect(v.fMax - v.fMin).toBeGreaterThanOrEqual(0.5);
  });
});

describe('panViewport', () => {
  it('corre la ventana en tiempo por una fracción del span visible', () => {
    const acercado = zoomTime(LIMITS, 0.5, 0.5, LIMITS); // span 500_000
    const v = panViewport(acercado, 0.1, 0, LIMITS);
    expect(v.startMs).toBeCloseTo(acercado.startMs + 50_000, 0);
    expect(v.endMs - v.startMs).toBe(500_000);
  });

  it('no deja panear fuera del dominio del dato', () => {
    const acercado = zoomTime(LIMITS, 0.5, 0.5, LIMITS);
    const v = panViewport(acercado, 99, 0, LIMITS);
    expect(v.endMs).toBe(LIMITS.endMs);
    expect(v.endMs - v.startMs).toBe(500_000);
  });

  it('en vista completa el pan no mueve nada', () => {
    const v = panViewport(LIMITS, 0.5, 0.5, LIMITS);
    expect(v).toEqual(LIMITS);
  });
});

describe('isFullView', () => {
  it('reconoce la vista completa', () => {
    expect(isFullView(LIMITS, LIMITS)).toBe(true);
  });

  it('reconoce que hay zoom activo', () => {
    expect(isFullView(zoomTime(LIMITS, 0.5, 0.5, LIMITS), LIMITS)).toBe(false);
  });

  it('tolera el error de coma flotante de acercar y alejar', () => {
    const ida = zoomTime(LIMITS, 0.5, 0.3, LIMITS);
    const vuelta = zoomTime(ida, 2, 0.3, LIMITS);
    expect(isFullView(vuelta, LIMITS)).toBe(true);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: FAIL — `zoomFreq is not a function`.

- [ ] **Step 3: Implementar**

```ts
// agregar a dashboard/lib/spectrogram-viewport.ts

export function zoomFreq(
  v: Viewport,
  factor: number,
  anchorFraction: number,
  limits: Viewport,
): Viewport {
  // El eje de frecuencia se dibuja con el máximo ARRIBA, así que una fracción
  // de 0 en pantalla es el tope del rango. Se invierte acá y no en el llamador
  // para que quien maneje el mouse no tenga que saberlo.
  const [fMin, fMax] = zoomRange(
    v.fMin, v.fMax, factor, 1 - anchorFraction,
    limits.fMin, limits.fMax, MIN_FREQ_SPAN_HZ,
  );
  return { ...v, fMin, fMax };
}

/**
 * Corre la ventana. Las fracciones son del span VISIBLE, no del total: así un
 * arrastre de N píxeles mueve siempre los mismos N píxeles de contenido, con
 * zoom o sin él.
 */
export function panViewport(
  v: Viewport,
  dxFraction: number,
  dyFraction: number,
  limits: Viewport,
): Viewport {
  const timeSpan = v.endMs - v.startMs;
  const freqSpan = v.fMax - v.fMin;

  const dt = timeSpan * dxFraction;
  const df = freqSpan * dyFraction;

  const [startMs, endMs] = shiftRange(
    v.startMs + dt, v.endMs + dt, limits.startMs, limits.endMs,
  );
  const [fMin, fMax] = shiftRange(
    v.fMin + df, v.fMax + df, limits.fMin, limits.fMax,
  );
  return { fMin, fMax, startMs, endMs };
}

/** Empuja un rango dentro de los límites preservando su ancho. */
function shiftRange(
  min: number, max: number, limitMin: number, limitMax: number,
): [number, number] {
  const span = max - min;
  if (span >= limitMax - limitMin) return [limitMin, limitMax];
  if (min < limitMin) return [limitMin, limitMin + span];
  if (max > limitMax) return [limitMax - span, limitMax];
  return [min, max];
}

/**
 * ¿Está mostrando todo? Con tolerancia relativa: acercar y alejar deja residuo
 * de coma flotante, y comparar por igualdad exacta dejaría el botón "reset"
 * encendido para siempre después del primer zoom.
 */
export function isFullView(v: Viewport, limits: Viewport): boolean {
  const timeSpan = limits.endMs - limits.startMs;
  const freqSpan = limits.fMax - limits.fMin;
  const cerca = (a: number, b: number, escala: number) =>
    Math.abs(a - b) <= Math.max(1e-6, escala * 1e-6);

  return (
    cerca(v.startMs, limits.startMs, timeSpan) &&
    cerca(v.endMs, limits.endMs, timeSpan) &&
    cerca(v.fMin, limits.fMin, freqSpan) &&
    cerca(v.fMax, limits.fMax, freqSpan)
  );
}
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: PASS, 14 tests.

- [ ] **Step 5: Verificar por mutación**

En `isFullView`, cambiar la tolerancia por comparación exacta: `const cerca = (a, b) => a === b;` (ajustar la aridad).
Esperado: FALLA `tolera el error de coma flotante de acercar y alejar`.
**Revertir** y confirmar PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/spectrogram-viewport.ts dashboard/lib/spectrogram-viewport.test.ts
git commit -m "feat(espectrogramas): zoom en frecuencia, pan con clamp y deteccion de vista completa"
```

### Task A3: Filtro de columnas visibles

**Files:**
- Modify: `dashboard/lib/spectrogram-viewport.ts`
- Test: `dashboard/lib/spectrogram-viewport.test.ts`

**Interfaces:**
- Produces: `visibleColumnRange`

**Por qué esta task existe:** hoy el bucle de dibujo recorre hasta 4000 columnas × ~65 bins = 260.000 `fillRect`. Sin zoom eso corre una vez cuando llega el dato. Con zoom correría en CADA tick de la rueda del mouse. Las columnas ya vienen ordenadas por tiempo, así que una búsqueda binaria da el rango visible en O(log n).

- [ ] **Step 1: Escribir el test que falla**

```ts
// agregar a dashboard/lib/spectrogram-viewport.test.ts
import { visibleColumnRange } from './spectrogram-viewport';

describe('visibleColumnRange', () => {
  const cols = Array.from({ length: 100 }, (_, i) => ({
    endtime: new Date(1_000_000 + i * 10_000).toISOString(),
  }));

  it('en vista completa devuelve todas las columnas', () => {
    const [lo, hi] = visibleColumnRange(cols, LIMITS);
    expect(lo).toBe(0);
    expect(hi).toBe(100);
  });

  it('recorta a las columnas dentro de la ventana', () => {
    const v = { ...LIMITS, startMs: 1_300_000, endMs: 1_500_000 };
    const [lo, hi] = visibleColumnRange(cols, v);
    // Los índices 30..50 caen en la ventana.
    expect(lo).toBeLessThanOrEqual(30);
    expect(hi).toBeGreaterThanOrEqual(51);
    expect(hi - lo).toBeLessThan(30);
  });

  it('incluye una columna de más en cada borde para no dejar franja vacía', () => {
    const v = { ...LIMITS, startMs: 1_300_000, endMs: 1_500_000 };
    const [lo, hi] = visibleColumnRange(cols, v);
    expect(lo).toBe(29);
    expect(hi).toBe(52);
  });

  it('devuelve rango vacío si ninguna columna cae en la ventana', () => {
    const v = { ...LIMITS, startMs: 5_000_000, endMs: 6_000_000 };
    const [lo, hi] = visibleColumnRange(cols, v);
    expect(hi).toBeLessThanOrEqual(lo + 1);
  });

  it('no rompe con la lista vacía', () => {
    expect(visibleColumnRange([], LIMITS)).toEqual([0, 0]);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: FAIL — `visibleColumnRange is not a function`.

- [ ] **Step 3: Implementar**

```ts
// agregar a dashboard/lib/spectrogram-viewport.ts

/**
 * Rango `[lo, hi)` de columnas que tocan la ventana visible.
 *
 * Búsqueda binaria porque el ingestor las inserta en orden y `/history` las
 * devuelve ordenadas por `endtime`. Con zoom el bucle de dibujo corre en cada
 * tick de la rueda; recorrer 4000 columnas para pintar 40 colgaría la pantalla.
 *
 * Se agrega una columna de margen a cada lado: la del borde se dibuja con
 * ancho hacia adentro, y sin el margen quedaría una franja sin pintar contra
 * el filo del recuadro.
 */
export function visibleColumnRange<T extends { endtime: string }>(
  cols: readonly T[],
  v: Viewport,
): [number, number] {
  if (cols.length === 0) return [0, 0];

  const lo = lowerBound(cols, v.startMs);
  const hi = lowerBound(cols, v.endMs);

  return [Math.max(0, lo - 1), Math.min(cols.length, hi + 2)];
}

/** Primer índice cuyo `endtime` es >= `ms`. */
function lowerBound<T extends { endtime: string }>(cols: readonly T[], ms: number): number {
  let lo = 0;
  let hi = cols.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const t = Date.parse(cols[mid].endtime);
    // Un timestamp roto no debe abortar la búsqueda: se lo trata como pasado
    // remoto, que es lo que hace el resto del pipeline con las columnas malas.
    if (!Number.isFinite(t) || t < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/spectrogram-viewport.test.ts
```
Esperado: PASS, 19 tests.

- [ ] **Step 5: Verificar por mutación**

Sacar el margen: `return [lo, hi];`.
Esperado: FALLA `incluye una columna de más en cada borde para no dejar franja vacía`.
**Revertir** y confirmar PASS.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/spectrogram-viewport.ts dashboard/lib/spectrogram-viewport.test.ts
git commit -m "perf(espectrogramas): rango visible de columnas por busqueda binaria"
```

### Task A4: Cablear el viewport al componente

**Files:**
- Modify: `dashboard/components/SpectrogramLarge.tsx`
- Modify: `dashboard/components/SpectrogramLarge.test.tsx`
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json`

**Interfaces:**
- Consumes: todo `spectrogram-viewport.ts`
- Produces: `SpectrogramLarge` con props sin cambios (compatible hacia atrás)

**Las tres trampas que esta task tiene que resolver:**
1. **Clipping.** Hoy `fillRect` pinta libre porque el eje siempre contiene todo. Con zoom, las columnas fuera de vista pintan ENCIMA de los rótulos. Hace falta `ctx.save()` + `ctx.clip()`.
2. **Costo del bucle.** Usar `visibleColumnRange` antes de iterar.
3. **El WS mueve la vista.** El viewport es estado propio y NO se recalcula cuando llegan columnas. Este repo ya tuvo cuatro variantes del bug "estado inicial que no se recalcula" (memoria `estado-inicial-que-no-se-recalcula`); acá el riesgo es el inverso y hay que ser explícito.

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// agregar a dashboard/components/SpectrogramLarge.test.tsx
// (reusar los helpers de mock de fetch que ya tiene el archivo)

it('arranca sin zoom y no muestra el boton de reset', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  await screen.findByTestId('spectrogram-large-canvas');
  expect(screen.queryByTestId('spectrogram-reset-zoom')).not.toBeInTheDocument();
});

it('la rueda del mouse acerca en tiempo y muestra el boton de reset', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  const canvas = await screen.findByTestId('spectrogram-large-canvas');

  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });

  expect(await screen.findByTestId('spectrogram-reset-zoom')).toBeInTheDocument();
});

it('el boton de reset vuelve a la vista completa', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  const canvas = await screen.findByTestId('spectrogram-large-canvas');

  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
  fireEvent.click(await screen.findByTestId('spectrogram-reset-zoom'));

  await waitFor(() =>
    expect(screen.queryByTestId('spectrogram-reset-zoom')).not.toBeInTheDocument(),
  );
});

it('el doble clic sobre el canvas resetea el zoom', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  const canvas = await screen.findByTestId('spectrogram-large-canvas');

  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
  await screen.findByTestId('spectrogram-reset-zoom');
  fireEvent.doubleClick(canvas);

  await waitFor(() =>
    expect(screen.queryByTestId('spectrogram-reset-zoom')).not.toBeInTheDocument(),
  );
});

it('la tecla Escape resetea el zoom', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  const canvas = await screen.findByTestId('spectrogram-large-canvas');

  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
  await screen.findByTestId('spectrogram-reset-zoom');
  fireEvent.keyDown(canvas, { key: 'Escape' });

  await waitFor(() =>
    expect(screen.queryByTestId('spectrogram-reset-zoom')).not.toBeInTheDocument(),
  );
});

it('con zoom activo, una columna nueva del WS NO mueve la vista', async () => {
  // El bug que este test previene: el useEffect de dibujo depende de las
  // columnas, y si el viewport se derivara de ellas cada mensaje del WS le
  // correría el encuadre al usuario debajo del mouse.
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  const canvas = await screen.findByTestId('spectrogram-large-canvas');

  fireEvent.wheel(canvas, { deltaY: -100, clientX: 300, clientY: 200 });
  await screen.findByTestId('spectrogram-reset-zoom');

  emitWsColumn({ endtime: new Date(Date.now() + 60_000).toISOString(), freqs: [1, 2], power_db: [50, 60] });

  // Sigue habiendo zoom: la vista no se re-encuadró sola.
  await waitFor(() =>
    expect(screen.getByTestId('spectrogram-reset-zoom')).toBeInTheDocument(),
  );
});

it('recorta el dibujo al area de plot para no pisar los rotulos', async () => {
  mockHistory({ columns: sampleColumns() });
  render(<SpectrogramLarge channel="AR.TEST..HHZ" />);
  await screen.findByTestId('spectrogram-large-canvas');

  const ctx = getMockContext();
  expect(ctx.clip).toHaveBeenCalled();
});
```

Nota para quien implemente: si el archivo de test no tiene ya `mockHistory`, `sampleColumns`, `emitWsColumn` o `getMockContext`, hay que crearlos siguiendo los helpers existentes del archivo. `getMockContext` debe exponer `clip` como `vi.fn()` dentro del mock de `getContext('2d')`.

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramLarge.test.tsx
```
Esperado: FAIL — no existe `spectrogram-reset-zoom`; `ctx.clip` no fue llamado.

- [ ] **Step 3: Agregar las claves de i18n**

En `dashboard/messages/es.json`, dentro de `station`:
```json
"resetZoom": "Ajustar todo",
"zoomHint": "Rueda: tiempo · Shift+rueda: frecuencia · Arrastrar: mover · Doble clic o Esc: ajustar todo",
"backToLive": "Volver a vivo"
```

En `dashboard/messages/en.json`, dentro de `station`:
```json
"resetZoom": "Fit all",
"zoomHint": "Wheel: time · Shift+wheel: frequency · Drag: pan · Double-click or Esc: fit all",
"backToLive": "Back to live"
```

- [ ] **Step 4: Implementar en el componente**

Cambios sobre `dashboard/components/SpectrogramLarge.tsx`:

a) Imports:
```ts
import {
  type Viewport,
  fullViewport,
  isFullView,
  panViewport,
  visibleColumnRange,
  zoomFreq,
  zoomTime,
} from '@/lib/spectrogram-viewport';
```

b) Estado, después de `const [status, setStatus] = useState(...)`:
```ts
  // El viewport es estado PROPIO, no derivado de las columnas. Esa es toda la
  // diferencia: si se derivara, cada mensaje del WS re-encuadraría la vista y
  // sería imposible mirar un evento con zoom mientras sigue llegando señal.
  // `null` = sin zoom, se muestra el dominio completo del dato.
  const [viewport, setViewport] = useState<Viewport | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
```

c) Después de `fAxis` y `tAxis`, los límites y la vista efectiva:
```ts
  // Límites = dominio del dato. Crecen cuando llega señal nueva.
  const limits = useMemo(() => fullViewport(fAxis, tAxis), [fAxis, tAxis]);
  // Vista efectiva: la del usuario si tocó algo, si no el dominio completo.
  const view = viewport ?? limits;
  const zoomed = viewport !== null && !isFullView(viewport, limits);
```

d) En el `useEffect` de dibujo, reemplazar `fAxis`/`tAxis` por ejes derivados de `view`:
```ts
    // Los ejes de DIBUJO salen del viewport, no del dato. Las funciones
    // freqToFraction/timeToFraction son puras y toman el eje por parámetro,
    // así que alcanza con pasarles otro objeto: no hay que tocar el mapeo.
    const viewF = { fMin: view.fMin, fMax: view.fMax, mixedGrid: fAxis.mixedGrid };
    const viewT = { startMs: view.startMs, endMs: view.endMs };
```
Luego, en todo el cuerpo del efecto, usar `viewF` donde decía `fAxis` y `viewT` donde decía `tAxis`. Las deps del efecto pasan a ser `[columns, view, fAxis.mixedGrid, width, height, t]`.

e) Envolver el bucle de columnas en clip y usar el rango visible:
```ts
    // Sin clip, las columnas que caen fuera de la ventana pintan encima de los
    // rótulos de los ejes. Se restaura antes de dibujar los ejes, que van
    // fuera del área recortada.
    ctx.save();
    ctx.beginPath();
    ctx.rect(MARGIN_LEFT, MARGIN_TOP, plotW, plotH);
    ctx.clip();

    const [lo, hi] = visibleColumnRange(columns, view);
    const visibles = hi - lo;
    const colW = Math.max(1, Math.ceil(plotW / Math.max(1, visibles)));

    for (let ci = lo; ci < hi; ci++) {
      const col = columns[ci];
      // ... el cuerpo del bucle NO cambia, sólo usa viewT/viewF ...
    }

    ctx.restore();
```

f) Handlers, antes del `return`:
```ts
  const fractionsFromEvent = (e: { clientX: number; clientY: number }) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return { fx: 0.5, fy: 0.5 };
    const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
    const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
    // El canvas puede estar escalado por CSS: se pasa de px de pantalla a px
    // del canvas antes de calcular la fracción, o el ancla cae desplazada.
    const scaleX = width / rect.width;
    const scaleY = height / rect.height;
    const x = (e.clientX - rect.left) * scaleX - MARGIN_LEFT;
    const y = (e.clientY - rect.top) * scaleY - MARGIN_TOP;
    return {
      fx: Math.min(1, Math.max(0, x / plotW)),
      fy: Math.min(1, Math.max(0, y / plotH)),
    };
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { fx, fy } = fractionsFromEvent(e);
    // deltaY negativo = rueda hacia adelante = acercar.
    const factor = e.deltaY < 0 ? 0.8 : 1.25;
    setViewport((prev) =>
      e.shiftKey
        ? zoomFreq(prev ?? limits, factor, fy, limits)
        : zoomTime(prev ?? limits, factor, fx, limits),
    );
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = { x: e.clientX, y: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const start = dragRef.current;
    if (!start) return;
    const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
    const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
    // Arrastrar a la derecha muestra el pasado: el contenido acompaña al dedo.
    const dx = -(e.clientX - start.x) / plotW;
    const dy = (e.clientY - start.y) / plotH;
    dragRef.current = { x: e.clientX, y: e.clientY };
    setViewport((prev) => panViewport(prev ?? limits, dx, dy, limits));
  };

  const endDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const resetZoom = () => setViewport(null);
```

g) El JSX del canvas:
```tsx
        <canvas
          data-testid="spectrogram-large-canvas"
          ref={canvasRef}
          width={width}
          height={height}
          tabIndex={0}
          role="img"
          aria-label={t('zoomHint')}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={resetZoom}
          onKeyDown={(e) => {
            if (e.key === 'Escape') resetZoom();
          }}
          className={`block rounded outline-none ${zoomed ? 'cursor-grab' : ''}`}
        />
```

h) El botón de reset, junto a los avisos del final:
```tsx
      {zoomed && (
        <button
          type="button"
          data-testid="spectrogram-reset-zoom"
          onClick={resetZoom}
          className="mt-2 rounded bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-500"
        >
          {t('resetZoom')}
        </button>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{t('zoomHint')}</p>
```

- [ ] **Step 5: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramLarge.test.tsx
```
Esperado: PASS, los 8 originales + los 7 nuevos.

- [ ] **Step 6: Verificar por mutación — el test que más importa**

Cambiar `const view = viewport ?? limits;` por `const view = limits;` (o sea, derivar la vista del dato como antes).
Esperado: FALLA `con zoom activo, una columna nueva del WS NO mueve la vista` y varios más.
**Revertir** y confirmar PASS. Si ese test NO falló, está mal escrito — es el que protege contra el bug estructural.

- [ ] **Step 7: Correr toda la suite del dashboard**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run
```
Esperado: sin regresiones. Si algo de Leaflet falla, correrlo aislado antes de darlo por roto (memoria: `waitfor-1000ms-no-alcanza-para-leaflet`).

- [ ] **Step 8: Commit**

```bash
git add dashboard/components/SpectrogramLarge.tsx dashboard/components/SpectrogramLarge.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(espectrogramas): zoom y pan en el espectrograma grande"
```

- [ ] **Step 9: QA visual — lo hace el usuario**

Levantar el stack y entregar:
- URL: `http://localhost:3000/stations/RI.LPCA..EHZ`
- Qué mirar:
  1. Rueda del mouse sobre el canvas → acerca en tiempo, el punto bajo el cursor no se mueve
  2. Shift + rueda → acerca en frecuencia, el eje izquierdo re-rotula con números redondos
  3. Arrastrar → panea; al soltar en un borde no se pasa del dominio
  4. Con zoom, las manchas de color NO pisan los rótulos de los ejes
  5. Aparece "Ajustar todo"; el botón, el doble clic y Escape los tres funcionan
  6. Con zoom puesto, esperar ~1 min: llega señal nueva por WS y **la vista no se mueve sola**

---

# PR B — Modal de "Ampliar" y honestidad del toggle

**Depende de PR A** (el modal muestra `SpectrogramLarge`, que ahí gana el zoom).

### Task B1: El modal

**Files:**
- Create: `dashboard/components/SpectrogramModal.tsx`
- Test: `dashboard/components/SpectrogramModal.test.tsx`
- Modify: `dashboard/messages/es.json`, `en.json`

**Interfaces:**
- Consumes: `SpectrogramLarge` de `@/components/SpectrogramLarge`
- Produces:
```ts
interface SpectrogramModalProps {
  channel: string;
  cityName: string;
  open: boolean;
  onClose: () => void;
}
export function SpectrogramModal(props: SpectrogramModalProps): JSX.Element | null
```

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// dashboard/components/SpectrogramModal.test.tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { SpectrogramModal } from './SpectrogramModal';
import messages from '../messages/es.json';

// SpectrogramLarge pega a red y dibuja en canvas: acá se testea el MODAL,
// no el espectrograma. Ese ya tiene sus propios tests.
vi.mock('./SpectrogramLarge', () => ({
  SpectrogramLarge: ({ channel }: { channel: string }) => (
    <div data-testid="spectrogram-large-stub">{channel}</div>
  ),
}));

const renderModal = (props: Partial<Parameters<typeof SpectrogramModal>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="es" messages={messages}>
      <SpectrogramModal
        channel="AR.TEST..HHZ"
        cityName="Mendoza"
        open
        onClose={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('SpectrogramModal', () => {
  it('no renderiza nada cuando esta cerrado', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('muestra el espectrograma grande del canal', () => {
    renderModal();
    expect(screen.getByTestId('spectrogram-large-stub')).toHaveTextContent('AR.TEST..HHZ');
  });

  it('muestra el nombre de la ciudad y el canal en el encabezado', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toHaveTextContent('Mendoza');
    expect(screen.getByRole('dialog')).toHaveTextContent('AR.TEST..HHZ');
  });

  it('ofrece un enlace al detalle de estacion', () => {
    renderModal();
    const link = screen.getByTestId('modal-station-link');
    expect(link).toHaveAttribute('href', '/stations/AR.TEST..HHZ');
  });

  it('escapa el canal en el href — un SCNL lleva puntos', () => {
    renderModal({ channel: 'NZ.KHZ.10.HHZ' });
    expect(screen.getByTestId('modal-station-link')).toHaveAttribute(
      'href',
      '/stations/NZ.KHZ.10.HHZ',
    );
  });

  it('cierra con el boton de cerrar', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('modal-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cierra con Escape', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cierra al hacer clic en el fondo', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('NO cierra al hacer clic dentro del contenido', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('spectrogram-large-stub'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramModal.test.tsx
```
Esperado: FAIL — `Failed to resolve import "./SpectrogramModal"`.

- [ ] **Step 3: Agregar i18n**

`dashboard/messages/es.json`, dentro de `charts.spectrogram`:
```json
"modalTitle": "Espectrograma de {city}",
"viewStationDetail": "Ver detalle de la estación",
"closeModal": "Cerrar"
```

`dashboard/messages/en.json`, dentro de `charts.spectrogram`:
```json
"modalTitle": "{city} spectrogram",
"viewStationDetail": "View station detail",
"closeModal": "Close"
```

- [ ] **Step 4: Implementar**

```tsx
/**
 * Vista ampliada del espectrograma de una tarjeta del muro.
 *
 * Antes "Ampliar" era un <Link> que NAVEGABA al detalle de estación: se perdía
 * el muro y había que volver con el botón atrás. Acá amplía de verdad —el mismo
 * canvas con ejes y zoom que usa el detalle— y deja ir a la estación como una
 * OPCIÓN, no como el único destino.
 */

'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink, X } from 'lucide-react';
import { SpectrogramLarge } from '@/components/SpectrogramLarge';

interface SpectrogramModalProps {
  channel: string;
  cityName: string;
  open: boolean;
  onClose: () => void;
}

export function SpectrogramModal({ channel, cityName, open, onClose }: SpectrogramModalProps) {
  const t = useTranslations('charts.spectrogram');

  // Escape a nivel documento y no en el contenedor: el foco puede estar en el
  // canvas, en el link o en ninguno, y un handler local no lo cubriría.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // El scroll del fondo se bloquea mientras el modal está abierto: sin esto,
  // la rueda del mouse sobre el espectrograma (que ahora hace zoom) también
  // desplazaría la página de atrás.
  useEffect(() => {
    if (!open) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previo;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        data-testid="modal-backdrop"
        onClick={onClose}
        className="absolute inset-0 bg-black/80"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('modalTitle', { city: cityName })}
        className="relative z-10 max-h-full w-full max-w-5xl overflow-auto rounded-lg bg-neutral-900 p-4 shadow-xl ring-1 ring-white/10"
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{cityName}</h2>
            <p className="truncate font-data text-xs text-gray-400">{channel}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              data-testid="modal-station-link"
              href={`/stations/${encodeURIComponent(channel)}`}
              className="flex items-center gap-1 rounded bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-500"
            >
              <ExternalLink className="h-3 w-3" />
              {t('viewStationDetail')}
            </Link>
            <button
              type="button"
              data-testid="modal-close"
              onClick={onClose}
              aria-label={t('closeModal')}
              title={t('closeModal')}
              className="rounded p-1 text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <SpectrogramLarge channel={channel} width={880} height={400} minutes={60} />
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramModal.test.tsx
```
Esperado: PASS, 9 tests.

- [ ] **Step 6: Verificar por mutación**

Sacar el `onClick={onClose}` del backdrop.
Esperado: FALLA `cierra al hacer clic en el fondo`.
**Revertir** y confirmar PASS.

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/SpectrogramModal.tsx dashboard/components/SpectrogramModal.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(espectrogramas): modal de vista ampliada con enlace a la estacion"
```

### Task B2: Toggle honesto y Ampliar en todas las tarjetas

**Files:**
- Modify: `dashboard/components/SortableSpectrogramCard.tsx`
- Modify: `dashboard/components/SortableSpectrogramCard.test.tsx`
- Modify: `dashboard/messages/es.json`, `en.json`

**Interfaces:**
- Consumes: `SpectrogramModal` de B1
- Produces: `SortableSpectrogramCard` con las mismas props

**Lo que arregla:** hoy `SortableSpectrogramCard.tsx:114` (`{liveChannel && ...}`) esconde el toggle en las ciudades sin transmisión, y `:150` esconde "Ampliar". El resultado es que ~6 de 33 tarjetas caen al PNG en silencio, sin que se sepa que existe un modo vivo ni por qué no aplica.

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// agregar a dashboard/components/SortableSpectrogramCard.test.tsx

it('muestra el toggle tambien en ciudades SIN transmision en vivo', () => {
  renderCard({ liveChannel: undefined });
  expect(screen.getByRole('group', { name: /vivo/i })).toBeInTheDocument();
});

it('deshabilita el boton Vivo cuando la ciudad no transmite', () => {
  renderCard({ liveChannel: undefined });
  const vivo = screen.getByTestId('card-mode-live');
  expect(vivo).toBeDisabled();
  expect(vivo).toHaveAttribute('title', expect.stringMatching(/no transmite/i));
});

it('no deshabilita el boton Vivo cuando si transmite', () => {
  renderCard({ liveChannel: 'AR.TEST..HHZ' });
  expect(screen.getByTestId('card-mode-live')).not.toBeDisabled();
});

it('clic en Vivo deshabilitado no cambia el modo', () => {
  renderCard({ liveChannel: undefined });
  fireEvent.click(screen.getByTestId('card-mode-live'));
  expect(screen.getByTestId('card-mode-static')).toHaveAttribute('aria-pressed', 'true');
});

it('Ampliar abre el modal en vez de navegar', () => {
  renderCard({ liveChannel: 'AR.TEST..HHZ' });
  fireEvent.click(screen.getByTestId('card-expand'));
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('Ampliar NO es un enlace — antes navegaba y se perdia el muro', () => {
  renderCard({ liveChannel: 'AR.TEST..HHZ' });
  const expand = screen.getByTestId('card-expand');
  expect(expand.tagName).toBe('BUTTON');
  expect(expand).not.toHaveAttribute('href');
});

it('el modal se cierra y devuelve al muro', () => {
  renderCard({ liveChannel: 'AR.TEST..HHZ' });
  fireEvent.click(screen.getByTestId('card-expand'));
  fireEvent.click(screen.getByTestId('modal-close'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('sin canal vivo no ofrece Ampliar — no hay espectrograma grande que mostrar', () => {
  renderCard({ liveChannel: undefined });
  expect(screen.queryByTestId('card-expand')).not.toBeInTheDocument();
});
```

Nota: si `renderCard` no existe en el archivo, crearlo envolviendo en `NextIntlClientProvider` y en el contexto de dnd-kit que ya usan los tests actuales.

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SortableSpectrogramCard.test.tsx
```
Esperado: FAIL — no existe `card-mode-live`, no existe `card-expand`.

- [ ] **Step 3: Agregar i18n**

`dashboard/messages/es.json`, dentro de `charts.spectrogram`:
```json
"noLiveStream": "Esta estación no transmite en tiempo real"
```

`dashboard/messages/en.json`:
```json
"noLiveStream": "This station does not stream in real time"
```

- [ ] **Step 4: Implementar**

En `SortableSpectrogramCard.tsx`:

a) Imports y estado:
```ts
import { SpectrogramModal } from '@/components/SpectrogramModal';
// ...
  const [modalOpen, setModalOpen] = useState(false);
```
Sacar `Link` del import de `next/link` si queda sin uso.

b) Reemplazar el bloque del toggle (líneas 114-144). El guard `{liveChannel && (` se va: el toggle se muestra siempre.
```tsx
      {/* Selector Vivo/24h: SIEMPRE visible, incluso sin canal en vivo.
          Antes estaba guardado por `liveChannel`, así que en las ciudades sin
          transmisión la tarjeta caía al PNG de 24h en silencio: ni se sabía
          que el modo vivo existía ni por qué esa tarjeta era distinta. Ahora
          "Vivo" aparece deshabilitado y el tooltip dice el motivo. */}
      <div
        role="group"
        aria-label={t('viewLive')}
        className="absolute top-2 left-1/2 z-30 flex -translate-x-1/2 overflow-hidden rounded-full bg-black/75 text-[10px] font-semibold ring-1 ring-white/20"
      >
        <button
          type="button"
          data-testid="card-mode-live"
          onClick={() => setChosenMode('live')}
          disabled={!liveChannel}
          aria-pressed={mode === 'live'}
          title={liveChannel ? t('viewLive') : t('noLiveStream')}
          className={`flex items-center gap-1 px-2 py-0.5 transition-colors ${
            !liveChannel
              ? 'cursor-not-allowed text-white/30'
              : mode === 'live'
                ? 'bg-teal-600 text-white'
                : 'text-white/70 hover:text-white'
          }`}
        >
          <Radio className={`h-3 w-3 ${mode === 'live' ? 'animate-pulse' : ''}`} />
          {t('liveBadge')}
        </button>
        <button
          type="button"
          data-testid="card-mode-static"
          onClick={() => setChosenMode('static')}
          aria-pressed={mode === 'static'}
          title={t('viewHistory')}
          className={`px-2 py-0.5 transition-colors ${
            mode === 'static' ? 'bg-teal-600 text-white' : 'text-white/70 hover:text-white'
          }`}
        >
          24h
        </button>
      </div>
```

c) Reemplazar el bloque de "Ampliar" (líneas 150-159):
```tsx
      {/* Ampliar: abre el modal. Antes era un <Link> al detalle de estación,
          o sea que NAVEGABA — se perdía el muro entero y había que volver con
          el botón atrás. El detalle sigue estando, pero como opción dentro del
          modal. Sólo con canal vivo: sin columnas no hay espectrograma grande
          que mostrar (el PNG de 24h no es el mismo pipeline). */}
      {liveChannel && (
        <button
          type="button"
          data-testid="card-expand"
          onClick={() => setModalOpen(true)}
          title={t('expand')}
          aria-label={t('expand')}
          className="absolute bottom-2 right-2 z-30 rounded bg-black/70 p-1 text-white opacity-0 transition-opacity group-hover:opacity-100 hover:bg-black/90 focus-visible:opacity-100"
        >
          <Maximize2 className="h-3 w-3" />
        </button>
      )}

      {liveChannel && (
        <SpectrogramModal
          channel={liveChannel}
          cityName={city.name}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
        />
      )}
```

- [ ] **Step 5: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SortableSpectrogramCard.test.tsx
```
Esperado: PASS, los existentes + los 8 nuevos.

- [ ] **Step 6: Verificar por mutación**

Sacar `disabled={!liveChannel}` del botón Vivo.
Esperado: FALLA `deshabilita el boton Vivo cuando la ciudad no transmite` y `clic en Vivo deshabilitado no cambia el modo`.
**Revertir** y confirmar PASS.

- [ ] **Step 7: Suite completa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run
```

- [ ] **Step 8: Commit**

```bash
git add dashboard/components/SortableSpectrogramCard.tsx dashboard/components/SortableSpectrogramCard.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(espectrogramas): ampliar abre modal y el toggle dice quien no transmite"
```

- [ ] **Step 9: QA visual — lo hace el usuario**

- URL: `http://localhost:3000/spectrograms-live` (o `/spectrograms` si ya se hizo el PR C)
- Qué mirar:
  1. TODAS las tarjetas muestran el segmentado Vivo/24h
  2. En las que no transmiten, "Vivo" está gris; el tooltip explica por qué
  3. Hover sobre una tarjeta viva → aparece el ícono de Ampliar
  4. Clic en Ampliar → **se abre un modal, NO navega**
  5. Dentro del modal el zoom del PR A funciona
  6. La rueda dentro del modal hace zoom y **no scrollea la página de atrás**
  7. "Ver detalle de la estación" lleva a `/stations/...`
  8. Cierra con la X, con Escape y con clic en el fondo

---

# PR C — Renombrar /spectrograms-live a /spectrograms

### Task C1: Mover la ruta y dejar redirect

**Files:**
- Create: `dashboard/app/(app)/spectrograms/page.tsx` (contenido movido)
- Create: `dashboard/app/(app)/spectrograms/wall-tab.test.tsx` (movido)
- Create: `dashboard/app/(app)/spectrograms-live/page.tsx` (redirect)
- Modify: `dashboard/components/AppSidebar.tsx`
- Modify: `dashboard/lib/toast-queue.ts`
- Modify: `dashboard/components/SortableSpectrogramCard.test.tsx`
- Modify: `dashboard/messages/es.json`, `en.json`

**Referencias verificadas** (`rg -l "spectrograms-live"`):
- `dashboard/app/(app)/spectrograms-live/wall-tab.test.tsx`
- `dashboard/components/SortableSpectrogramCard.test.tsx`
- `dashboard/lib/toast-queue.ts`
- `dashboard/components/AppSidebar.tsx`

- [ ] **Step 1: Escribir el test del redirect**

```tsx
// dashboard/app/(app)/spectrograms-live/redirect.test.tsx
import { describe, expect, it, vi } from 'vitest';

// La ruta vieja quedó publicada: hay links guardados y toasts que apuntan ahí.
// Un 404 sería una regresión para quien la tenga en favoritos.
const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect }));

describe('/spectrograms-live', () => {
  it('redirige permanentemente a /spectrograms', async () => {
    const { default: Page } = await import('./page');
    Page();
    expect(redirect).toHaveBeenCalledWith('/spectrograms');
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run "app/(app)/spectrograms-live/redirect.test.tsx"
```
Esperado: FAIL — la página actual no llama `redirect`.

- [ ] **Step 3: Mover los archivos**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor/dashboard
mkdir -p "app/(app)/spectrograms"
git mv "app/(app)/spectrograms-live/page.tsx" "app/(app)/spectrograms/page.tsx"
git mv "app/(app)/spectrograms-live/wall-tab.test.tsx" "app/(app)/spectrograms/wall-tab.test.tsx"
```

- [ ] **Step 4: Crear el redirect**

```tsx
// dashboard/app/(app)/spectrograms-live/page.tsx
/**
 * Redirect de la ruta vieja.
 *
 * La pantalla se llamaba "spectrograms-live" cuando sólo mostraba señal en
 * vivo. Hoy el modo se elige por tarjeta (vivo o 24h), así que el nombre
 * comprometía la URL con un modo que ya no es el único. La ruta vieja queda
 * publicada —hay links guardados y toasts que apuntan ahí— así que redirige en
 * vez de dar 404.
 */

import { redirect } from 'next/navigation';

export default function SpectrogramsLiveRedirect() {
  redirect('/spectrograms');
}
```

- [ ] **Step 5: Actualizar las referencias**

En `dashboard/components/AppSidebar.tsx` y `dashboard/lib/toast-queue.ts`, reemplazar `/spectrograms-live` por `/spectrograms`. En `dashboard/components/SortableSpectrogramCard.test.tsx`, actualizar lo que referencie la ruta vieja.

Verificar que no quedó ninguna:
```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor && rg -n "spectrograms-live" --glob '!node_modules' .
```
Esperado: sólo `app/(app)/spectrograms-live/page.tsx` (el redirect) y su test.

- [ ] **Step 6: Cambiar el título visible**

En `dashboard/messages/es.json`, la clave del título de la pantalla (buscar el valor actual con `rg -n "spectrogramsLive|Espectrogramas en vivo" dashboard/messages/`) pasa a:
```json
"Espectrogramas"
```
En `en.json`:
```json
"Spectrograms"
```

Y agregar el aviso de página, en `charts.spectrogram`:
```json
"notAllLive": "No todas las estaciones transmiten en tiempo real. Las que no, muestran las últimas 24 h."
```
```json
"notAllLive": "Not all stations stream in real time. Those that don't show the last 24 h."
```

Renderizarlo arriba de la grilla en `app/(app)/spectrograms/page.tsx`:
```tsx
        <p className="mb-3 text-xs text-muted-foreground">{t('notAllLive')}</p>
```

- [ ] **Step 7: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run
```
Esperado: PASS, sin regresiones.

- [ ] **Step 8: Commit**

```bash
git add -A dashboard/app dashboard/components dashboard/lib dashboard/messages
git commit -m "refactor(espectrogramas): la pantalla se llama Espectrogramas y la ruta acompana"
```

- [ ] **Step 9: QA visual — lo hace el usuario**

- URLs: `http://localhost:3000/spectrograms` y `http://localhost:3000/spectrograms-live`
- Qué mirar:
  1. `/spectrograms` muestra la pantalla; el título dice "Espectrogramas"
  2. `/spectrograms-live` redirige sin 404
  3. El menú lateral resalta el ítem correcto
  4. Se lee el aviso de que no todas las estaciones transmiten en vivo

---

# PR D — useActiveArea() y contexto estación↔área

### Task D1: El hook indivisible

**Files:**
- Create: `dashboard/lib/use-active-area.ts`
- Test: `dashboard/lib/use-active-area.test.ts`

**Interfaces:**
- Consumes: `getActiveArea` de `@/lib/areas`, `useAreaRefresh` de `@/lib/use-area-refresh`
- Produces:
```ts
export function useActiveArea(): {
  area: ActiveArea | null | undefined;
  isRefreshing: boolean;
}
```

**Por qué existe:** tres bugs idénticos por el mismo diseño. `AREA_CHANGED_EVENT` es un evento de `window` **opt-in**: cada consumidor tiene que acordarse de llamar `useAreaRefresh`, y olvidarse no produce error ni warning — queda mudo en silencio. Casos: `/explore` (cerrado, ver comentario en `explore/page.tsx:111-112`), `focusArea` en el overlay (cerrado en `50632ee`), `/stations/[channel]` (abierto). Residual: `GlobeBroadcastOverlay.tsx:217` lee SWR sin suscribirse.

La solución no es acordarse mejor. Es que leer el área y suscribirse sean **una sola operación indivisible**. `useAreaRefresh` queda como está — está bien escrito (`handlerRef`, `runIdRef`, `mountedRef`); lo que falta es el envoltorio que haga imposible olvidarlo.

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// dashboard/lib/use-active-area.test.ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import { AREA_CHANGED_EVENT } from './area-events';
import { useActiveArea } from './use-active-area';

const getActiveArea = vi.fn();
vi.mock('./areas', () => ({ getActiveArea: (...a: unknown[]) => getActiveArea(...a) }));

// Cache limpio por test: SWR comparte cache global entre renders y un test
// contaminaría al siguiente con el área del anterior.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('useActiveArea', () => {
  beforeEach(() => {
    getActiveArea.mockReset();
  });

  it('devuelve el area activa', async () => {
    getActiveArea.mockResolvedValue({ area: { id: 'andes', name: 'Andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toEqual({ area: { id: 'andes', name: 'Andes' } }));
  });

  it('se revalida SOLO al cambiar de area — sin que el llamador se suscriba', async () => {
    // Este es el test que importa: el bug estructural era que suscribirse
    // fuese un paso aparte y olvidable. Acá el llamador no hace nada.
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeTruthy());
    expect(getActiveArea).toHaveBeenCalledTimes(1);

    getActiveArea.mockResolvedValue({ area: { id: 'cascadia' } });
    act(() => {
      window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
    });

    await waitFor(() => expect(result.current.area).toEqual({ area: { id: 'cascadia' } }));
  });

  it('expone isRefreshing mientras la revalidacion viaja', async () => {
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeTruthy());

    let resolver: (v: unknown) => void = () => {};
    getActiveArea.mockReturnValue(new Promise((r) => { resolver = r; }));

    act(() => {
      window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));

    await act(async () => {
      resolver({ area: { id: 'cascadia' } });
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it('devuelve null sin romper cuando no hay sesion', async () => {
    // getActiveArea ya devuelve null en 401 (lib/areas.ts).
    getActiveArea.mockResolvedValue(null);
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeNull());
  });

  it('comparte la key de SWR con el resto de la app', async () => {
    // Misma key => SWR deduplica entre consumidores. Si esto cambia, cada
    // componente pegaría a /areas/active por su cuenta.
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result: a } = renderHook(() => useActiveArea(), { wrapper });
    const { result: b } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(a.current.area).toBeTruthy());
    await waitFor(() => expect(b.current.area).toBeTruthy());
  });
});
```

Nota: el archivo usa JSX, así que debe llamarse `use-active-area.test.tsx`. Ajustar el nombre.

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/use-active-area.test.tsx
```
Esperado: FAIL — no existe el módulo.

- [ ] **Step 3: Implementar**

```ts
/**
 * El área de interés activa, con la revalidación ya incluida.
 *
 * POR QUÉ EXISTE: la propagación del cambio de área es un CustomEvent de
 * window (ver `area-events.ts`), y suscribirse es opt-in. Leer el área con
 * `useSWR('/areas/active')` y suscribirse con `useAreaRefresh` eran DOS pasos,
 * y el segundo es olvidable — olvidarlo no da error ni warning: el componente
 * simplemente queda mudo y el usuario ve un control que no hace nada.
 *
 * Ya pasó tres veces en este repo: /explore (ver el comentario en
 * `explore/page.tsx`), el encuadre del globo (arreglado en 50632ee) y el
 * detalle de estación. No es un descuido repetido: es el diseño el que lo
 * produce.
 *
 * Acá los dos pasos son uno solo. No hay nada que olvidarse de llamar.
 *
 * La key de SWR se mantiene igual a la que ya usa el resto de la app, así que
 * todos los consumidores siguen deduplicando contra la misma entrada de cache.
 */

'use client';

import useSWR from 'swr';

import { getActiveArea } from '@/lib/areas';
import { useAreaRefresh } from '@/lib/use-area-refresh';

/** La misma key que ya usan `/live`, `/analytics` y el overlay del globo. */
export const ACTIVE_AREA_KEY = '/areas/active';

export function useActiveArea() {
  const { data, mutate } = useSWR(ACTIVE_AREA_KEY, getActiveArea);

  // Devolver la promesa es lo que hace que `isRefreshing` cubra la
  // revalidación entera; sin el return se apagaría antes de que llegue.
  const isRefreshing = useAreaRefresh(() => mutate());

  return { area: data, isRefreshing };
}
```

- [ ] **Step 4: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run lib/use-active-area.test.tsx
```
Esperado: PASS, 6 tests.

- [ ] **Step 5: Verificar por mutación — el test central**

Sacar la línea de `useAreaRefresh` y devolver `isRefreshing: false`.
Esperado: FALLA `se revalida SOLO al cambiar de area — sin que el llamador se suscriba` y `expone isRefreshing mientras la revalidacion viaja`.
**Revertir** y confirmar PASS. Ese test es el que protege contra el cuarto caso del bug.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/use-active-area.ts dashboard/lib/use-active-area.test.tsx
git commit -m "feat(areas): hook que fusiona leer el area activa con suscribirse al cambio"
```

### Task D2: Cerrar el residual del globo

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx:217`
- Modify: `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**El bug:** `50632ee` arregló que el overlay se montara sin `focusArea`, pero el overlay lee `/areas/active` por SWR y **no llama `useAreaRefresh` ni `onAreaChanged`** (grep confirmado: cero coincidencias en el archivo). En `/globe` no hay otro consumidor de esa key, y no hay `SWRConfig` global con `refreshInterval`. Resultado: cambiar de área no reencuadra la cámara hasta que SWR revalide por su cuenta.

- [ ] **Step 1: Escribir el test que falla**

```tsx
// agregar a dashboard/components/GlobeBroadcastOverlay.test.tsx

it('reencuadra la camara al cambiar de area, sin recargar la pagina', async () => {
  // Residual de 50632ee: el overlay leía /areas/active por SWR pero no se
  // suscribía al evento, así que en /globe (donde nadie más monta esa key)
  // la cámara no se movía hasta que SWR revalidara por su cuenta.
  getActiveArea.mockResolvedValue(areaFixture('andes'));
  renderOverlay();
  await waitFor(() => expect(getActiveArea).toHaveBeenCalledTimes(1));

  getActiveArea.mockResolvedValue(areaFixture('cascadia'));
  act(() => {
    window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
  });

  await waitFor(() => expect(getActiveArea).toHaveBeenCalledTimes(2));
});
```

Nota: reusar los helpers `renderOverlay` / `areaFixture` que el archivo ya tenga; si no existen, crearlos siguiendo el patrón del test de `:700`.

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```
Esperado: FAIL — `getActiveArea` se llamó 1 vez, se esperaban 2.

- [ ] **Step 3: Implementar**

En `GlobeBroadcastOverlay.tsx`, reemplazar el `useSWR('/areas/active', getActiveArea)` de la línea 217 por el hook nuevo:
```ts
import { useActiveArea } from '@/lib/use-active-area';
// ...
  // El overlay es autónomo (decisión de 50632ee: misma key ⇒ SWR deduplica),
  // pero además tiene que enterarse del cambio: en /globe nadie más monta esta
  // key, así que sin la suscripción la cámara no se reencuadraba en caliente.
  const { area: activeArea } = useActiveArea();
```
Adaptar el `useMemo` de `focusArea` (`:219-224`) al nombre nuevo. Sacar el import de `useSWR` y de `getActiveArea` si quedan sin uso.

- [ ] **Step 4: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/GlobeBroadcastOverlay.test.tsx
```
Esperado: PASS, incluido el test de `:700` que ya existía.

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx
git commit -m "fix(globo): la camara se reencuadra al cambiar de area sin recargar"
```

### Task D3: Contexto estación↔área en el detalle

**Files:**
- Modify: `dashboard/app/(app)/stations/[channel]/page.tsx`
- Modify: `dashboard/app/(app)/stations/station-page.test.tsx` (el test EXISTE acá, no en `[channel]/page.test.tsx`)
- Modify: `dashboard/messages/es.json`, `en.json`

**Qué hace:** hoy el selector se ve en esta página (está en `app/(app)/layout.tsx:33`) pero la página no lo consume — cambiar de área es un no-op visual. Se agrega una línea de contexto que dice si la estación cae dentro del área activa, con enlace al listado filtrado.

**RULING del pre-flight scan (2026-08-24) — de dónde salen las coordenadas.**

Verificado: `stations/[channel]/page.tsx` **no tiene las coordenadas de la estación**. Su único dato es el `channel` del path (`:41`); el resto es estado de helicorder en localStorage. Y `GET /spectrograms/station-catalog` devuelve `{channel, city_id, network, station, is_live, is_primary}` — **tampoco trae lat/lon** (`spectrogram_service.py:157`).

O sea: la versión original de esta task comparaba coordenadas que no existen en ningún lado del frontend.

Se resuelve por **`city_id`**, que el catálogo SÍ tiene, contra `dashboard/lib/seismic-cities.ts`, que SÍ tiene `lat`/`lon` por ciudad (`:10-11`). La cadena es:

```
channel → station-catalog → city_id → seismic-cities → { lat, lon }
```

Ya hay cliente del catálogo (`lib/api.ts`, `lib/station-search.ts`, `components/WallManager.tsx`), así que no hay que escribir uno.

**Costo si el ruling está mal:** la precisión es a nivel CIUDAD, no de la estación exacta. Una estación a 80 km del centro de su ciudad podría clasificarse del lado equivocado en un área cuyo borde pase justo entre ambas. Es aceptable para un indicador de contexto (no es un filtro ni un cálculo sísmico). La alternativa —agregar `latitude`/`longitude` a `station_catalog`— toca el backend en un PR que era sólo de frontend, y se anota como mejora futura.

**Si el canal no está en el catálogo** (llegó por URL escrita a mano, o es una estación que el ingestor no sigue), no hay ciudad y por lo tanto no hay coordenadas: no se muestra la línea de contexto. Es el mismo caso que "no se conocen las coordenadas".

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// agregar a dashboard/app/(app)/stations/[channel]/page.test.tsx

/**
 * Fixture con la forma REAL del contrato (verificado en `lib/types.ts`):
 *   ActiveAreaResponse = { area: Area, is_default: boolean }   // :105-108
 *   AreaBbox           = { minlat, maxlat, minlon, maxlon }     // :63-68
 *
 * `is_default` va en la RAÍZ, no dentro de `area`. Los campos del bbox van
 * pegados, sin guion bajo. Si el fixture miente sobre la forma, el test pasa
 * contra un componente roto.
 */
const areaActiva = (
  bbox: { minlat: number; maxlat: number; minlon: number; maxlon: number },
  isDefault = false,
) => ({
  area: {
    id: 'a1',
    slug: 'test',
    name: 'Test',
    is_system: true,
    geometry: { type: 'Polygon' as const, coordinates: [] },
    bbox,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
  is_default: isDefault,
});

const ANDES = { minlat: -40, maxlat: -30, minlon: -72, maxlon: -68 };
const JAPON = { minlat: 30, maxlat: 40, minlon: 135, maxlon: 145 };

it('dice que la estacion esta dentro del area activa', async () => {
  mockActiveArea(areaActiva(ANDES));
  mockStationMeta({ latitude: -35, longitude: -70 });
  renderStationPage('AR.TEST..HHZ');

  expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/dentro/i);
});

it('dice que la estacion esta fuera del area activa', async () => {
  mockActiveArea(areaActiva(ANDES));
  mockStationMeta({ latitude: 35, longitude: 139 }); // Japón
  renderStationPage('JP.TEST..HHZ');

  expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/fuera/i);
});

it('se actualiza al cambiar de area sin recargar', async () => {
  // El bug que este test previene: la página monta el selector (viene del
  // layout) pero no lo consumía, así que cambiar de área no hacía nada.
  mockActiveArea(areaActiva(ANDES));
  mockStationMeta({ latitude: 35, longitude: 139 });
  renderStationPage('JP.TEST..HHZ');
  expect(await screen.findByTestId('station-area-context')).toHaveTextContent(/fuera/i);

  mockActiveArea(areaActiva(JAPON));
  act(() => {
    window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
  });

  await waitFor(() =>
    expect(screen.getByTestId('station-area-context')).toHaveTextContent(/dentro/i),
  );
});

it('no muestra el contexto si no se conocen las coordenadas de la estacion', async () => {
  mockActiveArea(areaActiva(ANDES));
  mockStationMeta(null);
  renderStationPage('AR.TEST..HHZ');

  await screen.findByTestId('spectrogram-large-canvas');
  expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
});

it('no muestra el contexto con el area por defecto (mundo entero)', async () => {
  // `is_default: true` en la raíz — el usuario no eligió nada.
  mockActiveArea(areaActiva(ANDES, true));
  mockStationMeta({ latitude: -35, longitude: -70 });
  renderStationPage('AR.TEST..HHZ');

  await screen.findByTestId('spectrogram-large-canvas');
  expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
});

it('no muestra el contexto si el canal no esta en el catalogo', async () => {
  // Un canal escrito a mano en la URL, o una estación que el ingestor no
  // sigue: sin entrada en el catálogo no hay city_id, y sin city_id no hay
  // coordenadas. Mismo caso que "no se conocen las coordenadas".
  mockActiveArea(areaActiva(ANDES));
  mockStationCatalog([]);
  renderStationPage('XX.NADA..HHZ');

  await screen.findByTestId('spectrogram-large-canvas');
  expect(screen.queryByTestId('station-area-context')).not.toBeInTheDocument();
});

it('el fixture usa la forma real del contrato — minlat, no min_lat', () => {
  // Guarda contra el error que este plan casi comete: `bbox.min_lat` da
  // `undefined`, la comparación da `false`, y el componente diría "fuera"
  // SIEMPRE. Un bug mudo que ningún otro test de acá detectaría.
  expect(areaActiva(ANDES).area.bbox).toHaveProperty('minlat');
  expect(areaActiva(ANDES).area.bbox).not.toHaveProperty('min_lat');
  expect(areaActiva(ANDES)).toHaveProperty('is_default');
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run "app/(app)/stations/[channel]"
```
Esperado: FAIL — no existe `station-area-context`.

- [ ] **Step 3: Agregar i18n**

`dashboard/messages/es.json`, en `station`:
```json
"insideArea": "Dentro del área activa",
"outsideArea": "Fuera del área activa",
"seeAreaStations": "Ver estaciones del área"
```
`en.json`:
```json
"insideArea": "Inside the active area",
"outsideArea": "Outside the active area",
"seeAreaStations": "See stations in this area"
```

- [ ] **Step 4: Implementar**

En `dashboard/app/(app)/stations/[channel]/page.tsx`:

```tsx
import Link from 'next/link';
import useSWR from 'swr';
import { useActiveArea } from '@/lib/use-active-area';
import { seismicAPI } from '@/lib/api';
import { SEISMIC_CITIES } from '@/lib/seismic-cities';
// ...

  // El selector de área vive en el layout, así que ya se ve en esta pantalla.
  // Lo que faltaba era consumirlo: cambiar de área era un no-op visual.
  const { area: activeArea } = useActiveArea();

  // Las coordenadas NO están en esta página ni en el catálogo de estaciones
  // (verificado: station_catalog devuelve channel/city_id/network/station/
  // is_live/is_primary, sin lat/lon). Se resuelven por ciudad:
  //   channel → station-catalog → city_id → seismic-cities → {lat, lon}
  // La precisión es a nivel ciudad, que alcanza para un indicador de contexto.
  const { data: catalog } = useSWR('/spectrograms/station-catalog', () =>
    seismicAPI.getStationCatalog(),
  );

  const stationMeta = useMemo(() => {
    const entry = catalog?.find((c) => c.channel === channel);
    if (!entry) return null;
    const city = SEISMIC_CITIES.find((c) => c.id === entry.city_id);
    return city ? { latitude: city.lat, longitude: city.lon } : null;
  }, [catalog, channel]);

  // El área por defecto es el mundo entero: decir "dentro del área" ahí no
  // aporta nada, sólo ruido.
  //
  // OJO con la forma del tipo (verificado en `lib/types.ts:63-68` y `:105-108`):
  //   - `is_default` está en la RAÍZ del ActiveAreaResponse, NO dentro de `area`
  //   - los campos del bbox van SIN guion bajo: `minlat`, no `min_lat`
  // Escribirlos mal no da error de tipo si se accede con optional chaining
  // sobre `any`: da `undefined`, la comparación da `false`, y el componente
  // dice "fuera del área" SIEMPRE. Un bug mudo.
  const bbox = activeArea?.is_default ? null : activeArea?.area?.bbox ?? null;
  const inside =
    bbox && stationMeta
      ? stationMeta.latitude >= bbox.minlat &&
        stationMeta.latitude <= bbox.maxlat &&
        stationMeta.longitude >= bbox.minlon &&
        stationMeta.longitude <= bbox.maxlon
      : null;
```

Y en el JSX, arriba del espectrograma:
```tsx
      {inside !== null && (
        <div
          data-testid="station-area-context"
          className="mb-3 flex items-center gap-2 text-xs text-muted-foreground"
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${inside ? 'bg-teal-400' : 'bg-amber-400'}`}
          />
          {inside ? t('insideArea') : t('outsideArea')}
          <Link href="/stations" className="text-blue-400 hover:underline">
            {t('seeAreaStations')}
          </Link>
        </div>
      )}
```

Nota para quien implemente: verificar el nombre real de los campos del bbox en `dashboard/lib/areas.ts` (podría ser `bbox.minLat` o `bbox.min_lat`) y ajustar. Verificar también de dónde salen las coordenadas de la estación en esta página; si no las tiene, obtenerlas de `GET /spectrograms/station-catalog` o del metadata del canal.

- [ ] **Step 5: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run "app/(app)/stations/[channel]"
```

- [ ] **Step 6: Verificar por mutación**

Cambiar `useActiveArea()` por un `useSWR('/areas/active', getActiveArea)` pelado (sin suscripción).
Esperado: FALLA `se actualiza al cambiar de area sin recargar`.
**Revertir** y confirmar PASS.

- [ ] **Step 7: Suite completa y commit**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run
git add "dashboard/app/(app)/stations" dashboard/messages
git commit -m "feat(estaciones): el detalle dice si la estacion cae en el area activa"
```

- [ ] **Step 8: QA visual — lo hace el usuario**

- URLs: `http://localhost:3000/stations/RI.LPCA..EHZ` y `http://localhost:3000/globe`
- Qué mirar:
  1. En el detalle de estación, la línea de contexto dice dentro/fuera
  2. Cambiar de área en el dropdown **actualiza esa línea sin recargar**
  3. Con el área por defecto no aparece la línea
  4. En `/globe`, cambiar de área **reencuadra la cámara al toque**

---

# PR E — Borrar el sintético y arreglar el eje que miente

### Task E1: Borrar generate_synthetic_spectrogram

**Files:**
- Modify: `src/services/spectrogram_service.py` (borrar `:692-775` y el fallback `:807-827`)
- Create: `tests/unit/test_no_synthetic_fallback.py`

**Por qué:** el backend renderiza con matplotlib una imagen que el frontend **descarta siempre**. `SpectrogramViewReal.tsx:74`: `result.metadata?.network !== 'SYNTHETIC'` — si es sintético, muestra `noNearbyStation`. Son ~85 líneas de código muerto CON costo de CPU. Borrarlo no cambia un píxel de lo que se ve.

**Advertencia:** no existe ningún test del camino PNG (verificado). El único test del servicio, `test_spectrogram_generated_at.py`, **inspecciona el fuente en vez de ejecutarlo**. Ir con cuidado.

- [ ] **Step 1: Escribir el test que falla**

```python
"""El fallback sintético se borró: generaba imágenes que el frontend descarta.

El cliente filtra por `metadata.network !== 'SYNTHETIC'`
(dashboard/components/SpectrogramViewReal.tsx:74) y muestra el error
`noNearbyStation`. O sea: el backend gastaba matplotlib en una imagen que
nadie mira nunca. Al no haber estación real, ahora se devuelve el error
directo.
"""

import inspect

from src.services.spectrogram_service import SpectrogramService


def test_no_queda_generador_sintetico():
    assert not hasattr(SpectrogramService, "generate_synthetic_spectrogram")


def test_sin_estacion_real_no_se_cae_a_sintetico():
    fuente = inspect.getsource(SpectrogramService.generate_spectrogram_for_location)
    assert "synthetic" not in fuente.lower()


def test_el_servicio_ya_no_menciona_SYNTHETIC():
    fuente = inspect.getsource(SpectrogramService)
    assert "SYNTHETIC" not in fuente
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor && ./venv/bin/python -m pytest tests/unit/test_no_synthetic_fallback.py -v
```
Esperado: FAIL en los tres — el método todavía existe.

- [ ] **Step 3: Borrar**

En `src/services/spectrogram_service.py`:
- Borrar el método `generate_synthetic_spectrogram` completo (~`:692-775`)
- En `generate_spectrogram_for_location` (~`:776-830`), borrar la rama de fallback (~`:807-827`). Cuando `_try_real_spectrogram` devuelve `None`, devolver el error directo:

```python
        resultado = await self._try_real_spectrogram(
            city_id, latitude, longitude, network, duration_hours
        )
        if resultado is not None:
            return resultado

        # Sin estación FDSN real no se inventa señal. El fallback sintético
        # existía y renderizaba ruido con matplotlib, pero el frontend lo
        # descartaba SIEMPRE (filtra por metadata.network != 'SYNTHETIC') y
        # mostraba este mismo error. Era CPU gastada en una imagen que nadie
        # llegó a ver nunca.
        return {
            "success": False,
            "error": "no_nearby_station",
            "city_id": city_id,
        }
```

Verificar que el shape del error coincida con lo que espera `SpectrogramViewReal.tsx` (que chequea `result.success && result.image`): con `success: False` el frontend ya cae a `noNearbyStation`, que es el comportamiento que ya tenía.

Sacar los imports de matplotlib/numpy que queden sin uso **sólo si no los usa `generate_spectrogram_image`**, que se queda.

- [ ] **Step 4: Correr y verificar que pasa**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor && ./venv/bin/python -m pytest tests/unit/test_no_synthetic_fallback.py -v
```
Esperado: PASS, 3 tests.

- [ ] **Step 5: Suite de unit completa**

```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor && ./venv/bin/python -m pytest tests/unit -v
```
Esperado: sin regresiones. Prestar atención a `test_spectrogram_generated_at.py`, que inspecciona el fuente.

- [ ] **Step 6: Verificar que el servidor arranca de verdad**

Un import roto no lo detecta ningún test unitario (memoria: `correr-el-proceso-de-verdad-antes-del-pr`).
```bash
cd /Users/ezebc182/work/deshoku-apps/espectro-chechu/seismic-monitor && ./venv/bin/python -c "from src.main import app; print('import ok')"
```
Esperado: `import ok`, sin traceback.

- [ ] **Step 7: Commit**

```bash
git add src/services/spectrogram_service.py tests/unit/test_no_synthetic_fallback.py
git commit -m "refactor(espectrogramas): borra el generador sintetico que el frontend nunca mostraba"
```

### Task E2: El eje que miente en SpectrogramViewReal

**Files:**
- Modify: `dashboard/components/SpectrogramViewReal.tsx:212-242`
- Modify: `dashboard/components/SpectrogramViewReal.test.tsx`

**El bug:** las marcas de frecuencia (`:224-234`) salen de `SPECTROGRAM_FREQ_TICKS`, una constante que asume un eje lineal 0.1–20 Hz. Pero el techo del eje **depende del muestreo de cada estación** — medido en `spectrogram_columns`: hay canales que llegan a 10 Hz, otros a 20 y otros a 25 (memoria: `eje-frecuencia-cambia-por-canal`). En un canal que llega a 10 Hz, un eje rotulado 0–20 miente por factor 2.

Además las marcas de tiempo (`:236-242`) están escritas a mano como `-24h/-18h/...` sin relación con `duration_hours`.

**Restricción:** el eje del PNG lo fija el backend en `generate_spectrogram_image` (`fmin=0.1, fmax=20.0`). O sea, la imagen SIEMPRE se dibuja 0.1–20, tenga el canal el muestreo que tenga. El frontend no puede corregir el eje de una imagen ya renderizada. Lo honesto es que el rótulo diga qué eje es y que la señal por encima de Nyquist del canal no se lea como dato.

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// agregar a dashboard/components/SpectrogramViewReal.test.tsx

it('rotula el eje de tiempo segun las horas que realmente pidio', async () => {
  // Antes decía -24h/-18h/-12h/-6h fijo, sin relación con el rango real.
  renderView();
  await screen.findByRole('img');
  expect(screen.getByTestId('spectrogram-time-axis')).toHaveTextContent('-24h');
});

it('avisa que el eje de frecuencia es fijo y no el del canal', async () => {
  // El backend renderiza SIEMPRE 0.1-20 Hz (generate_spectrogram_image), pero
  // el techo real depende del muestreo: hay canales de 10, 20 y 25 Hz. Un eje
  // fijo miente por factor 2 en los de 10. No se puede corregir la imagen ya
  // renderizada, pero sí se puede decir qué eje es.
  renderView();
  await screen.findByRole('img');
  expect(screen.getByTestId('spectrogram-freq-axis')).toHaveAttribute(
    'title',
    expect.stringMatching(/0[.,]1.*20 ?Hz/i),
  );
});

it('enlaza al espectrograma con eje real de la estacion', async () => {
  // La salida honesta: el canvas de /stations/[channel] SÍ deriva el eje del
  // dato. Si el PNG no puede decir la verdad, al menos indica dónde está.
  renderViewWithMetadata({ network: 'AR', station: 'TEST', channel: 'HHZ' });
  expect(await screen.findByTestId('accurate-axis-link')).toHaveAttribute(
    'href',
    '/stations/AR.TEST..HHZ',
  );
});
```

- [ ] **Step 2: Correr y verificar que falla**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramViewReal.test.tsx
```
Esperado: FAIL — no existen los testids.

- [ ] **Step 3: Agregar i18n**

`dashboard/messages/es.json`, en `charts.spectrogram`:
```json
"fixedAxisWarning": "Eje fijo 0,1–20 Hz. El rango real depende del muestreo de la estación.",
"accurateAxis": "Ver con eje real"
```
`en.json`:
```json
"fixedAxisWarning": "Fixed 0.1–20 Hz axis. The real range depends on the station's sampling rate.",
"accurateAxis": "View with real axis"
```

- [ ] **Step 4: Implementar**

En `SpectrogramViewReal.tsx`, reemplazar el bloque de ejes (`:212-242`):

```tsx
      {/* Ejes de referencia del PNG.

          IMPORTANTE — este eje es FIJO y puede no ser el del canal. El backend
          renderiza siempre 0.1–20 Hz (`generate_spectrogram_image`), pero el
          techo real sale de `min(MAX_FREQ_HZ, fs/2)` y depende del muestreo:
          medido en `spectrogram_columns` hay canales de 10, 20 y 25 Hz. En uno
          de 10, este eje miente por factor 2.

          No se puede corregir el eje de una imagen ya renderizada — habría que
          cambiar el backend o dejar el PNG. Mientras tanto, lo honesto es
          decirlo y ofrecer la salida: el canvas de /stations/[channel] deriva
          el eje del dato real.

          Las marcas se posicionan por cálculo y no con `justify-between`
          porque el eje del backend es LINEAL: repartirlas a distancia uniforme
          las corría hasta 25 puntos porcentuales. */}
      <div
        data-testid="spectrogram-freq-axis"
        title={t('fixedAxisWarning')}
        className="absolute right-0 top-0 bottom-0 w-10 text-[9px] text-gray-400 pointer-events-none"
      >
        {SPECTROGRAM_FREQ_TICKS.map((hz) => (
          <span
            key={hz}
            className="absolute right-0 px-1 -translate-y-1/2"
            style={{ top: `${freqTickOffset(hz)}%` }}
          >
            {hz}Hz
          </span>
        ))}
      </div>

      {/* El eje de tiempo sale de las horas realmente pedidas, no de una lista
          escrita a mano: antes decía -24h/-18h/-12h/-6h aunque el rango fuera
          otro. */}
      <div
        data-testid="spectrogram-time-axis"
        className="absolute bottom-0 left-0 right-12 h-4 flex justify-between items-center text-[9px] text-gray-400 px-2 bg-gradient-to-t from-black/80 to-transparent pointer-events-none"
      >
        {timeAxisLabels(DURATION_HOURS).map((label) => (
          <span key={label}>{label}</span>
        ))}
        <span>{t('axisNow')}</span>
      </div>

      {/* Salida al eje honesto. Sólo con canal real: sin `channel` no hay
          estación que abrir. */}
      {metadata?.channel && metadata.network !== 'SYNTHETIC' && (
        <Link
          data-testid="accurate-axis-link"
          href={`/stations/${encodeURIComponent(
            `${metadata.network}.${metadata.station}..${metadata.channel}`,
          )}`}
          title={t('accurateAxis')}
          className="absolute bottom-5 right-2 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-blue-300 hover:text-blue-200"
        >
          {t('accurateAxis')}
        </Link>
      )}
```

Y arriba del componente:
```ts
/** Horas que se le piden al backend; el eje de tiempo se rotula con esto. */
const DURATION_HOURS = 24;

/** Etiquetas del eje de tiempo derivadas del rango pedido, en 4 tramos. */
function timeAxisLabels(hours: number): string[] {
  return [0, 1, 2, 3].map((i) => `-${Math.round(hours - (hours / 4) * i)}h`);
}
```
Reemplazar el `24` literal de la llamada a `getSpectrogram` (`:71`) por `DURATION_HOURS`.

- [ ] **Step 5: Correr y verificar que pasa**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run components/SpectrogramViewReal.test.tsx
```

- [ ] **Step 6: Verificar por mutación**

Cambiar `timeAxisLabels(DURATION_HOURS)` por `timeAxisLabels(6)`.
Esperado: FALLA `rotula el eje de tiempo segun las horas que realmente pidio`.
**Revertir** y confirmar PASS.

- [ ] **Step 7: Suite completa y commit**

```bash
cd dashboard && export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH" && ./node_modules/.bin/vitest run
git add dashboard/components/SpectrogramViewReal.tsx dashboard/components/SpectrogramViewReal.test.tsx dashboard/messages
git commit -m "fix(espectrogramas): el eje del PNG dice que es fijo y ofrece el eje real"
```

- [ ] **Step 8: QA visual — lo hace el usuario**

- URL: `http://localhost:3000/spectrograms` — buscar una tarjeta en modo 24h
- Qué mirar:
  1. El eje de tiempo dice -24h/-18h/-12h/-6h/ahora, coherente con lo pedido
  2. Hover sobre las marcas de frecuencia → tooltip que aclara que el eje es fijo
  3. Aparece "Ver con eje real" y lleva al detalle de estación
  4. Una ciudad sin estación cercana muestra el error, no ruido simulado

---

## Fuera de alcance (anotado, no incluido)

- **Copiar al portapapeles una imagen con escala, timestamp y estación.** Pedido explícito del usuario para "después". Es su propio PR: hay que renderizar el canvas + los ejes + un pie de metadatos a un `Blob` y escribirlo con `navigator.clipboard.write()`. Conviene hacerlo **después del PR B**, porque el lugar natural del botón es el modal.
- **Marcar y compartir regiones (brush).** También del usuario, para "después". Se apoya en el viewport del PR A: un brush produce un `Viewport` y ya existe todo lo demás.
- **Cache key sin lat/lon** en `main.py:2600-2607`: `spectrogram:{city_id}:{duration_hours}` ignora `latitude`, `longitude` y `network`, que sí están en la firma (`:2588`). Hoy no explota porque el único llamador manda siempre las coords de la ciudad, pero queda anotado. Si en algún momento se retira el PNG entero, se va solo.
- **Las ~6 ciudades sin canal vivo.** Averiguar por qué no están en `LIVE_CANDIDATES_BY_CITY` (27 de 33) y si se les puede dar canal. Si se resuelve, el PNG queda sin usuarios y se retira entero. Decisión del usuario: no en este lote.
- **Retirar `SpectrogramViewReal` y matplotlib por completo.** Depende del punto anterior.

## Verificación de cobertura

| Pedido del usuario | Task |
|---|---|
| Zoom y pan en SpectrogramLarge | A1–A4 |
| Selector de área contextual | D1–D3 |
| Retirar PNG/matplotlib del camino caliente | E1 (alcance acotado con evidencia; el resto anotado) |
| Nombre de la pantalla: "Espectrogramas" | C1 |
| Elegir 24h/live en la pantalla | B2 (toggle siempre visible) |
| Decir que no todos tienen transmisión | B2 (tooltip) + C1 (aviso de página) |
| "Ampliar" abre modal grande | B1, B2 |
| Enlace al detalle de estación en el modal | B1 |
| Copiar al portapapeles | Fuera de alcance, anotado |
