# PR A — Helicorder: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página `/stations/[channel]` con la vista Helicorder de 24 h (paridad visual SWARM) alimentada por un endpoint de waveform decimado min/max.

**Architecture:** Un endpoint FastAPI nuevo baja 24 h de FDSN (reusando `SpectrogramService.get_waveform_data`), demeanea, decima min/max server-side y cachea. El frontend dibuja el helicorder en un canvas con toda la geometría (filas, wrap modular, colores, ticks) en una lib pura testeable, patrón `jet2-palette`/`spectrogram-scale`.

**Tech Stack:** FastAPI + ObsPy + NumPy (backend); Next.js App Router + canvas 2D + vitest (frontend); next-intl para i18n.

**Spec:** `docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md`

## Global Constraints

- Memoria: decimar ANTES de serializar; ningún array transitorio > ~70 MB (lección OOM, PR #25).
- Colores helicorder EXACTOS de SWARM: ciclo `rgb(0,0,255)`, `rgb(0,0,205)`, `rgb(0,0,155)`, `rgb(0,0,105)`; clipping en rojo `rgb(255,0,0)`; fondo blanco.
- Heurística de ticks SWARM: timeChunk ≤30 min → tick mayor cada 1 min; <180 → cada 5; <360 → cada 10; ≥360 → cada 20.
- Idioma: identificadores en inglés, comentarios en español. i18n con paridad de claves `es.json`/`en.json`.
- Tests backend: `./venv/bin/python -m pytest tests/unit/<archivo> -q --no-cov` (el venv es `venv/`, NO `.venv/`). Tests frontend: `npx vitest run <archivo>` desde `dashboard/`.
- TDD estricto: test primero, verlo fallar, implementar, verlo pasar, commit.
- Commits en conventional commits, sin atribución de IA.
- Rama de trabajo: `feat/station-detail-helicorder` desde `main`.

---

### Task 1: Decimación min/max por píxel

**Files:**
- Create: `src/services/station_waveform.py`
- Test: `tests/unit/test_station_waveform.py`

**Interfaces:**
- Produces: `decimate_minmax(data: np.ndarray, target_pairs: int) -> tuple[np.ndarray, np.ndarray]` — devuelve `(mins, maxs)`, cada uno de largo `min(target_pairs, len(data))`. Task 3 la consume.

- [ ] **Step 1: Escribir los tests que fallan**

```python
# tests/unit/test_station_waveform.py
"""Waveform de estación: decimación min/max y filtro Butterworth (paridad SWARM)."""

import numpy as np
import pytest

from src.services.station_waveform import decimate_minmax


def test_decimacion_preserva_los_extremos():
    # Un pico positivo y uno negativo enterrados en ruido NO pueden
    # desaparecer al decimar: min/max por bloque los retiene siempre.
    data = np.zeros(100_000)
    data[12_345] = 500.0
    data[67_890] = -700.0

    mins, maxs = decimate_minmax(data, 800)

    assert len(mins) == len(maxs) == 800
    assert maxs.max() == 500.0
    assert mins.min() == -700.0


def test_senal_corta_pasa_entera():
    data = np.array([1.0, -2.0, 3.0])
    mins, maxs = decimate_minmax(data, 800)
    assert np.array_equal(mins, data)
    assert np.array_equal(maxs, data)


def test_min_nunca_supera_al_max():
    rng = np.random.default_rng(42)
    data = rng.normal(size=50_000)
    mins, maxs = decimate_minmax(data, 640)
    assert np.all(mins <= maxs)
```

- [ ] **Step 2: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov`
Expected: FAIL con `ModuleNotFoundError: No module named 'src.services.station_waveform'`

- [ ] **Step 3: Implementación mínima**

```python
# src/services/station_waveform.py
"""Waveform decimado para el detalle de estación (helicorder / wave view).

La decimación min/max por bloque es la técnica estándar de los visores
sísmicos: cada par (min, max) resume un bloque de muestras, así los picos
NUNCA se pierden por submuestreo — a diferencia de un stride simple.
"""

import numpy as np


def decimate_minmax(data: np.ndarray, target_pairs: int) -> tuple[np.ndarray, np.ndarray]:
    """(mins, maxs) por bloque; si la señal es más corta que el objetivo, pasa entera."""
    signal = np.asarray(data, dtype=np.float64)
    n = len(signal)
    if n <= target_pairs:
        return signal.copy(), signal.copy()

    # Bloques casi-iguales vía índices enteros (el último absorbe el resto)
    edges = np.linspace(0, n, target_pairs + 1).astype(int)
    mins = np.minimum.reduceat(signal, edges[:-1])
    maxs = np.maximum.reduceat(signal, edges[:-1])
    return mins, maxs
```

- [ ] **Step 4: Verificar que pasa**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/station_waveform.py tests/unit/test_station_waveform.py
git commit -m "feat(estaciones): decimación min/max por bloque para waveform"
```

---

### Task 2: Butterworth bandpass paridad SWARM

**Files:**
- Modify: `src/services/station_waveform.py`
- Test: `tests/unit/test_station_waveform.py`

**Interfaces:**
- Produces: `butterworth_bandpass(data: np.ndarray, fs: float) -> np.ndarray` — orden 4, 1–10 Hz, zero-phase (`filtfilt`). Task 3 la consume cuando `filter=bp`.

- [ ] **Step 1: Agregar los tests que fallan**

```python
# agregar a tests/unit/test_station_waveform.py
from src.services.station_waveform import butterworth_bandpass


def _sine(freq_hz, fs, seconds, amp=1.0):
    t = np.arange(int(fs * seconds)) / fs
    return amp * np.sin(2 * np.pi * freq_hz * t)


def test_bandpass_conserva_la_banda_y_mata_la_deriva():
    fs = 100.0
    in_band = _sine(5.0, fs, 30.0, amp=100.0)
    drift = np.linspace(0, 10_000, int(fs * 30))  # deriva lenta fuera de banda

    out = butterworth_bandpass(in_band + drift, fs)

    core = out[int(fs * 5) : -int(fs * 5)]  # descartar transitorios de borde
    assert np.abs(core).max() == pytest.approx(100.0, rel=0.05)


def test_bandpass_es_zero_phase():
    # filtfilt no desfasa: el pico del seno filtrado coincide con el original.
    fs = 100.0
    sine = _sine(5.0, fs, 30.0, amp=100.0)
    out = butterworth_bandpass(sine, fs)
    center = slice(int(fs * 10), int(fs * 20))
    lag = np.argmax(np.correlate(out[center], sine[center], "full")) - (len(sine[center]) - 1)
    assert lag == 0
```

- [ ] **Step 2: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov`
Expected: FAIL con `ImportError: cannot import name 'butterworth_bandpass'`

- [ ] **Step 3: Implementación mínima**

```python
# agregar a src/services/station_waveform.py
from scipy.signal import butter, filtfilt

# Paridad SWARM (WaveDefaults.config): bandpass orden 4, 1-10 Hz, zeroPhaseShift
FILTER_ORDER = 4
FILTER_LOW_HZ = 1.0
FILTER_HIGH_HZ = 10.0


def butterworth_bandpass(data: np.ndarray, fs: float) -> np.ndarray:
    """Bandpass 1-10 Hz zero-phase, los parámetros exactos de SWARM."""
    high = min(FILTER_HIGH_HZ, fs / 2 * 0.99)  # canales lentos: tope en Nyquist
    sos_b, sos_a = butter(FILTER_ORDER, [FILTER_LOW_HZ, high], btype="band", fs=fs)
    return filtfilt(sos_b, sos_a, np.asarray(data, dtype=np.float64))
```

- [ ] **Step 4: Verificar que pasa**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add src/services/station_waveform.py tests/unit/test_station_waveform.py
git commit -m "feat(estaciones): Butterworth 1-10 Hz zero-phase paridad SWARM"
```

---

### Task 3: Endpoint `GET /stations/{channel}/waveform`

**Files:**
- Modify: `src/main.py` (junto a los endpoints de `/spectrograms/`, ~línea 2200)
- Test: `tests/unit/test_station_waveform.py`

**Interfaces:**
- Consumes: `decimate_minmax`, `butterworth_bandpass` (Tasks 1-2); `get_spectrogram_service().get_waveform_data(network, station, location, channel, duration_hours)` (existente, devuelve Stream ObsPy o None); `cache` y `settings.spectrogram_cache_ttl_seconds` (patrón de `main.py:2218`).
- Produces: respuesta JSON `{channel, sampling_rate, starttime, endtime, mins: [...], maxs: [...]}` que Task 5 consume. El path param `channel` es el SCNL completo `NET.STA.LOC.CHA` (LOC puede ser vacío: `IU.MAJO..BHZ`).

- [ ] **Step 1: Escribir el test que falla** (la lógica pura de armado de respuesta se separa en `station_waveform.py` para testear sin app)

```python
# agregar a tests/unit/test_station_waveform.py
from obspy import Trace

from src.services.station_waveform import build_waveform_response


def test_build_waveform_response_demeanea_y_decima():
    fs = 100.0
    data = 1000.0 + _sine(5.0, fs, 120.0, amp=50.0)  # offset DC de 1000
    tr = Trace(
        data=data,
        header={"network": "IU", "station": "MAJO", "channel": "BHZ", "sampling_rate": fs},
    )

    resp = build_waveform_response(tr, "IU.MAJO..BHZ", target_pairs=400, apply_filter=False)

    assert resp["channel"] == "IU.MAJO..BHZ"
    assert resp["sampling_rate"] == fs
    assert len(resp["mins"]) == len(resp["maxs"]) == 400
    # El demean sacó el offset: la señal queda centrada en ~0
    assert abs(np.mean(resp["mins"]) + np.mean(resp["maxs"])) < 5.0


def test_build_waveform_response_con_filtro_mata_offset_y_deriva():
    fs = 100.0
    data = np.linspace(0, 5000, int(fs * 120)) + _sine(5.0, fs, 120.0, amp=50.0)
    tr = Trace(data=data, header={"network": "IU", "station": "MAJO", "channel": "BHZ", "sampling_rate": fs})

    resp = build_waveform_response(tr, "IU.MAJO..BHZ", target_pairs=400, apply_filter=True)

    assert max(abs(min(resp["mins"])), abs(max(resp["maxs"]))) < 100.0
```

- [ ] **Step 2: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov`
Expected: FAIL con `ImportError: cannot import name 'build_waveform_response'`

- [ ] **Step 3: Implementar la lógica pura + el endpoint**

```python
# agregar a src/services/station_waveform.py
from obspy import Trace


def build_waveform_response(
    trace: Trace, channel_id: str, target_pairs: int, apply_filter: bool
) -> dict:
    """Arma la respuesta del endpoint: demean, filtro opcional, decimación."""
    fs = float(trace.stats.sampling_rate)
    signal = np.asarray(trace.data, dtype=np.float64)
    signal = signal - signal.mean()
    if apply_filter:
        signal = butterworth_bandpass(signal, fs)
    mins, maxs = decimate_minmax(signal, target_pairs)
    return {
        "channel": channel_id,
        "sampling_rate": fs,
        "starttime": str(trace.stats.starttime),
        "endtime": str(trace.stats.endtime),
        "mins": np.round(mins, 1).tolist(),
        "maxs": np.round(maxs, 1).tolist(),
    }
```

```python
# agregar a src/main.py, después del endpoint /spectrograms/{channel}/history
@app.get("/stations/{channel}/waveform", tags=["stations"])
async def get_station_waveform(
    channel: str,
    minutes: int = Query(1440, ge=1, le=1440, description="Ventana hacia atrás"),
    points: int = Query(38400, ge=100, le=50000, description="Pares min/max a devolver"),
    filter: str = Query("none", pattern="^(none|bp)$", description="bp = Butterworth 1-10 Hz"),
) -> dict:
    """Forma de onda decimada min/max para el detalle de estación (helicorder).

    `channel` es el SCNL completo, ej. "IU.MAJO.00.BHZ" (location puede ser vacío).
    """
    from src.services.station_waveform import build_waveform_response

    parts = channel.split(".")
    if len(parts) != 4:
        raise HTTPException(status_code=422, detail="channel debe ser NET.STA.LOC.CHA")
    net, sta, loc, cha = parts

    ttl = settings.spectrogram_cache_ttl_seconds
    cache_key = f"waveform:{channel}:{minutes}:{points}:{filter}"
    if ttl > 0:
        cached = cache.get(cache_key)
        if cached is not None:
            return cached

    service = get_spectrogram_service()
    stream = await service.get_waveform_data(
        network=net, station=sta, location=loc or "*", channel=cha,
        duration_hours=max(1, minutes // 60),
    )
    if stream is None or len(stream) == 0:
        raise HTTPException(status_code=404, detail=f"Sin datos FDSN para {channel}")

    # Un stream puede venir partido por gaps: usar el trace más largo
    trace = max(stream, key=lambda tr: tr.stats.npts)
    result = build_waveform_response(trace, channel, points, apply_filter=(filter == "bp"))
    if ttl > 0:
        cache.set(cache_key, result, ttl)
    return result
```

Nota: verificar los nombres reales de `cache.set` (buscar `cache.set` en `main.py` y copiar la firma exacta que usa el endpoint de espectrogramas; si el cache guarda con `(key, value, ttl)` u otro orden, seguir el patrón existente).

- [ ] **Step 4: Verificar que pasa + suite completa**

Run: `./venv/bin/python -m pytest tests/unit/test_station_waveform.py -q --no-cov && ./venv/bin/python -m pytest tests/unit -q 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 5: Commit**

```bash
git add src/services/station_waveform.py src/main.py tests/unit/test_station_waveform.py
git commit -m "feat(estaciones): endpoint de waveform decimado min/max con cache"
```

---

### Task 4: Lib pura de layout del helicorder

**Files:**
- Create: `dashboard/lib/helicorder-layout.ts`
- Test: `dashboard/lib/helicorder-layout.test.ts`

**Interfaces:**
- Produces (Task 5 consume TODAS):
  - `HELICORDER_BLUES: readonly string[]` — los 4 azules SWARM.
  - `rowCount(totalMinutes: number, timeChunkMinutes: number): number`
  - `rowForOffset(offsetSec: number, timeChunkSec: number): number` — fila 0 = la más vieja.
  - `xFractionForOffset(offsetSec: number, timeChunkSec: number): number` — wrap modular, en [0,1).
  - `rowColor(rowIndex: number): string` — cicla los 4 azules.
  - `majorTickMinutes(timeChunkMinutes: number): number` — heurística SWARM.
  - `clampToClip(value: number, clipValue: number): { v: number; clipped: boolean }`

- [ ] **Step 1: Escribir los tests que fallan**

```typescript
// dashboard/lib/helicorder-layout.test.ts
import { describe, expect, it } from 'vitest';
import {
  HELICORDER_BLUES,
  clampToClip,
  majorTickMinutes,
  rowColor,
  rowCount,
  rowForOffset,
  xFractionForOffset,
} from './helicorder-layout';

describe('geometría de filas', () => {
  it('24h en franjas de 30min son 48 filas', () => {
    expect(rowCount(1440, 30)).toBe(48);
  });

  it('el offset mapea a fila y posición con wrap modular', () => {
    // A los 45 min con franjas de 30: fila 1, mitad de la fila.
    expect(rowForOffset(45 * 60, 30 * 60)).toBe(1);
    expect(xFractionForOffset(45 * 60, 30 * 60)).toBeCloseTo(0.5);
    // Justo al empezar una franja: x vuelve a 0 (el wrap de SWARM).
    expect(xFractionForOffset(60 * 60, 30 * 60)).toBeCloseTo(0);
  });
});

describe('colores SWARM', () => {
  it('usa los 4 azules exactos del HelicorderRenderer y cicla', () => {
    expect(HELICORDER_BLUES).toEqual([
      'rgb(0,0,255)',
      'rgb(0,0,205)',
      'rgb(0,0,155)',
      'rgb(0,0,105)',
    ]);
    expect(rowColor(0)).toBe('rgb(0,0,255)');
    expect(rowColor(5)).toBe('rgb(0,0,205)');
  });
});

describe('ticks por densidad (heurística SWARM)', () => {
  it('escala con el tamaño de franja', () => {
    expect(majorTickMinutes(15)).toBe(1);
    expect(majorTickMinutes(30)).toBe(1);
    expect(majorTickMinutes(60)).toBe(5);
    expect(majorTickMinutes(240)).toBe(10);
    expect(majorTickMinutes(720)).toBe(20);
  });
});

describe('clipping', () => {
  it('clampea y marca el clip como SWARM', () => {
    expect(clampToClip(50, 100)).toEqual({ v: 50, clipped: false });
    expect(clampToClip(250, 100)).toEqual({ v: 100, clipped: true });
    expect(clampToClip(-250, 100)).toEqual({ v: -100, clipped: true });
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run lib/helicorder-layout.test.ts`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementación mínima**

```typescript
// dashboard/lib/helicorder-layout.ts
/**
 * Geometría del helicorder con paridad SWARM (HelicorderRenderer.java, CC0):
 * filas de timeChunk segundos, eje X = wrap modular del tiempo, 4 azules
 * cíclicos por fila y clipping clampado. Lib pura para testear sin canvas.
 */

export const HELICORDER_BLUES = [
  'rgb(0,0,255)',
  'rgb(0,0,205)',
  'rgb(0,0,155)',
  'rgb(0,0,105)',
] as const;

export function rowCount(totalMinutes: number, timeChunkMinutes: number): number {
  return Math.ceil(totalMinutes / timeChunkMinutes);
}

export function rowForOffset(offsetSec: number, timeChunkSec: number): number {
  return Math.floor(offsetSec / timeChunkSec);
}

export function xFractionForOffset(offsetSec: number, timeChunkSec: number): number {
  return (offsetSec % timeChunkSec) / timeChunkSec;
}

export function rowColor(rowIndex: number): string {
  return HELICORDER_BLUES[rowIndex % HELICORDER_BLUES.length];
}

/** Heurística de densidad de ticks de SWARM (StandardDecorator). */
export function majorTickMinutes(timeChunkMinutes: number): number {
  if (timeChunkMinutes <= 30) return 1;
  if (timeChunkMinutes < 180) return 5;
  if (timeChunkMinutes < 360) return 10;
  return 20;
}

export function clampToClip(value: number, clipValue: number): { v: number; clipped: boolean } {
  if (value > clipValue) return { v: clipValue, clipped: true };
  if (value < -clipValue) return { v: -clipValue, clipped: true };
  return { v: value, clipped: false };
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `cd dashboard && npx vitest run lib/helicorder-layout.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/helicorder-layout.ts dashboard/lib/helicorder-layout.test.ts
git commit -m "feat(estaciones): lib pura de geometría del helicorder (paridad SWARM)"
```

---

### Task 5: Componente HelicorderCanvas

**Files:**
- Create: `dashboard/components/HelicorderCanvas.tsx`
- Test: `dashboard/components/HelicorderCanvas.test.tsx`

**Interfaces:**
- Consumes: Task 4 completa; endpoint de Task 3 (`GET ${API_BASE}/stations/{channel}/waveform?minutes=1440&points=N`).
- Produces: `<HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />` — Task 6 lo monta.

- [ ] **Step 1: Escribir el test que falla** (patrón de mocks del proyecto: `vi.stubGlobal('fetch', ...)`; el jsdom no rasteriza — se testea que pida el endpoint correcto y pinte sin tirar; referencia: `GlobeBroadcastOverlay.test.tsx`)

```tsx
// dashboard/components/HelicorderCanvas.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HelicorderCanvas } from './HelicorderCanvas';

const waveform = {
  channel: 'IU.MAJO..BHZ',
  sampling_rate: 100,
  starttime: '2026-08-20T00:00:00Z',
  endtime: '2026-08-21T00:00:00Z',
  mins: Array.from({ length: 1000 }, (_, i) => -Math.abs(Math.sin(i / 50)) * 100),
  maxs: Array.from({ length: 1000 }, (_, i) => Math.abs(Math.sin(i / 50)) * 100),
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => waveform }))
  );
});

describe('HelicorderCanvas', () => {
  it('pide el waveform de 24h del canal y renderiza el canvas', async () => {
    render(<HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('/stations/IU.MAJO..BHZ/waveform?minutes=1440')
      );
    });
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('muestra el estado de error si el fetch falla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    render(<HelicorderCanvas channel="IU.MAJO..BHZ" timeChunkMinutes={30} width={900} height={620} />);
    await waitFor(() => {
      expect(screen.getByTestId('helicorder-error')).toBeTruthy();
    });
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run components/HelicorderCanvas.test.tsx`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementación**

```tsx
// dashboard/components/HelicorderCanvas.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import {
  clampToClip,
  majorTickMinutes,
  rowColor,
  rowCount,
} from '@/lib/helicorder-layout';

interface HelicorderCanvasProps {
  channel: string; // SCNL completo, ej. "IU.MAJO..BHZ"
  timeChunkMinutes: number;
  width: number;
  height: number;
}

interface WaveformResponse {
  channel: string;
  sampling_rate: number;
  starttime: string;
  endtime: string;
  mins: number[];
  maxs: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const MARGIN_LEFT = 56; // etiquetas de hora local
const MARGIN_RIGHT = 56; // etiquetas UTC

export function HelicorderCanvas({ channel, timeChunkMinutes, width, height }: HelicorderCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    const draw = (wf: WaveformResponse) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      // Fondo blanco, como el helicorder de SWARM
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      const rows = rowCount(1440, timeChunkMinutes);
      const rowH = height / rows;
      const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
      const pairs = wf.mins.length;
      const pairsPerRow = Math.max(1, Math.floor(pairs / rows));

      // clipValue automático: percentil 99.9 del |valor| del día — el 0.1%
      // más violento se clampea y pinta rojo, como el clipping de SWARM.
      const absAll = wf.mins.map(Math.abs).concat(wf.maxs.map(Math.abs)).sort((a, b) => a - b);
      const clipValue = absAll[Math.min(absAll.length - 1, Math.floor(absAll.length * 0.999))] || 1;

      const startMs = Date.parse(wf.starttime);
      const tickEvery = majorTickMinutes(timeChunkMinutes);

      for (let r = 0; r < rows; r++) {
        const centerY = r * rowH + rowH / 2;
        const rowStart = r * pairsPerRow;
        const rowPairs = wf.mins.slice(rowStart, rowStart + pairsPerRow);
        const rowMaxs = wf.maxs.slice(rowStart, rowStart + pairsPerRow);

        // Bias POR FILA (paridad SWARM): el offset de una fila no arrastra a las demás
        const bias =
          rowPairs.reduce((s, v, i) => s + (v + rowMaxs[i]) / 2, 0) / Math.max(1, rowPairs.length);

        // Ticks mayores de la fila
        ctx.strokeStyle = '#dddddd';
        for (let m = 0; m < timeChunkMinutes; m += tickEvery) {
          const x = MARGIN_LEFT + (m / timeChunkMinutes) * plotW;
          ctx.beginPath();
          ctx.moveTo(x, r * rowH);
          ctx.lineTo(x, (r + 1) * rowH);
          ctx.stroke();
        }

        // Etiquetas: hora local a la izquierda, UTC a la derecha
        const rowDate = new Date(startMs + r * timeChunkMinutes * 60_000);
        ctx.fillStyle = '#333333';
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(
          rowDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          4,
          centerY
        );
        ctx.textAlign = 'right';
        ctx.fillText(
          rowDate.toISOString().slice(11, 16) + 'Z',
          width - 4,
          centerY
        );
        ctx.textAlign = 'left';

        // Trazas min/max de la fila con el azul cíclico; clip en rojo
        const base = rowColor(r);
        const scale = (rowH / 2 - 1) / clipValue;
        for (let i = 0; i < rowPairs.length; i++) {
          const x = MARGIN_LEFT + (i / rowPairs.length) * plotW;
          const lo = clampToClip(rowPairs[i] - bias, clipValue);
          const hi = clampToClip(rowMaxs[i] - bias, clipValue);
          ctx.strokeStyle = lo.clipped || hi.clipped ? 'rgb(255,0,0)' : base;
          ctx.beginPath();
          ctx.moveTo(x, centerY - hi.v * scale);
          ctx.lineTo(x, centerY - lo.v * scale);
          ctx.stroke();
        }
      }
    };

    const load = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/stations/${channel}/waveform?minutes=1440&points=${rowCount(1440, timeChunkMinutes) * 800}`
        );
        if (!res.ok) throw new Error(String(res.status));
        const wf: WaveformResponse = await res.json();
        if (cancelled) return;
        draw(wf);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    setStatus('loading');
    load();
    return () => {
      cancelled = true;
    };
  }, [channel, timeChunkMinutes, width, height]);

  if (status === 'error') {
    return (
      <div data-testid="helicorder-error" className="rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300">
        {channel}
      </div>
    );
  }

  return (
    <div className="rounded bg-white" style={{ width, height }}>
      <canvas data-testid="helicorder-canvas" ref={canvasRef} width={width} height={height} className="block" />
    </div>
  );
}
```

Nota: `points` pedido = filas × 800 (48 × 800 = 38.400, el default del endpoint) — ~800 pares por fila, 1 por píxel útil.

- [ ] **Step 4: Verificar que pasa + suite del dashboard**

Run: `cd dashboard && npx vitest run components/HelicorderCanvas.test.tsx && npx vitest run 2>&1 | tail -2`
Expected: PASS todo

- [ ] **Step 5: Commit**

```bash
git add dashboard/components/HelicorderCanvas.tsx dashboard/components/HelicorderCanvas.test.tsx
git commit -m "feat(estaciones): canvas de helicorder 24h con paridad visual SWARM"
```

---

### Task 6: Página `/stations/[channel]` + navegación desde el muro + i18n

**Files:**
- Create: `dashboard/app/(app)/stations/[channel]/page.tsx`
- Modify: `dashboard/components/SpectrogramViewReal.tsx` (link a la página cuando hay metadata de estación)
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json` (claves nuevas con paridad)
- Test: `dashboard/app/(app)/stations/station-page.test.tsx`

**Interfaces:**
- Consumes: `<HelicorderCanvas>` (Task 5).
- Produces: ruta `/stations/{SCNL}` navegable; pestañas Espectrograma/Onda/RSAM deshabilitadas con etiqueta "próximamente" (las habilitan los PRs B-D).

- [ ] **Step 1: Escribir el test que falla** (seguir el patrón de tests de página existente en `dashboard/app/(app)/explore/explore-area.test.tsx`: mock de next-intl y next/navigation con referencias ESTABLES — lección de memoria: un mock de useRouter con identidad inestable cuelga vitest)

```tsx
// dashboard/app/(app)/stations/station-page.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import StationPage from './[channel]/page';

const router = { push: vi.fn(), replace: vi.fn(), back: vi.fn() };
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  useParams: () => ({ channel: 'IU.MAJO..BHZ' }),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ dateTime: () => '' }),
}));
vi.mock('@/components/HelicorderCanvas', () => ({
  HelicorderCanvas: () => <div data-testid="helicorder-canvas" />,
}));

describe('StationPage', () => {
  it('muestra el canal y la pestaña Helicorder activa', () => {
    render(<StationPage />);
    expect(screen.getByText('IU.MAJO..BHZ')).toBeTruthy();
    expect(screen.getByTestId('helicorder-canvas')).toBeTruthy();
  });

  it('las pestañas futuras están deshabilitadas', () => {
    render(<StationPage />);
    expect(screen.getByRole('tab', { name: /spectrogram/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('tab', { name: /rsam/i })).toHaveProperty('disabled', true);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run app/\(app\)/stations/station-page.test.tsx`
Expected: FAIL — página inexistente

- [ ] **Step 3: Implementar la página, el link del muro y las claves i18n**

```tsx
// dashboard/app/(app)/stations/[channel]/page.tsx
'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { HelicorderCanvas } from '@/components/HelicorderCanvas';

const TIME_CHUNKS = [15, 30, 60] as const;

export default function StationPage() {
  const params = useParams<{ channel: string }>();
  const channel = decodeURIComponent(params.channel);
  const t = useTranslations('station');
  const [timeChunk, setTimeChunk] = useState<number>(30);

  // Pestañas futuras (PRs B-D): deshabilitadas pero visibles, para que la
  // estructura de la página no cambie cuando se habiliten.
  const tabs = [
    { id: 'helicorder', enabled: true },
    { id: 'spectrogram', enabled: false },
    { id: 'wave', enabled: false },
    { id: 'rsam', enabled: false },
  ] as const;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-xl font-bold text-white">{t('title')}</h1>
        <span className="font-mono text-sm text-gray-400">{channel}</span>
      </div>

      <div role="tablist" className="mb-4 flex gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            disabled={!tab.enabled}
            className={`rounded px-3 py-1 text-sm ${
              tab.enabled ? 'bg-teal-700 text-white' : 'bg-gray-800 text-gray-500'
            }`}
          >
            {t(`tabs.${tab.id}`)}
            {!tab.enabled && ` (${t('comingSoon')})`}
          </button>
        ))}
      </div>

      <div className="mb-3 flex items-center gap-2 text-sm text-gray-300">
        <span>{t('timeChunk')}</span>
        {TIME_CHUNKS.map((m) => (
          <button
            key={m}
            onClick={() => setTimeChunk(m)}
            className={`rounded px-2 py-0.5 ${m === timeChunk ? 'bg-teal-700 text-white' : 'bg-gray-800'}`}
          >
            {m}m
          </button>
        ))}
      </div>

      <HelicorderCanvas channel={channel} timeChunkMinutes={timeChunk} width={960} height={640} />
    </div>
  );
}
```

En `SpectrogramViewReal.tsx`: cuando `metadata` traiga `network`/`station`/`channel`, envolver la imagen con `next/link` hacia `` `/stations/${encodeURIComponent(`${metadata.network}.${metadata.station}..${metadata.channel}`)}` `` (leer el componente antes de editar y respetar su estructura actual; el location se omite porque el metadata de la imagen estática no lo trae y el endpoint lo resuelve con `*`).

Claves i18n (mismas en `es.json` y `en.json`, traducidas):

```json
"station": {
  "title": "Detalle de estación",
  "timeChunk": "Franja por fila",
  "comingSoon": "próximamente",
  "tabs": {
    "helicorder": "Helicorder",
    "spectrogram": "Espectrograma",
    "wave": "Onda + Espectro",
    "rsam": "RSAM"
  }
}
```

- [ ] **Step 4: Verificar que pasa + suites completas**

Run: `cd dashboard && npx vitest run 2>&1 | tail -2 && cd .. && ./venv/bin/python -m pytest tests/unit -q 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 5: Commit + PR**

```bash
git add dashboard/app/\(app\)/stations dashboard/components/SpectrogramViewReal.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(estaciones): página /stations/[channel] con pestañas y helicorder"
git push -u origin feat/station-detail-helicorder
gh pr create --title "feat(estaciones): detalle de estación con helicorder 24h (PR A)" --body "Primera pestaña del detalle de estación según docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md: endpoint de waveform decimado min/max + helicorder con paridad visual SWARM (4 azules, clipping rojo, bias por fila, ticks por densidad). Pestañas Espectrograma/Onda/RSAM llegan en PRs B-D."
```

---

## Verificación final del PR

- [ ] QA visual: levantar stack local (`uvicorn` + `next dev --port 3008`), navegar a `/stations/IU.MAJO..BHZ` y verificar contra la guía de SWARM: fondo blanco, filas azules alternadas, hora local izquierda / UTC derecha, clipping rojo solo en picos.
- [ ] Verificación por mutación: invertir el ciclo de colores o romper el wrap modular en `helicorder-layout.ts` y confirmar que los tests lo cazan.
