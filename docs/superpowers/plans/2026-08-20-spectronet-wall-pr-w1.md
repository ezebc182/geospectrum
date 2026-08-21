# PR-W1 — Muro SPECTRONET en /globe + foco de eventos: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** La cartelera de `/globe` muestra el muro estilo SPECTRONET (columnas por región, etiqueta a la izquierda, tiras sin gaps) con muro default "Global" server-side, foco de cámara configurable (random/latest) y evento enfocado resaltado en el sidebar.

**Architecture:** El backend materializa el agrupamiento por región (hoy solo existe en comentarios) y sirve el muro default como JSON. El frontend agrega una tira "bare" (sin tag superpuesto), un componente de muro por columnas, una lib pura de foco de cámara y el resaltado por `spotlightEvent.id` en el sidebar existente.

**Tech Stack:** FastAPI (endpoint estático de muro); Next.js + canvas (tiras existentes); vitest/pytest.

**Spec:** `docs/superpowers/specs/2026-08-20-spectronet-wall-design.md`

## Global Constraints

- Rama: `feat/spectronet-wall` desde `main`.
- Las tiras del muro NUNCA se desmontan al rotar slides (L674-676 de `GlobeBroadcastOverlay.tsx`: evita reconectar ~74 WebSockets) — el muro nuevo hereda ese requisito: visibilidad por clases, no por montaje.
- Colores/estilo SPECTRONET: etiqueta blanca sobre negro, mayúsculas, tira a la derecha, **gap 0 dentro del grupo**.
- i18n paridad `es.json`/`en.json`; identificadores en inglés, comentarios en español; TDD estricto; sin atribución de IA en commits.
- Tests backend: `./venv/bin/python -m pytest tests/unit/<archivo> -q --no-cov`. Frontend: `cd dashboard && npx vitest run <archivo>`.
- Anclas del código actual (verificadas 2026-08-20): `wallStrips` en `GlobeBroadcastOverlay.tsx:197-204`, render del muro L677-693, spotlight L301-324, sidebar L483-513, `SPECTRO_WIDTH=240/SPECTRO_HEIGHT=44` L87-88, `LIVE_CANDIDATES_BY_CITY` en `src/services/spectrogram_service.py:89-129`.

---

### Task 1: Backend — regiones y muro default "Global"

**Files:**
- Create: `src/services/wall_service.py`
- Modify: `src/main.py` (nuevo endpoint, junto a los de `/stations`)
- Test: `tests/unit/test_wall_service.py`

**Interfaces:**
- Produces: `GET /walls/global` → `{"id": "global", "name": "Global", "layout": {"columns": [{"groups": [{"title": str, "channels": [{"channel": str, "label": str}]}]}], "showMetrics": false}}`. `channel` es SCNL completo; `label` es el nombre de ciudad para la etiqueta de la tira. Task 4 lo consume.
- Produces: `pack_groups_into_columns(groups: list[dict], n_columns: int) -> list[list[dict]]` — reparto balanceado por cantidad de tiras.

- [ ] **Step 1: Escribir los tests que fallan**

```python
# tests/unit/test_wall_service.py
"""Muro default "Global": agrupamiento por región y reparto en columnas."""

from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY
from src.services.wall_service import (
    CITY_REGIONS,
    build_global_wall,
    pack_groups_into_columns,
)


def test_toda_ciudad_viva_tiene_region():
    # Si se agrega una ciudad al catálogo sin mapear su región, este test
    # canta — el fallback "OTROS" es para datos dinámicos, no para el catálogo.
    for city_id in LIVE_CANDIDATES_BY_CITY:
        assert city_id in CITY_REGIONS, f"{city_id} sin región asignada"


def test_muro_global_incluye_cada_ciudad_una_sola_vez():
    wall = build_global_wall()
    channels = [
        ch["channel"]
        for col in wall["layout"]["columns"]
        for grp in col["groups"]
        for ch in grp["channels"]
    ]
    # Una tira por ciudad: el canal primario (primero de la lista de candidatos)
    assert len(channels) == len(LIVE_CANDIDATES_BY_CITY)
    assert len(set(channels)) == len(channels)
    primaries = {cands[0] for cands in LIVE_CANDIDATES_BY_CITY.values()}
    assert set(channels) == primaries


def test_muro_global_agrupa_por_region_y_etiqueta_con_ciudad():
    wall = build_global_wall()
    titles = {g["title"] for col in wall["layout"]["columns"] for g in col["groups"]}
    assert "SUDAMÉRICA" in titles
    labels = [
        ch["label"]
        for col in wall["layout"]["columns"]
        for g in col["groups"]
        for ch in g["channels"]
    ]
    assert any("Tokyo" in lab or "Tokio" in lab for lab in labels)


def test_reparto_en_columnas_balancea_por_cantidad_de_tiras():
    groups = [
        {"title": "A", "channels": [{}] * 10},
        {"title": "B", "channels": [{}] * 6},
        {"title": "C", "channels": [{}] * 5},
        {"title": "D", "channels": [{}] * 1},
    ]
    cols = pack_groups_into_columns(groups, 2)
    sizes = [sum(len(g["channels"]) for g in col) for col in cols]
    # Greedy por columna más liviana: 10+1 y 6+5 → 11 y 11
    assert sizes == [11, 11]
    # Un grupo nunca se parte entre columnas
    all_titles = [g["title"] for col in cols for g in col]
    assert sorted(all_titles) == ["A", "B", "C", "D"]
```

- [ ] **Step 2: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/unit/test_wall_service.py -q --no-cov`
Expected: FAIL con `ModuleNotFoundError: No module named 'src.services.wall_service'`

- [ ] **Step 3: Implementación**

```python
# src/services/wall_service.py
"""Muro default "Global" estilo SPECTRONET.

El agrupamiento por región no existe como dato en los catálogos (solo como
comentarios en spectrogram_service.py): acá se materializa. Una tira por
ciudad = su canal primario (LIVE_CANDIDATES_BY_CITY[city][0]); el failover
en vivo lo sigue resolviendo live-channels por debajo.
"""

from src.services.spectrogram_service import LIVE_CANDIDATES_BY_CITY

# city_id -> región (títulos en mayúsculas, como las etiquetas de SPECTRONET)
CITY_REGIONS: dict[str, str] = {
    "tokyo": "ASIA-PACÍFICO", "osaka": "ASIA-PACÍFICO", "taipei": "ASIA-PACÍFICO",
    "guam": "ASIA-PACÍFICO", "kathmandu": "ASIA-PACÍFICO",
    "lima": "SUDAMÉRICA", "arequipa": "SUDAMÉRICA", "santiago": "SUDAMÉRICA",
    "valparaiso": "SUDAMÉRICA", "antofagasta": "SUDAMÉRICA",
    "quito": "SUDAMÉRICA", "bogota": "SUDAMÉRICA",
    "mexicocity": "CENTROAMÉRICA Y CARIBE", "sanjose": "CENTROAMÉRICA Y CARIBE",
    "managua": "CENTROAMÉRICA Y CARIBE", "portauprince": "CENTROAMÉRICA Y CARIBE",
    "losangeles": "NORTEAMÉRICA", "sandiego": "NORTEAMÉRICA",
    "sanfrancisco": "NORTEAMÉRICA", "portland": "NORTEAMÉRICA",
    "seattle": "NORTEAMÉRICA", "vancouver": "NORTEAMÉRICA", "anchorage": "NORTEAMÉRICA",
    "istanbul": "EUROPA-MEDITERRÁNEO",
    "wellington": "OCEANÍA", "auckland": "OCEANÍA", "christchurch": "OCEANÍA",
}

# Nombres de ciudad para la etiqueta (el frontend tiene su catálogo, pero el
# muro default se sirve completo para no acoplar el render al city_id)
CITY_LABELS: dict[str, str] = {
    "tokyo": "Tokyo", "osaka": "Osaka", "taipei": "Taipei", "guam": "Guam",
    "kathmandu": "Kathmandu", "lima": "Lima", "arequipa": "Arequipa",
    "santiago": "Santiago", "valparaiso": "Valparaíso", "antofagasta": "Antofagasta",
    "quito": "Quito", "bogota": "Bogotá", "mexicocity": "México DF",
    "sanjose": "San José", "managua": "Managua", "portauprince": "Port-au-Prince",
    "losangeles": "Los Angeles", "sandiego": "San Diego", "sanfrancisco": "San Francisco",
    "portland": "Portland", "seattle": "Seattle", "vancouver": "Vancouver",
    "anchorage": "Anchorage", "istanbul": "Istanbul", "wellington": "Wellington",
    "auckland": "Auckland", "christchurch": "Christchurch",
}

GLOBAL_WALL_COLUMNS = 5  # como el muro de SPECTRONET: columnas verticales densas


def pack_groups_into_columns(groups: list[dict], n_columns: int) -> list[list[dict]]:
    """Greedy: cada grupo (entero, nunca partido) va a la columna más liviana."""
    ordered = sorted(groups, key=lambda g: len(g["channels"]), reverse=True)
    columns: list[list[dict]] = [[] for _ in range(n_columns)]
    sizes = [0] * n_columns
    for group in ordered:
        target = sizes.index(min(sizes))
        columns[target].append(group)
        sizes[target] += len(group["channels"])
    return [col for col in columns if col]


def build_global_wall() -> dict:
    by_region: dict[str, list[dict]] = {}
    for city_id, candidates in LIVE_CANDIDATES_BY_CITY.items():
        region = CITY_REGIONS.get(city_id, "OTROS")
        by_region.setdefault(region, []).append(
            {"channel": candidates[0], "label": CITY_LABELS.get(city_id, city_id)}
        )
    groups = [
        {"title": region, "channels": sorted(chs, key=lambda c: c["label"])}
        for region, chs in sorted(by_region.items())
    ]
    return {
        "id": "global",
        "name": "Global",
        "layout": {
            "columns": [
                {"groups": col} for col in pack_groups_into_columns(groups, GLOBAL_WALL_COLUMNS)
            ],
            "showMetrics": False,
        },
    }
```

```python
# agregar a src/main.py (junto a los endpoints de stations/spectrograms)
@app.get("/walls/global", tags=["walls"])
async def get_global_wall() -> dict:
    """Muro default "Global" estilo SPECTRONET (estático, generado del catálogo)."""
    from src.services.wall_service import build_global_wall

    return build_global_wall()
```

- [ ] **Step 4: Verificar que pasa + suite**

Run: `./venv/bin/python -m pytest tests/unit/test_wall_service.py -q --no-cov && ./venv/bin/python -m pytest tests/unit -q 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 5: Commit**

```bash
git add src/services/wall_service.py src/main.py tests/unit/test_wall_service.py
git commit -m "feat(muro): regiones materializadas y muro default Global por endpoint"
```

---

### Task 2: Lib pura de foco de eventos

**Files:**
- Create: `dashboard/lib/event-focus.ts`
- Test: `dashboard/lib/event-focus.test.ts`

**Interfaces:**
- Produces (Task 5 consume):
  - `type FocusMode = 'random' | 'latest'`
  - `FOCUS_POOL_SIZE = 20`, `FOCUS_INTERVAL_MS = 20_000`
  - `pickSpotlight(mode: FocusMode, eventos: SeismicEvent[], lastId: string | null, rand: () => number): SeismicEvent | null`
  - `readFocusMode(search: string, stored: string | null): FocusMode` — query param `?focus=` gana sobre localStorage; default `'random'`.
- Consumes: `SeismicEvent` de `dashboard/lib/types.ts` (campos `id`, `hora_utc`, `mag`).

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// dashboard/lib/event-focus.test.ts
import { describe, expect, it } from 'vitest';
import { FOCUS_POOL_SIZE, pickSpotlight, readFocusMode } from './event-focus';
import type { SeismicEvent } from './types';

const ev = (id: string, horaUtc: string, mag = 4): SeismicEvent => ({
  id,
  fuentes: ['usgs'],
  hora_utc: horaUtc,
  lat: 0,
  lon: 0,
  prof_km: 10,
  mag,
  mag_tipo: 'mb',
  lugar: null,
  sentido: false,
  revisado: false,
});

describe('pickSpotlight modo random', () => {
  it('elige entre los MÁS RECIENTES (no por magnitud) sin repetir el anterior', () => {
    // 30 eventos: los 20 más nuevos son el pool aunque los viejos tengan más magnitud
    const eventos = Array.from({ length: 30 }, (_, i) =>
      ev(`e${i}`, `2026-08-20T${String(i % 24).padStart(2, '0')}:00:00Z`, i < 10 ? 8 : 4)
    ).sort((a, b) => (a.hora_utc < b.hora_utc ? 1 : -1));
    const pool = eventos.slice(0, FOCUS_POOL_SIZE).map((e) => e.id);

    const picked = pickSpotlight('random', eventos, 'e5', () => 0.99);
    expect(picked).not.toBeNull();
    expect(pool).toContain(picked!.id);
    expect(picked!.id).not.toBe('e5');
  });

  it('con un solo evento lo devuelve aunque sea el anterior', () => {
    const only = [ev('solo', '2026-08-20T10:00:00Z')];
    expect(pickSpotlight('random', only, 'solo', () => 0)!.id).toBe('solo');
  });
});

describe('pickSpotlight modo latest', () => {
  it('devuelve el más nuevo por hora_utc', () => {
    const eventos = [
      ev('viejo', '2026-08-20T01:00:00Z', 8),
      ev('nuevo', '2026-08-20T23:00:00Z', 3),
    ];
    expect(pickSpotlight('latest', eventos, null, () => 0)!.id).toBe('nuevo');
  });

  it('si el más nuevo ya es el enfocado, devuelve null (la cámara NO se mueve)', () => {
    const eventos = [ev('nuevo', '2026-08-20T23:00:00Z')];
    expect(pickSpotlight('latest', eventos, 'nuevo', () => 0)).toBeNull();
  });
});

describe('readFocusMode', () => {
  it('el query param gana sobre lo guardado', () => {
    expect(readFocusMode('?focus=latest', 'random')).toBe('latest');
  });
  it('sin query usa lo guardado; sin nada, random', () => {
    expect(readFocusMode('', 'latest')).toBe('latest');
    expect(readFocusMode('', null)).toBe('random');
    expect(readFocusMode('?focus=cualquiercosa', null)).toBe('random');
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run lib/event-focus.test.ts`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementación**

```typescript
// dashboard/lib/event-focus.ts
/**
 * Elección del evento a enfocar por la cámara del globo (spec §4).
 * Lib pura: la animación de cámara queda en el componente; acá solo se
 * decide QUÉ mirar, inyectando el azar para poder testear.
 */

import type { SeismicEvent } from './types';

export type FocusMode = 'random' | 'latest';

export const FOCUS_POOL_SIZE = 20;
export const FOCUS_INTERVAL_MS = 20_000;

function newestFirst(eventos: SeismicEvent[]): SeismicEvent[] {
  return [...eventos].sort((a, b) => (a.hora_utc < b.hora_utc ? 1 : -1));
}

export function pickSpotlight(
  mode: FocusMode,
  eventos: SeismicEvent[],
  lastId: string | null,
  rand: () => number
): SeismicEvent | null {
  if (eventos.length === 0) return null;
  const ordered = newestFirst(eventos);

  if (mode === 'latest') {
    const newest = ordered[0];
    // null = "no mover la cámara": el enfocado ya es el último recibido
    return newest.id === lastId ? null : newest;
  }

  const pool = ordered.slice(0, FOCUS_POOL_SIZE);
  const candidates = pool.length > 1 ? pool.filter((e) => e.id !== lastId) : pool;
  return candidates[Math.floor(rand() * candidates.length)] ?? null;
}

export function readFocusMode(search: string, stored: string | null): FocusMode {
  const fromQuery = new URLSearchParams(search).get('focus');
  if (fromQuery === 'random' || fromQuery === 'latest') return fromQuery;
  if (stored === 'random' || stored === 'latest') return stored;
  return 'random';
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd dashboard && npx vitest run lib/event-focus.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/event-focus.ts dashboard/lib/event-focus.test.ts
git commit -m "feat(globo): lib pura de foco de eventos (random/latest)"
```

---

### Task 3: Tira SPECTRONET (etiqueta a la izquierda)

**Files:**
- Modify: `dashboard/components/LiveSpectrogramCanvas.tsx` (variante nueva `'bare'`)
- Create: `dashboard/components/SpectronetStrip.tsx`
- Test: `dashboard/components/SpectronetStrip.test.tsx`

**Interfaces:**
- Consumes: `LiveSpectrogramCanvas` — se agrega `variant: 'default' | 'strip' | 'bare'`. La variante `bare` devuelve SOLO el contenedor con el canvas (sin tag superpuesto, sin punto de estado): `<div className="relative overflow-hidden bg-black" style={{width,height}}><canvas .../></div>`. El WebSocket/historial no cambian.
- Produces: `<SpectronetStrip channel="IU.MAJO.00.BHZ" label="Tokyo" width={240} height={28} />` — etiqueta blanca sobre negro a la IZQUIERDA (ancho fijo 96 px) + tira `bare` a la derecha. Task 4 lo consume.

- [ ] **Step 1: Escribir el test que falla**

```tsx
// dashboard/components/SpectronetStrip.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpectronetStrip } from './SpectronetStrip';

vi.mock('./LiveSpectrogramCanvas', () => ({
  LiveSpectrogramCanvas: ({ channel, variant }: { channel: string; variant: string }) => (
    <div data-testid="canvas-mock" data-channel={channel} data-variant={variant} />
  ),
}));

describe('SpectronetStrip', () => {
  it('pone la etiqueta a la IZQUIERDA de la tira, en mayúsculas', () => {
    render(<SpectronetStrip channel="IU.MAJO.00.BHZ" label="Tokyo" width={240} height={28} />);
    const label = screen.getByText('TOKYO');
    const canvas = screen.getByTestId('canvas-mock');
    // La etiqueta precede al canvas en el DOM (flex row)
    expect(label.compareDocumentPosition(canvas) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(canvas.getAttribute('data-variant')).toBe('bare');
    expect(canvas.getAttribute('data-channel')).toBe('IU.MAJO.00.BHZ');
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run components/SpectronetStrip.test.tsx`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementación**

En `LiveSpectrogramCanvas.tsx`, ampliar el tipo de `variant` y agregar ANTES del `if (variant === 'strip')`:

```tsx
  if (variant === 'bare') {
    // Tira desnuda para el muro SPECTRONET: la etiqueta vive FUERA, en
    // SpectronetStrip. El punto de estado se conserva (spec §1: una estación
    // caída se ve negra CON punto rojo, y el muro no salta).
    return (
      <div className="relative overflow-hidden bg-black" style={{ width, height }}>
        <canvas ref={canvasRef} width={width} height={height} className="block" />
        {status !== 'live' && (
          <span
            className={`absolute top-1 right-1 h-1.5 w-1.5 rounded-full ${
              status === 'error' ? 'bg-red-500' : 'bg-yellow-400'
            }`}
          />
        )}
      </div>
    );
  }
```

```tsx
// dashboard/components/SpectronetStrip.tsx
'use client';

import { LiveSpectrogramCanvas } from './LiveSpectrogramCanvas';

interface SpectronetStripProps {
  channel: string;
  label: string;
  width: number; // ancho de la tira (sin contar la etiqueta)
  height: number;
}

export const SPECTRONET_LABEL_WIDTH = 96;

/** Tira estilo SPECTRONET: etiqueta blanca sobre negro a la izquierda, tira a la derecha. */
export function SpectronetStrip({ channel, label, width, height }: SpectronetStripProps) {
  return (
    <div className="flex items-stretch" style={{ height }}>
      <div
        className="flex items-center justify-end bg-black pr-1.5 text-right font-mono text-[10px] font-bold uppercase leading-none tracking-tight text-white"
        style={{ width: SPECTRONET_LABEL_WIDTH }}
      >
        {label.toUpperCase()}
      </div>
      <LiveSpectrogramCanvas channel={channel} label={label} width={width} height={height} variant="bare" />
    </div>
  );
}
```

- [ ] **Step 4: Verificar que pasa + suite del dashboard**

Run: `cd dashboard && npx vitest run components/SpectronetStrip.test.tsx && npx vitest run 2>&1 | tail -2`
Expected: PASS todo (la variante nueva no toca `default` ni `strip`)

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/LiveSpectrogramCanvas.tsx dashboard/components/SpectronetStrip.tsx dashboard/components/SpectronetStrip.test.tsx
git commit -m "feat(muro): tira SPECTRONET con etiqueta externa a la izquierda"
```

---

### Task 4: Componente SpectronetWall y reemplazo del muro de la cartelera

**Files:**
- Create: `dashboard/components/SpectronetWall.tsx`
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (L677-693: reemplazar el flex-wrap de `wallStrips`)
- Modify: `dashboard/lib/api.ts` (método `getGlobalWall()`)
- Test: `dashboard/components/SpectronetWall.test.tsx` + actualizar `GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Consumes: `GET /walls/global` (Task 1) vía `seismicAPI.getGlobalWall(): Promise<WallResponse>` con `interface WallResponse { id: string; name: string; layout: { columns: { groups: { title: string; channels: { channel: string; label: string }[] }[] }[]; showMetrics: boolean } }` (agregar el tipo en `dashboard/lib/types.ts`); `SpectronetStrip` (Task 3).
- Produces: `<SpectronetWall wall={wallResponse} stripWidth={240} stripHeight={28} />` — columnas flex horizontales; dentro de cada columna, grupos con encabezado y tiras apiladas `gap-0`; grupos separados por `mt-2`.

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// dashboard/components/SpectronetWall.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SpectronetWall } from './SpectronetWall';

vi.mock('./SpectronetStrip', () => ({
  SpectronetStrip: ({ channel, label }: { channel: string; label: string }) => (
    <div data-testid="strip" data-channel={channel}>{label}</div>
  ),
}));

const wall = {
  id: 'global',
  name: 'Global',
  layout: {
    columns: [
      {
        groups: [
          {
            title: 'SUDAMÉRICA',
            channels: [
              { channel: 'IU.LCO..BHZ', label: 'Santiago' },
              { channel: 'II.NNA.00.BHZ', label: 'Lima' },
            ],
          },
        ],
      },
      { groups: [{ title: 'OCEANÍA', channels: [{ channel: 'NZ.BKZ.10.HHZ', label: 'Auckland' }] }] },
    ],
    showMetrics: false,
  },
};

describe('SpectronetWall', () => {
  it('renderiza columnas con encabezados de grupo y una tira por canal', () => {
    render(<SpectronetWall wall={wall} stripWidth={240} stripHeight={28} />);
    expect(screen.getByText('SUDAMÉRICA')).toBeTruthy();
    expect(screen.getByText('OCEANÍA')).toBeTruthy();
    expect(screen.getAllByTestId('strip')).toHaveLength(3);
  });

  it('las tiras de un grupo van apiladas sin gap (contenedor gap-0)', () => {
    render(<SpectronetWall wall={wall} stripWidth={240} stripHeight={28} />);
    const group = screen.getByTestId('wall-group-SUDAMÉRICA');
    expect(group.className).toContain('gap-0');
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run components/SpectronetWall.test.tsx`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementación**

```tsx
// dashboard/components/SpectronetWall.tsx
'use client';

import type { WallResponse } from '@/lib/types';
import { SpectronetStrip } from './SpectronetStrip';

interface SpectronetWallProps {
  wall: WallResponse;
  stripWidth: number;
  stripHeight: number;
}

/** Muro estilo SPECTRONET: columnas verticales, grupos por región, tiras sin gap. */
export function SpectronetWall({ wall, stripWidth, stripHeight }: SpectronetWallProps) {
  return (
    <div className="flex h-full justify-center gap-3 overflow-hidden p-3">
      {wall.layout.columns.map((column, ci) => (
        <div key={ci} className="flex flex-col gap-2 overflow-hidden">
          {column.groups.map((group) => (
            <div key={group.title}>
              <div className="border-b border-gray-700 bg-black px-1 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
                {group.title}
              </div>
              <div data-testid={`wall-group-${group.title}`} className="flex flex-col gap-0">
                {group.channels.map((ch) => (
                  <SpectronetStrip
                    key={ch.channel}
                    channel={ch.channel}
                    label={ch.label}
                    width={stripWidth}
                    height={stripHeight}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
```

En `dashboard/lib/api.ts`, junto a `getLiveChannels()`: agregar `getGlobalWall()` que hace `GET ${API_BASE}/walls/global` con el mismo patrón de fetch/errores del resto de los métodos (leer 2-3 métodos vecinos y copiar el patrón exacto). Tipo `WallResponse` en `types.ts`.

En `GlobeBroadcastOverlay.tsx`:
- Nuevo SWR: `useSWR('broadcast-wall', () => seismicAPI.getGlobalWall(), { revalidateOnFocus: false })`.
- Reemplazar el bloque L677-693 (flex-wrap de `wallStrips`) por `<SpectronetWall wall={wallData} stripWidth={240} stripHeight={28} />` cuando `wallData` esté; mientras carga, mantener el muro actual con `wallStrips` como fallback (el muro NUNCA en blanco). La visibilidad sigue por clases `flex`/`hidden` (requisito de no desmontar).
- `wallStrips` (L197-204) queda como fallback — no borrar.

Actualizar en `GlobeBroadcastOverlay.test.tsx` el caso "el botón cartelera abre el muro con TODAS las estaciones vivas": mockear `getGlobalWall` (agregar al mock de `seismicAPI` existente) devolviendo un muro con los mismos canales del mock de `getLiveChannels`, y asertar que el muro muestra los encabezados de grupo y una tira por canal.

- [ ] **Step 4: Verificar que pasa + suites**

Run: `cd dashboard && npx vitest run components/SpectronetWall.test.tsx components/GlobeBroadcastOverlay.test.tsx && npx vitest run 2>&1 | tail -2`
Expected: todo passed

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/SpectronetWall.tsx dashboard/components/SpectronetWall.test.tsx dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx dashboard/lib/api.ts dashboard/lib/types.ts
git commit -m "feat(muro): cartelera con layout SPECTRONET por columnas y regiones"
```

---

### Task 5: Modos de foco en la cartelera + toggle de configuración

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (spotlight L301-324 + popover de config L516-634)
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json`
- Test: actualizar `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Consumes: `pickSpotlight`, `readFocusMode`, `FOCUS_INTERVAL_MS` (Task 2).
- Produces: estado `focusMode: FocusMode` persistido en localStorage key `globe.broadcast.focus.v1` y query param `?focus=`; el spotlight existente pasa a decidirse con `pickSpotlight`.

- [ ] **Step 1: Escribir los tests que fallan** (agregar a `GlobeBroadcastOverlay.test.tsx`, siguiendo sus mocks existentes)

```tsx
describe('foco de eventos', () => {
  it('en modo latest el spotlight es el evento más nuevo', async () => {
    window.history.replaceState(null, '', '?focus=latest');
    renderOverlay(); // helper existente del archivo de tests
    await waitFor(() => {
      // el evento más reciente del mock queda destacado en el sidebar
      expect(screen.getByTestId('feed-row-focused').textContent).toContain(NEWEST_MOCK_PLACE);
    });
    window.history.replaceState(null, '', '/');
  });

  it('el toggle de foco cambia el modo y lo persiste', async () => {
    renderOverlay();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /config/i })); // engranaje existente
    await user.click(screen.getByRole('radio', { name: /latest/i }));
    expect(localStorage.getItem('globe.broadcast.focus.v1')).toBe('latest');
  });
});
```

Nota: `NEWEST_MOCK_PLACE` = el `lugar` del evento con `hora_utc` más nueva del fixture de eventos ya usado por el archivo; `renderOverlay` es el helper de render existente (si tiene otro nombre, usar el del archivo). El testid `feed-row-focused` lo introduce Task 6 — estos dos tests se escriben acá y quedan en RED hasta cerrar Task 6 (se ejecutan juntos al final de Task 6; el resto de la suite debe seguir verde).

- [ ] **Step 2: Implementar en el overlay**

- Estado nuevo: `const [focusMode, setFocusMode] = useState<FocusMode>(() => readFocusMode(window.location.search, localStorage.getItem('globe.broadcast.focus.v1')));` (con guard `typeof window !== 'undefined'` como hacen los otros estados persistidos del archivo).
- Reemplazar el efecto del spotlight (L309-324): el `setInterval` usa `FOCUS_INTERVAL_MS` y `pickSpotlight(focusMode, eventos ?? [], lastId, Math.random)`; si devuelve `null` (modo latest sin evento nuevo) NO toca `spotlightEvent`. En modo `latest`, además, reaccionar al cambio de `eventos` (el efecto ya depende del pool — agregar `focusMode` y `eventos` a las deps).
- En el popover de configuración (L516-634): grupo de dos radios "Foco: aleatorio / último evento" con `role="radio"`, que setea `focusMode` y persiste en localStorage.
- i18n: claves `broadcast.focus.label`, `broadcast.focus.random`, `broadcast.focus.latest` en es/en.

- [ ] **Step 3: Verificar suites** (los 2 tests nuevos quedan RED por el testid de Task 6; el resto verde)

Run: `cd dashboard && npx vitest run components/GlobeBroadcastOverlay.test.tsx`
Expected: solo fallan los 2 tests nuevos de foco, por `feed-row-focused` inexistente

- [ ] **Step 4: Commit**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(globo): modos de foco random/latest configurables y persistidos"
```

---

### Task 6: Resaltado del evento enfocado en el sidebar + clic en el globo

**Files:**
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (sidebar L483-513)
- Modify: `dashboard/components/SeismicGlobe.tsx` (prop `onEventClick` opcional)
- Test: `dashboard/components/GlobeBroadcastOverlay.test.tsx` (los 2 tests RED de Task 5 + 1 nuevo)

**Interfaces:**
- Consumes: `spotlightEvent` (estado existente L308) como fuente única del "evento enfocado".
- Produces: `SeismicGlobe` acepta `onEventClick?: (eventId: string) => void` — se dispara en el handler de clic de puntos que ya usa para `selectedEventId` (leer el handler existente `onPointClick`/equivalente en `SeismicGlobe.tsx` y encadenar la llamada, sin cambiar el comportamiento actual).

- [ ] **Step 1: Test nuevo del clic** (agregar)

```tsx
it('el clic en un evento del globo lo enfoca y resalta en el sidebar', async () => {
  renderOverlay();
  // El mock de SeismicGlobe del archivo expone las props: invocar onEventClick
  // con el id de un evento del fixture (extender el mock si solo captura eventos).
  act(() => capturedGlobeProps.onEventClick?.(SOME_MOCK_EVENT_ID));
  await waitFor(() => {
    expect(screen.getByTestId('feed-row-focused').textContent).toContain(SOME_MOCK_EVENT_PLACE);
  });
});
```

(`capturedGlobeProps` = patrón de captura del mock de `SeismicGlobe` que el archivo de tests ya usa para asertar props del globo; si captura con otro nombre, seguir el patrón existente.)

- [ ] **Step 2: Implementar**

- Sidebar (L488-509): en cada `<li>`, si `evento.id === spotlightEvent?.id`, agregar `data-testid="feed-row-focused"` y clases de resaltado (`bg-teal-950/60 ring-1 ring-teal-500/60`); en un `useEffect` sobre `spotlightEvent`, `document.querySelector('[data-testid="feed-row-focused"]')?.scrollIntoView({ block: 'nearest' })`.
- Globo: pasar `onEventClick={(id) => { const target = (eventos ?? []).find((e) => e.id === id); if (target) setSpotlightEvent(target); }}` al `<SeismicGlobe>` de la cartelera (L391-404).
- `SeismicGlobe.tsx`: agregar la prop opcional y llamarla desde el handler de clic de puntos existente (junto a la lógica de `selectedEventId`, sin alterarla).

- [ ] **Step 3: Verificar TODO verde (incluidos los 2 RED de Task 5)**

Run: `cd dashboard && npx vitest run components/GlobeBroadcastOverlay.test.tsx && npx vitest run 2>&1 | tail -2 && cd .. && ./venv/bin/python -m pytest tests/unit -q 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 4: Commit + PR**

```bash
git add dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/SeismicGlobe.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx
git commit -m "feat(globo): evento enfocado resaltado en el sidebar y clic en el globo"
git push -u origin feat/spectronet-wall
gh pr create --title "feat(muro): cartelera SPECTRONET con regiones + foco de eventos configurable (PR-W1)" --body "Implementa PR-W1 de docs/superpowers/specs/2026-08-20-spectronet-wall-design.md: muro default Global server-side agrupado por región, tiras con etiqueta a la izquierda apiladas sin gaps, modos de foco random/latest (query param ?focus= para kiosks) y resaltado del evento enfocado en el sidebar."
```

---

## Verificación final del PR

- [ ] QA visual contra la imagen de SPECTRONET: columnas densas, encabezados de región, etiquetas a la izquierda, sin gaps dentro del grupo; el muro no parpadea al rotar slides (tiras siempre montadas).
- [ ] Probar `?focus=latest` y `?focus=random` en `/globe`; verificar persistencia del toggle tras recargar.
- [ ] Verificación por mutación: invertir `newestFirst` o el filtro de `lastId` en `event-focus.ts` y confirmar que los tests cazan ambas.
