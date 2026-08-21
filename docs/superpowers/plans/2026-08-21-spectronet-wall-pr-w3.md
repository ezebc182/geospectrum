# PR-W3 — Métricas por canal (RSAM · FI · pico dB · eventos/h · latencia): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El ingestor calcula métricas de dominio por canal (RSAM, frecuencia dominante, Frequency Index, pico dB, eventos/hora) y las distribuye vía Redis; el dashboard las muestra como fila completa en las tarjetas de `/spectrograms-live` y como banda compacta en las tiras del muro cuando `showMetrics` está activo. Además: el armador expone **todas las subestaciones** del catálogo (no solo la ganadora por ciudad) con buscador y distancia a la ciudad, estilo SWARM; y **toda hora visible en la app pasa a UTC explícito**.

**Architecture:** Las métricas se derivan EXCLUSIVAMENTE de datos que el ingestor ya tiene en mano (buffer de 120 s y columna espectral recién calculada) — cero recomputación server-side (restricción OOM del PR #25). El ingestor publica cada métrica en el canal pub/sub `metrics:{SCNL}` y escribe un snapshot key `metrics:latest:{SCNL}` con TTL 60 s; la API lo sirve con `GET /stations/{channel}/metrics` (singular, spec) y `GET /stations/metrics?channel=...` (batch). El frontend usa **polling ligero** (SWR cada 15 s, un request batch por contenedor) — NO un WS nuevo: el muro monta ~74 tiras y un WS por tira sería una tormenta de conexiones.

**Tech Stack:** Python 3.12 (numpy, ObsPy, redis.asyncio, FastAPI), TypeScript/Next 15 (SWR, vitest), Redis 7, i18n next-intl ES/EN.

**Spec:** `docs/superpowers/specs/2026-08-20-spectronet-wall-design.md` §3 (líneas 70-85). El módulo `swarm_rsam.py` se adelanta del PR D de `docs/superpowers/specs/2026-08-20-station-detail-swarm-design.md` (líneas 32-35) — mantener la firma compatible con ese futuro endpoint `/stations/{channel}/rsam`.

## Global Constraints

- **OOM (PR #25)**: nada de recomputar espectros server-side; ningún array transitorio > ~70 MB. Las métricas salen del buffer del ingestor y de la columna ya calculada.
- **Paridad SWARM**: RSAM = media móvil de |señal demeaned| por período **600 s** (`RsamDefaults.config`); evento si `v >= threshold && v >= v[i-2]*ratio` con **threshold=50, ratio=1.3**.
- **FI**: `log10(mean_dB(5–15 Hz) / mean_dB(1–5 Hz))` — negativo = LP/fluidos, positivo = VT/fractura.
- **Pico dB** comparable entre estaciones por la escala fija **20–120** (`swarm_spectra.py:22-23`, `spectrogram-scale.ts:13-14`).
- **Canales Redis**: pub/sub `metrics:{SCNL}` (SCNL de 4 partes, ej. `IU.MAJO.00.BHZ`, igual que `spec:{SCNL}`); snapshot key `metrics:latest:{SCNL}` TTL 60 s.
- **Payload de métricas** (contrato único, `null` = no disponible):
  `{"channel": "IU.MAJO.00.BHZ", "endtime": "2026-08-21T14:32:10.000000Z", "rsam": 123.4, "freq_hz": 2.4, "fi": -0.12, "peak_db": 87.3, "events_hour": 3}`
- Identificadores en inglés, comentarios en español. i18n ES/EN con paridad de claves.
- TDD estricto; **verificación por mutación** en los detectores (countEvents), en el Frequency Index y en la distancia haversine.
- Tests backend: `./venv/bin/python -m pytest <ruta> -v --no-cov` (venv en `venv/`, NO `.venv/`; Docker arriba para testcontainers). Frontend: `cd dashboard && npx vitest run` y SIEMPRE `npx tsc --noEmit` (vitest no chequea tipos, `next build` sí).
- La publicación de métricas es best-effort: un fallo de métricas JAMÁS debe frenar la ingesta de columnas.
- **UTC en TODA hora visible** (Tasks 10-11): el estándar del dominio sísmico es UTC y toda fuente (USGS, EMSC, ObsPy `endtime`) ya llega en UTC. Ninguna hora se renderiza en la zona del navegador; toda etiqueta de hora lleva el sufijo `UTC` visible.
- **Catálogo completo de subestaciones** (Task 12): `LIVE_CANDIDATES_BY_CITY` ingesta 75 canales pero `/spectrograms/live-channels` expone solo la ganadora de cada una de las 27 ciudades. Las otras 48 son subestaciones reales y ya ingestadas — el armador debe poder elegirlas.

---

### Task 1: Módulo `swarm_rsam.py` (RSAM + detector de eventos, lógica pura)

**Files:**
- Create: `src/services/swarm_rsam.py`
- Test: `tests/unit/test_swarm_rsam.py`

**Interfaces:**
- Consumes: nada (lógica pura, numpy).
- Produces: `rsam_sample(data: np.ndarray) -> float`; `class RsamAccumulator` con `add(value: float, at: datetime) -> None`, `rsam(now: datetime, period_s: int = 600) -> float | None`, `events_last_hour(now: datetime, threshold: float = 50.0, ratio: float = 1.3) -> int`; constantes `RSAM_PERIOD_SECONDS = 600`, `EVENTS_WINDOW_SECONDS = 3600`, `EVENT_THRESHOLD = 50.0`, `EVENT_RATIO = 1.3`. Task 4 los consume desde el ingestor.

- [ ] **Step 1: Write the failing tests**

```python
# tests/unit/test_swarm_rsam.py
"""Tests de swarm_rsam con señales sintéticas (spec station-detail línea 71):
media conocida, eventos fabricados que el detector DEBE contar y subidas
graduales que NO."""

from datetime import datetime, timedelta, timezone

import numpy as np

from src.services.swarm_rsam import (
    EVENT_RATIO,
    EVENT_THRESHOLD,
    RsamAccumulator,
    rsam_sample,
)

T0 = datetime(2026, 8, 21, 12, 0, 0, tzinfo=timezone.utc)


def _fill(acc: RsamAccumulator, values: list[float], step_s: int = 4) -> datetime:
    """Carga una serie con un tick cada step_s segundos; devuelve el now final."""
    now = T0
    for v in values:
        acc.add(v, now)
        now += timedelta(seconds=step_s)
    return now


def test_rsam_sample_es_la_media_del_valor_absoluto_demeaned():
    # señal 10 ± 4 alternante: demean deja ±4, media de |±4| = 4
    data = np.array([14.0, 6.0, 14.0, 6.0])
    assert rsam_sample(data) == 4.0


def test_rsam_sample_con_ventana_vacia_es_cero():
    assert rsam_sample(np.array([])) == 0.0


def test_rsam_promedia_solo_el_periodo_pedido():
    acc = RsamAccumulator()
    # 200 muestras viejas de 100.0 y 150 recientes (600 s a 4 s/tick) de 10.0
    now = _fill(acc, [100.0] * 200 + [10.0] * 150)
    assert acc.rsam(now, period_s=600) == 10.0


def test_rsam_sin_muestras_devuelve_none():
    acc = RsamAccumulator()
    assert acc.rsam(T0) is None


def test_detector_cuenta_un_pico_que_cumple_threshold_y_ratio():
    acc = RsamAccumulator()
    # base 40 (bajo threshold), pico 80: 80 >= 50 y 80 >= 40*1.3
    now = _fill(acc, [40.0, 40.0, 40.0, 80.0, 80.0, 40.0, 40.0])
    assert acc.events_last_hour(now) == 1  # la corrida contigua cuenta UNO


def test_detector_ignora_subida_gradual_que_no_cumple_ratio():
    acc = RsamAccumulator()
    # sube de a 5%: siempre v < v[i-2]*1.3 aunque supere el threshold
    values = [40.0 * (1.05**i) for i in range(20)]
    now = _fill(acc, values)
    assert acc.events_last_hour(now) == 0


def test_detector_ignora_picos_bajo_el_threshold():
    acc = RsamAccumulator()
    # 10 -> 30 cumple ratio (30 >= 13) pero no threshold (30 < 50)
    now = _fill(acc, [10.0, 10.0, 30.0, 30.0, 10.0])
    assert acc.events_last_hour(now) == 0


def test_detector_cuenta_dos_eventos_separados():
    acc = RsamAccumulator()
    base, pico = [40.0] * 5, [90.0] * 3
    now = _fill(acc, base + pico + base + pico + base)
    assert acc.events_last_hour(now) == 2


def test_las_muestras_fuera_de_la_hora_expiran():
    acc = RsamAccumulator()
    acc.add(500.0, T0)
    now = T0 + timedelta(seconds=3700)
    acc.add(10.0, now)
    assert acc.rsam(now, period_s=600) == 10.0
    assert acc.events_last_hour(now) == 0
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/unit/test_swarm_rsam.py -v --no-cov`
Expected: FAIL con `ModuleNotFoundError: No module named 'src.services.swarm_rsam'`

- [ ] **Step 3: Write the implementation**

```python
# src/services/swarm_rsam.py
"""
RSAM (Real-time Seismic Amplitude Measurement) con paridad SWARM.

Adelantado del PR D del detalle de estación: el PR-W3 lo usa para las
métricas por canal del muro. Lógica pura sin threads ni Redis — el
ingestor la alimenta con una muestra por tick y decide cuándo publicar.

Paridad SWARM (RsamDefaults.config / RSAMData.countEvents, CC0):
- RSAM = media móvil de |señal demeaned| por período (default 600 s).
- Evento: v >= threshold Y v >= v[i-2] * ratio (threshold=50, ratio=1.3).
  Una corrida contigua de ticks que cumplen la condición cuenta UN evento
  (contar cada tick inflaría eventos/hora hasta volverla inútil).
"""

from __future__ import annotations

from collections import deque
from datetime import datetime, timedelta

import numpy as np

RSAM_PERIOD_SECONDS = 600
EVENTS_WINDOW_SECONDS = 3600
EVENT_THRESHOLD = 50.0
EVENT_RATIO = 1.3


def rsam_sample(data: np.ndarray) -> float:
    """Media de |señal demeaned| de una ventana corta (un tick del ingestor)."""
    if data.size == 0:
        return 0.0
    centered = data.astype(np.float64) - float(np.mean(data))
    return float(np.mean(np.abs(centered)))


class RsamAccumulator:
    """Serie rodante de muestras RSAM de un canal (una muestra por tick).

    Retiene solo la última hora (ventana de eventos/hora): a 1 muestra
    cada 4 s son ≤900 floats por canal — memoria despreciable.
    """

    def __init__(self, max_window_s: int = EVENTS_WINDOW_SECONDS) -> None:
        self._max_window_s = max_window_s
        self._samples: deque[tuple[datetime, float]] = deque()

    def add(self, value: float, at: datetime) -> None:
        self._samples.append((at, value))
        cutoff = at - timedelta(seconds=self._max_window_s)
        while self._samples and self._samples[0][0] < cutoff:
            self._samples.popleft()

    def rsam(self, now: datetime, period_s: int = RSAM_PERIOD_SECONDS) -> float | None:
        cutoff = now - timedelta(seconds=period_s)
        values = [v for t, v in self._samples if t >= cutoff]
        if not values:
            return None
        return float(np.mean(values))

    def events_last_hour(
        self,
        now: datetime,
        threshold: float = EVENT_THRESHOLD,
        ratio: float = EVENT_RATIO,
    ) -> int:
        cutoff = now - timedelta(seconds=EVENTS_WINDOW_SECONDS)
        values = [v for t, v in self._samples if t >= cutoff]
        events = 0
        in_event = False
        for i in range(2, len(values)):
            hit = values[i] >= threshold and values[i] >= values[i - 2] * ratio
            if hit and not in_event:
                events += 1
            in_event = hit
        return events
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python -m pytest tests/unit/test_swarm_rsam.py -v --no-cov`
Expected: 9 PASS

- [ ] **Step 5: Verificación por mutación del detector (obligatoria, spec línea 127)**

Aplicar cada mutación POR SEPARADO, correr los tests, verificar que AL MENOS UNO falla, revertir:
1. `values[i - 2]` → `values[i - 1]` — debe fallar `test_detector_ignora_subida_gradual_que_no_cumple_ratio` o `test_detector_cuenta_un_pico...`.
2. `and` → `or` en `hit` — debe fallar `test_detector_ignora_picos_bajo_el_threshold`.
3. Eliminar `if hit and not in_event` y contar cada `hit` — debe fallar `test_detector_cuenta_un_pico_que_cumple_threshold_y_ratio` (contaría 2).
Si alguna mutación sobrevive, agregar el test que la cace antes de seguir.

- [ ] **Step 6: Commit**

```bash
git add tests/unit/test_swarm_rsam.py src/services/swarm_rsam.py
git commit -m "feat(metricas): swarm_rsam con paridad SWARM (RSAM 600s + countEvents)"
```

---

### Task 2: Métricas espectrales en `swarm_spectra.py` (frecuencia dominante, pico dB, FI)

**Files:**
- Modify: `src/services/swarm_spectra.py` (agregar al final; NO tocar las funciones existentes)
- Test: `tests/unit/test_swarm_spectra.py` (agregar tests al archivo existente)

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `dominant_frequency_hz(freqs, power_db) -> float | None`; `peak_db(power_db) -> float | None`; `frequency_index(freqs, power_db) -> float | None`; constantes `FI_LOW_BAND_HZ = (1.0, 5.0)`, `FI_HIGH_BAND_HZ = (5.0, 15.0)`. Aceptan listas o ndarrays (la columna publicada trae listas). Task 4 las consume.

- [ ] **Step 1: Write the failing tests** (agregar a `tests/unit/test_swarm_spectra.py`)

```python
# --- métricas espectrales del PR-W3 (agregar imports arriba del archivo) ---
from src.services.swarm_spectra import (
    dominant_frequency_hz,
    frequency_index,
    peak_db,
)


def test_dominant_frequency_es_el_bin_de_mayor_potencia():
    freqs = [0.0, 1.0, 2.0, 3.0]
    power = [10.0, 50.0, 90.0, 40.0]
    assert dominant_frequency_hz(freqs, power) == 2.0


def test_dominant_frequency_con_columna_vacia_es_none():
    assert dominant_frequency_hz([], []) is None


def test_peak_db_es_el_maximo_de_la_columna():
    assert peak_db([30.0, 87.3, 45.0]) == 87.3
    assert peak_db([]) is None


def test_fi_positivo_cuando_domina_la_banda_alta():
    # banda baja (1-5) media 40 dB, banda alta (5-15) media 80 dB
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [40.0, 40.0, 80.0, 80.0]
    result = frequency_index(freqs, power)
    assert result is not None
    assert abs(result - np.log10(80.0 / 40.0)) < 1e-9


def test_fi_negativo_cuando_domina_la_banda_baja():
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [80.0, 80.0, 40.0, 40.0]
    result = frequency_index(freqs, power)
    assert result is not None
    assert result < 0


def test_fi_sin_bins_en_la_banda_alta_es_none():
    # fs baja: Nyquist < 5 Hz, no hay banda 5-15
    assert frequency_index([1.0, 2.0, 4.0], [50.0, 50.0, 50.0]) is None


def test_fi_con_media_no_positiva_es_none():
    # dB crudos pueden ser <= 0 con amplitud minúscula; log10 indefinido
    freqs = [1.0, 3.0, 6.0, 10.0]
    power = [-5.0, -5.0, 40.0, 40.0]
    assert frequency_index(freqs, power) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/unit/test_swarm_spectra.py -v --no-cov`
Expected: los 7 nuevos FAIL con `ImportError`; los existentes PASS

- [ ] **Step 3: Write the implementation** (agregar al final de `src/services/swarm_spectra.py`)

```python
# --- Métricas espectrales por columna (PR-W3, spec muro §3) ---------------
# Trabajan sobre la columna YA calculada (listas del payload publicado):
# derivar métricas de datos en mano es la regla anti-OOM del PR #25.

FI_LOW_BAND_HZ = (1.0, 5.0)
FI_HIGH_BAND_HZ = (5.0, 15.0)


def dominant_frequency_hz(freqs, power_db) -> float | None:
    """Frecuencia del bin de mayor potencia de la columna."""
    freqs = np.asarray(freqs, dtype=np.float64)
    power = np.asarray(power_db, dtype=np.float64)
    if freqs.size == 0 or power.size == 0:
        return None
    return float(freqs[int(np.argmax(power))])


def peak_db(power_db) -> float | None:
    """Máximo de la columna — comparable entre estaciones por la escala fija 20-120."""
    power = np.asarray(power_db, dtype=np.float64)
    if power.size == 0:
        return None
    return float(np.max(power))


def frequency_index(freqs, power_db) -> float | None:
    """FI = log10(mean_dB(5-15) / mean_dB(1-5)).

    Negativo = LP/fluidos, positivo = VT/fractura. None si alguna banda no
    tiene bins (fs baja) o si una media no es positiva (log indefinido).
    """
    freqs = np.asarray(freqs, dtype=np.float64)
    power = np.asarray(power_db, dtype=np.float64)
    low = power[(freqs >= FI_LOW_BAND_HZ[0]) & (freqs < FI_LOW_BAND_HZ[1])]
    high = power[(freqs >= FI_HIGH_BAND_HZ[0]) & (freqs <= FI_HIGH_BAND_HZ[1])]
    if low.size == 0 or high.size == 0:
        return None
    low_mean = float(np.mean(low))
    high_mean = float(np.mean(high))
    if low_mean <= 0.0 or high_mean <= 0.0:
        return None
    return float(np.log10(high_mean / low_mean))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python -m pytest tests/unit/test_swarm_spectra.py -v --no-cov`
Expected: todos PASS (nuevos + existentes)

- [ ] **Step 5: Verificación por mutación del FI (obligatoria, spec línea 127)**

Cada mutación por separado, correr, verificar fallo, revertir:
1. Invertir el cociente: `low_mean / high_mean` — deben fallar `test_fi_positivo...` y `test_fi_negativo...`.
2. Cambiar la banda alta a `(1.0, 5.0)` — debe fallar `test_fi_positivo_cuando_domina_la_banda_alta`.
3. Quitar el guard `low_mean <= 0.0` — debe fallar `test_fi_con_media_no_positiva_es_none` (con RuntimeWarning/nan).

- [ ] **Step 6: Commit**

```bash
git add tests/unit/test_swarm_spectra.py src/services/swarm_spectra.py
git commit -m "feat(metricas): frecuencia dominante, pico dB y Frequency Index por columna"
```

---

### Task 3: `MetricsStore` — snapshots de métricas en Redis con TTL

**Files:**
- Create: `src/services/metrics_store.py`
- Test: `tests/integration/test_metrics_store.py`

**Interfaces:**
- Consumes: `redis.asyncio` (mismo cliente que `event_bus.py:24`), fixture `redis_url` de `tests/integration/conftest.py:27`.
- Produces: `class MetricsStore` con `__init__(redis_url: str)`, `connect() -> None` (idempotente), `set_snapshot(channel: str, metrics: dict, ttl_s: int = 60) -> None`, `get_snapshot(channel: str) -> dict | None`, `get_snapshots(channels: list[str]) -> dict[str, dict]` (MGET, omite ausentes), `close() -> None`; constantes `METRICS_KEY_PREFIX = "metrics:latest:"`, `METRICS_SNAPSHOT_TTL_SECONDS = 60`. Tasks 4 y 5 lo consumen.

- [ ] **Step 1: Write the failing tests**

```python
# tests/integration/test_metrics_store.py
"""MetricsStore contra Redis real (testcontainers) — la política del
proyecto: los mocks son ciegos a TTLs y a la semántica de MGET."""

import asyncio

from src.services.metrics_store import METRICS_KEY_PREFIX, MetricsStore

SAMPLE = {
    "channel": "IU.MAJO.00.BHZ",
    "endtime": "2026-08-21T14:32:10.000000Z",
    "rsam": 123.4,
    "freq_hz": 2.4,
    "fi": -0.12,
    "peak_db": 87.3,
    "events_hour": 3,
}


async def test_snapshot_roundtrip(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)
        assert await store.get_snapshot("IU.MAJO.00.BHZ") == SAMPLE
    finally:
        await store.close()


async def test_snapshot_ausente_devuelve_none(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        assert await store.get_snapshot("XX.NADA..HHZ") is None
    finally:
        await store.close()


async def test_get_snapshots_omite_canales_sin_datos(redis_url):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)
        result = await store.get_snapshots(["IU.MAJO.00.BHZ", "XX.NADA..HHZ"])
        assert result == {"IU.MAJO.00.BHZ": SAMPLE}
        assert await store.get_snapshots([]) == {}
    finally:
        await store.close()


async def test_el_snapshot_expira_por_ttl(redis_url, redis_client):
    store = MetricsStore(redis_url)
    await store.connect()
    try:
        await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE, ttl_s=1)
        ttl = await redis_client.ttl(f"{METRICS_KEY_PREFIX}IU.MAJO.00.BHZ")
        assert 0 < ttl <= 1
        await asyncio.sleep(1.2)
        assert await store.get_snapshot("IU.MAJO.00.BHZ") is None
    finally:
        await store.close()
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/integration/test_metrics_store.py -v --no-cov`
Expected: FAIL con `ModuleNotFoundError` (Docker debe estar arriba)

- [ ] **Step 3: Write the implementation**

```python
# src/services/metrics_store.py
"""
Snapshots de métricas por canal en Redis (keys con TTL, no pub/sub).

El pub/sub metrics:{canal} es fire-and-forget: un GET de la API caería
siempre "entre" mensajes. El key metrics:latest:{SCNL} con TTL 60 s da
el último valor conocido; si el canal se muda, la key expira sola y el
endpoint devuelve 404 — mejor que servir un valor viejo como si fuera
actual. Mismo cliente redis.asyncio que event_bus.py.
"""

from __future__ import annotations

import json
from typing import Any, Optional

import redis.asyncio as aioredis

METRICS_KEY_PREFIX = "metrics:latest:"
METRICS_SNAPSHOT_TTL_SECONDS = 60


class MetricsStore:
    def __init__(self, redis_url: str) -> None:
        self._url = redis_url
        self._client: Optional[aioredis.Redis] = None

    async def connect(self) -> None:
        if self._client is None:
            self._client = aioredis.from_url(self._url, decode_responses=True)
            await self._client.ping()

    async def set_snapshot(
        self,
        channel: str,
        metrics: dict[str, Any],
        ttl_s: int = METRICS_SNAPSHOT_TTL_SECONDS,
    ) -> None:
        assert self._client is not None, "connect() primero"
        await self._client.set(
            f"{METRICS_KEY_PREFIX}{channel}", json.dumps(metrics), ex=ttl_s
        )

    async def get_snapshot(self, channel: str) -> Optional[dict[str, Any]]:
        assert self._client is not None, "connect() primero"
        raw = await self._client.get(f"{METRICS_KEY_PREFIX}{channel}")
        return json.loads(raw) if raw else None

    async def get_snapshots(self, channels: list[str]) -> dict[str, dict[str, Any]]:
        assert self._client is not None, "connect() primero"
        if not channels:
            return {}
        raws = await self._client.mget([f"{METRICS_KEY_PREFIX}{c}" for c in channels])
        return {c: json.loads(r) for c, r in zip(channels, raws) if r}

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python -m pytest tests/integration/test_metrics_store.py -v --no-cov`
Expected: 4 PASS

- [ ] **Step 5: Commit**

```bash
git add tests/integration/test_metrics_store.py src/services/metrics_store.py
git commit -m "feat(metricas): MetricsStore con snapshot keys TTL 60s en Redis"
```

---

### Task 4: Cableado del ingestor — calcular y publicar métricas por tick

**Files:**
- Modify: `src/services/seedlink_ingestor.py` (`__init__` ~:75-93, `_on_data` :95-128, bloque `__main__` :318-373)
- Test: `tests/unit/test_seedlink_ingestor.py` (agregar tests)

**Interfaces:**
- Consumes: `rsam_sample`, `RsamAccumulator` (Task 1); `dominant_frequency_hz`, `peak_db`, `frequency_index` (Task 2); `MetricsStore` (Task 3); `COLUMN_INTERVAL_SECONDS` existente (`:43`).
- Produces: publicación pub/sub en `metrics:{trace.id}` + snapshot en el store, con el payload del contrato global. `SeedLinkIngestor.__init__` gana el parámetro keyword opcional `metrics_store: Optional[MetricsStore] = None`.

- [ ] **Step 1: Write the failing tests** (agregar a `tests/unit/test_seedlink_ingestor.py`)

El patrón del archivo: traces sintéticos de ObsPy + `MagicMock()` para el bus. Para capturar publicaciones asíncronas sin loop real, inyectar un loop y un bus falso con lista de llamadas:

```python
# --- métricas del PR-W3 ---------------------------------------------------
import asyncio
from datetime import datetime, timezone

import numpy as np
from obspy import Trace, UTCDateTime


def _make_trace(fs: float = 20.0, seconds: int = 60, amp: float = 100.0) -> Trace:
    rng = np.random.default_rng(42)
    data = (rng.normal(0.0, amp, int(fs * seconds))).astype(np.float64)
    tr = Trace(data=data)
    tr.stats.network, tr.stats.station = "IU", "MAJO"
    tr.stats.location, tr.stats.channel = "00", "BHZ"
    tr.stats.sampling_rate = fs
    tr.stats.starttime = UTCDateTime("2026-08-21T12:00:00")
    return tr


class _RecordingBus:
    """Captura (canal, payload) de publish sin Redis ni loop de verdad."""

    def __init__(self):
        self.published: list[tuple[str, dict]] = []

    async def publish(self, channel: str, event: dict) -> None:
        self.published.append((channel, event))


class _RecordingStore:
    def __init__(self):
        self.snapshots: list[tuple[str, dict]] = []

    async def set_snapshot(self, channel: str, metrics: dict, ttl_s: int = 60) -> None:
        self.snapshots.append((channel, metrics))


def _drive_on_data(ingestor, trace):
    """Corre _on_data con un loop real para que run_coroutine_threadsafe ejecute."""
    loop = asyncio.new_event_loop()
    ingestor._loop = loop
    try:
        ingestor._on_data(trace)
        # drenar las corutinas encoladas por run_coroutine_threadsafe
        loop.run_until_complete(asyncio.sleep(0.05))
    finally:
        loop.close()


def test_on_data_publica_metricas_junto_con_la_columna():
    from src.services.seedlink_ingestor import SeedLinkIngestor

    bus = _RecordingBus()
    store = _RecordingStore()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=store)

    _drive_on_data(ingestor, _make_trace())

    channels = [c for c, _ in bus.published]
    assert "spec:IU.MAJO.00.BHZ" in channels
    assert "metrics:IU.MAJO.00.BHZ" in channels
    metrics = next(p for c, p in bus.published if c.startswith("metrics:"))
    assert set(metrics) == {
        "channel", "endtime", "rsam", "freq_hz", "fi", "peak_db", "events_hour",
    }
    assert metrics["channel"] == "IU.MAJO.00.BHZ"
    assert metrics["rsam"] is not None and metrics["rsam"] > 0
    assert metrics["peak_db"] is not None
    assert metrics["events_hour"] == 0  # ruido estacionario: sin eventos
    assert store.snapshots and store.snapshots[0][0] == "IU.MAJO.00.BHZ"
    assert store.snapshots[0][1] == metrics


def test_un_fallo_de_metricas_no_frena_la_columna():
    from src.services.seedlink_ingestor import SeedLinkIngestor

    class _BoomStore:
        async def set_snapshot(self, channel, metrics, ttl_s=60):
            raise RuntimeError("redis caido")

    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus, metrics_store=_BoomStore())

    _drive_on_data(ingestor, _make_trace())

    # la columna salió igual; el fallo del snapshot quedó en un warning
    assert any(c.startswith("spec:") for c, _ in bus.published)


def test_sin_store_sigue_publicando_pubsub():
    from src.services.seedlink_ingestor import SeedLinkIngestor

    bus = _RecordingBus()
    ingestor = SeedLinkIngestor(bus=bus)  # metrics_store default None

    _drive_on_data(ingestor, _make_trace())

    assert any(c.startswith("metrics:") for c, _ in bus.published)
```

Nota para el implementador: mirar cómo los tests existentes construyen `SeedLinkIngestor` (argumentos reales de `__init__`, ej. watchdog/column_writer) y ajustar la construcción de los tests a esa firma real — lo de arriba asume keywords con defaults.

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/unit/test_seedlink_ingestor.py -v --no-cov`
Expected: los 3 nuevos FAIL (`TypeError: unexpected keyword 'metrics_store'` o asserts); los existentes PASS

- [ ] **Step 3: Write the implementation**

En `src/services/seedlink_ingestor.py`:

1. Imports nuevos:
```python
from src.services.metrics_store import MetricsStore
from src.services.swarm_rsam import RsamAccumulator, rsam_sample
from src.services.swarm_spectra import (
    dominant_frequency_hz,
    frequency_index,
    peak_db,
)
```

2. En `__init__`: agregar parámetro keyword `metrics_store: Optional[MetricsStore] = None`, y estado:
```python
self.metrics_store = metrics_store
self._rsam: dict[str, RsamAccumulator] = {}
```

3. En `_on_data`, dentro del bloque `if self._loop is not None:` (después de publicar la columna, `:124-128`):
```python
            metrics = self._compute_metrics(stream[0], channel_id, column, now)
            asyncio.run_coroutine_threadsafe(
                self._publish_metrics(channel_id, metrics), self._loop
            )
```

4. Métodos nuevos (después de `_compute_column`):
```python
    def _compute_metrics(
        self, trace: Trace, channel_id: str, column: dict, now: datetime
    ) -> dict:
        """Métricas de dominio del tick — SOLO de datos ya en mano (anti-OOM PR #25).

        RSAM muestrea el último tick del buffer; el resto sale de la columna
        recién calculada (mismas listas que ve el frontend).
        """
        acc = self._rsam.setdefault(channel_id, RsamAccumulator())
        tick = trace.slice(starttime=trace.stats.endtime - COLUMN_INTERVAL_SECONDS)
        acc.add(rsam_sample(np.asarray(tick.data)), now)

        rsam_value = acc.rsam(now)
        fi_value = frequency_index(column["freqs"], column["power_db"])
        freq_value = dominant_frequency_hz(column["freqs"], column["power_db"])
        return {
            "channel": channel_id,
            "endtime": column["endtime"],
            "rsam": round(rsam_value, 1) if rsam_value is not None else None,
            "freq_hz": round(freq_value, 2) if freq_value is not None else None,
            "fi": round(fi_value, 2) if fi_value is not None else None,
            "peak_db": peak_db(column["power_db"]),
            "events_hour": acc.events_last_hour(now),
        }

    async def _publish_metrics(self, channel_id: str, metrics: dict) -> None:
        """Best-effort: un fallo acá JAMÁS debe frenar la ingesta de columnas."""
        try:
            await self.bus.publish(f"metrics:{channel_id}", metrics)
            if self.metrics_store is not None:
                await self.metrics_store.set_snapshot(channel_id, metrics)
        except Exception:
            logger.warning(
                "seedlink_ingestor: fallo publicando métricas de %s",
                channel_id,
                exc_info=True,
            )
```
(Si `numpy` no está importado como `np` en el módulo, agregarlo.)

5. En el bloque `__main__` (`:318-373`): crear `MetricsStore(settings.redis_url)` junto al bus, conectarlo EN EL MISMO loop dedicado donde se conecta el bus (misma regla del pool asyncpg, ver comentario `:216-223`), pasarlo al constructor y cerrarlo en el shutdown ordenado. La conexión es best-effort: si Redis no está, loguear warning y arrancar con `metrics_store=None`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python -m pytest tests/unit/test_seedlink_ingestor.py tests/unit/test_swarm_rsam.py tests/unit/test_swarm_spectra.py -v --no-cov`
Expected: todos PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/seedlink_ingestor.py tests/unit/test_seedlink_ingestor.py
git commit -m "feat(metricas): el ingestor publica metrics:{canal} + snapshot por tick"
```

---

### Task 5: API — router `/stations` con snapshot singular y batch

**Files:**
- Create: `src/api/routers/stations.py`
- Modify: `src/main.py` (lifespan ~:244-256 para el store best-effort, `:432-433` para el include_router, shutdown `:371-378`)
- Test: `tests/integration/test_stations_api.py`

**Interfaces:**
- Consumes: `MetricsStore` (Task 3) vía `request.app.state.metrics_store` (patrón `walls.py:26-28`); `settings.redis_url` (`settings.py:94`).
- Produces: `GET /stations/metrics?channel=A&channel=B` → `{"metrics": {SCNL: payload}}` (omite ausentes; 422 si >120 canales); `GET /stations/{channel}/metrics` → payload | 404; ambos 503 si Redis no está. Endpoints PÚBLICOS (misma política que /spectrograms). Task 6 los consume.

- [ ] **Step 1: Write the failing tests**

```python
# tests/integration/test_stations_api.py
"""Endpoints de métricas contra Redis real. El app de test se arma con el
mismo patrón que los tests de walls (mirar tests/integration/test_walls_api.py
para el fixture del cliente HTTP y adaptar: acá NO hace falta Postgres ni
auth — solo app.state.metrics_store)."""

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from src.api.routers import stations as stations_router
from src.services.metrics_store import MetricsStore

SAMPLE = {
    "channel": "IU.MAJO.00.BHZ",
    "endtime": "2026-08-21T14:32:10.000000Z",
    "rsam": 123.4,
    "freq_hz": 2.4,
    "fi": -0.12,
    "peak_db": 87.3,
    "events_hour": 3,
}


@pytest.fixture
async def app_with_store(redis_url):
    app = FastAPI()
    app.include_router(stations_router.router)
    store = MetricsStore(redis_url)
    await store.connect()
    app.state.metrics_store = store
    yield app, store
    await store.close()


@pytest.fixture
async def client(app_with_store):
    app, _ = app_with_store
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def test_snapshot_singular(client, app_with_store):
    _, store = app_with_store
    await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)

    response = await client.get("/stations/IU.MAJO.00.BHZ/metrics")

    assert response.status_code == 200
    assert response.json() == SAMPLE


async def test_snapshot_singular_sin_datos_da_404(client):
    response = await client.get("/stations/XX.NADA..HHZ/metrics")
    assert response.status_code == 404


async def test_batch_omite_canales_sin_datos(client, app_with_store):
    _, store = app_with_store
    await store.set_snapshot("IU.MAJO.00.BHZ", SAMPLE)

    response = await client.get(
        "/stations/metrics",
        params=[("channel", "IU.MAJO.00.BHZ"), ("channel", "XX.NADA..HHZ")],
    )

    assert response.status_code == 200
    assert response.json() == {"metrics": {"IU.MAJO.00.BHZ": SAMPLE}}


async def test_batch_con_mas_de_120_canales_da_422(client):
    params = [("channel", f"XX.S{i:04d}..HHZ") for i in range(121)]
    response = await client.get("/stations/metrics", params=params)
    assert response.status_code == 422


async def test_sin_redis_da_503(redis_url):
    app = FastAPI()
    app.include_router(stations_router.router)
    app.state.metrics_store = None
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as c:
        response = await c.get("/stations/IU.MAJO.00.BHZ/metrics")
    assert response.status_code == 503
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/integration/test_stations_api.py -v --no-cov`
Expected: FAIL con `ModuleNotFoundError: src.api.routers.stations`

- [ ] **Step 3: Write the implementation**

```python
# src/api/routers/stations.py
"""
Métricas por estación (PR-W3, spec muro §3).

Endpoints PÚBLICOS (misma política que /spectrograms: los datos sísmicos
son públicos, la UI del dashboard es lo que requiere sesión). El batch
existe por la escala del muro: hasta 120 canales visibles — un request
cada 15 s en vez de 120 pollers sueltos.

/metrics va declarado ANTES de /{channel}/metrics — mismo patrón que
/walls/global en walls.py.
"""

from fastapi import APIRouter, HTTPException, Query, Request

from src.services.metrics_store import MetricsStore

router = APIRouter(prefix="/stations", tags=["stations"])

# Espejo de MAX_WALL_CHANNELS (wall_service.py:91): el muro es el
# consumidor más grande posible del batch.
MAX_METRICS_CHANNELS = 120


def _get_metrics_store(request: Request) -> MetricsStore:
    store = getattr(request.app.state, "metrics_store", None)
    if store is None:
        raise HTTPException(
            status_code=503, detail="Métricas no disponibles (Redis no configurado)"
        )
    return store


@router.get("/metrics")
async def get_stations_metrics(
    request: Request,
    channel: list[str] = Query(..., description="SCNL completo, repetible"),
) -> dict:
    if len(channel) > MAX_METRICS_CHANNELS:
        raise HTTPException(
            status_code=422,
            detail=f"Máximo {MAX_METRICS_CHANNELS} canales por request",
        )
    store = _get_metrics_store(request)
    return {"metrics": await store.get_snapshots(channel)}


@router.get("/{channel}/metrics")
async def get_station_metrics(channel: str, request: Request) -> dict:
    store = _get_metrics_store(request)
    snapshot = await store.get_snapshot(channel)
    if snapshot is None:
        raise HTTPException(status_code=404, detail="Sin métricas recientes para el canal")
    return snapshot
```

En `src/main.py`:
1. Import: `from src.api.routers import stations as stations_router` y `from src.services.metrics_store import MetricsStore` (junto a los imports de routers existentes).
2. Registro (junto a `:432-433`): `app.include_router(stations_router.router)`.
3. En el lifespan, bloque best-effort nuevo DESPUÉS del bloque de Redis/event_bus (`:213-221`), siguiendo su mismo estilo:
```python
    # MetricsStore (PR-W3): best-effort como el event_bus — sin Redis el
    # dashboard pierde las métricas pero la API sigue sirviendo todo lo demás.
    metrics_store = MetricsStore(settings.redis_url)
    try:
        await metrics_store.connect()
        app.state.metrics_store = metrics_store
    except Exception:
        logger.warning("MetricsStore: Redis no disponible, métricas deshabilitadas")
        app.state.metrics_store = None
```
4. En el shutdown ordenado (`:371-378`), después de `event_bus.close()`:
```python
    if app.state.metrics_store is not None:
        await app.state.metrics_store.close()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `./venv/bin/python -m pytest tests/integration/test_stations_api.py -v --no-cov`
Expected: 5 PASS

- [ ] **Step 5: Correr la suite backend completa**

Run: `./venv/bin/python -m pytest tests/ -v --no-cov -x -q 2>&1 | tail -20`
Expected: todo PASS (mypy del proyecto también si el flujo del repo lo corre)

- [ ] **Step 6: Commit**

```bash
git add src/api/routers/stations.py src/main.py tests/integration/test_stations_api.py
git commit -m "feat(metricas): GET /stations/{channel}/metrics + batch /stations/metrics"
```

---

### Task 6: Lib frontend `station-metrics` + hook de polling

**Files:**
- Create: `dashboard/lib/station-metrics.ts`
- Create: `dashboard/lib/use-station-metrics.ts`
- Test: `dashboard/lib/station-metrics.test.ts`

**Interfaces:**
- Consumes: `GET /stations/metrics?channel=...` (Task 5).
- Produces: `interface StationMetrics {channel: string; endtime: string; rsam: number | null; freq_hz: number | null; fi: number | null; peak_db: number | null; events_hour: number | null}`; `fetchStationMetrics(channels: string[]): Promise<Record<string, StationMetrics>>`; `latencySeconds(endtime: string, nowMs: number): number | null`; `formatWallMetricsLine(m: StationMetrics, nowMs: number): string`; `useStationMetrics(channels: string[], enabled: boolean): Record<string, StationMetrics>`. Tasks 7 y 8 los consumen.

- [ ] **Step 1: Write the failing tests**

```typescript
// dashboard/lib/station-metrics.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchStationMetrics,
  formatWallMetricsLine,
  latencySeconds,
  type StationMetrics,
} from './station-metrics';

const SAMPLE: StationMetrics = {
  channel: 'IU.MAJO.00.BHZ',
  endtime: '2026-08-21T14:32:10.000000Z',
  rsam: 123.4,
  freq_hz: 2.4,
  fi: -0.12,
  peak_db: 87.3,
  events_hour: 3,
};

describe('fetchStationMetrics', () => {
  beforeEach(() => {
    // tipar el spy con los args de fetch — la lección del W2: un vi.fn()
    // pelado tipa mock.calls[0] como [] y tsc --noEmit revienta.
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ metrics: { [SAMPLE.channel]: SAMPLE } }),
        } as Response),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arma el query con channel repetido y devuelve el mapa', async () => {
    const result = await fetchStationMetrics(['IU.MAJO.00.BHZ', 'JP.JYT..BHZ']);

    const fetchMock = vi.mocked(fetch);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/stations/metrics?');
    expect(url).toContain('channel=IU.MAJO.00.BHZ');
    expect(url).toContain('channel=JP.JYT..BHZ');
    expect(result['IU.MAJO.00.BHZ']).toEqual(SAMPLE);
  });

  it('sin canales no llama a fetch y devuelve vacío', async () => {
    expect(await fetchStationMetrics([])).toEqual({});
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('con respuesta no-ok devuelve vacío (la UI muestra guiones, no rompe)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false } as Response);
    expect(await fetchStationMetrics(['IU.MAJO.00.BHZ'])).toEqual({});
  });
});

describe('latencySeconds', () => {
  it('resta el endtime del ahora, redondeado a segundos', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    expect(latencySeconds(SAMPLE.endtime, now)).toBe(8);
  });

  it('endtime inválido devuelve null', () => {
    expect(latencySeconds('no-es-fecha', Date.now())).toBeNull();
  });
});

describe('formatWallMetricsLine', () => {
  it('formatea la banda compacta RSAM · FI · lat', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    expect(formatWallMetricsLine(SAMPLE, now)).toBe('RSAM 123 · FI -0.12 · 8s');
  });

  it('los null salen como guion', () => {
    const now = Date.parse('2026-08-21T14:32:18.000Z');
    const m = { ...SAMPLE, rsam: null, fi: null };
    expect(formatWallMetricsLine(m, now)).toBe('RSAM — · FI — · 8s');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run lib/station-metrics.test.ts`
Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Write the implementation**

```typescript
// dashboard/lib/station-metrics.ts
/**
 * Métricas por estación (PR-W3): tipos, fetch batch y formateo.
 *
 * Polling ligero a propósito (spec §3 dejaba la decisión al plan): el muro
 * monta ~74 tiras — un WS de métricas por tira sería una tormenta de
 * conexiones; un request batch cada 15 s por contenedor alcanza para
 * métricas que cambian cada 4 s.
 */

export interface StationMetrics {
  channel: string;
  endtime: string;
  rsam: number | null;
  freq_hz: number | null;
  fi: number | null;
  peak_db: number | null;
  events_hour: number | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export async function fetchStationMetrics(
  channels: string[],
): Promise<Record<string, StationMetrics>> {
  if (channels.length === 0) return {};
  const params = new URLSearchParams();
  for (const channel of channels) params.append('channel', channel);
  try {
    const response = await fetch(`${API_BASE}/stations/metrics?${params}`);
    if (!response.ok) return {};
    const data = (await response.json()) as { metrics?: Record<string, StationMetrics> };
    return data.metrics ?? {};
  } catch {
    // Sin métricas la UI muestra guiones; nunca es razón para romper la vista
    return {};
  }
}

export function latencySeconds(endtime: string, nowMs: number): number | null {
  const parsed = Date.parse(endtime);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, Math.round((nowMs - parsed) / 1000));
}

const DASH = '—';

function fmt(value: number | null, digits: number): string {
  return value === null ? DASH : value.toFixed(digits);
}

/** Banda compacta de la tira del muro (spec §3: "RSAM · FI · lat"). */
export function formatWallMetricsLine(m: StationMetrics, nowMs: number): string {
  const lat = latencySeconds(m.endtime, nowMs);
  const rsam = m.rsam === null ? DASH : String(Math.round(m.rsam));
  return `RSAM ${rsam} · FI ${fmt(m.fi, 2)} · ${lat === null ? DASH : `${lat}s`}`;
}
```

```typescript
// dashboard/lib/use-station-metrics.ts
/**
 * Hook de polling batch de métricas. `enabled` apaga el polling cuando la
 * vista no las muestra (tab de tarjetas cerrada, showMetrics off) — cero
 * requests de fondo.
 */

'use client';

import useSWR from 'swr';

import { fetchStationMetrics, type StationMetrics } from './station-metrics';

export const METRICS_REFRESH_MS = 15_000;

export function useStationMetrics(
  channels: string[],
  enabled: boolean,
): Record<string, StationMetrics> {
  const key =
    enabled && channels.length > 0 ? ['station-metrics', ...channels] : null;
  const { data } = useSWR(key, () => fetchStationMetrics(channels), {
    refreshInterval: METRICS_REFRESH_MS,
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });
  return data ?? {};
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run lib/station-metrics.test.ts && npx tsc --noEmit`
Expected: 7 PASS, tsc limpio

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/station-metrics.ts dashboard/lib/use-station-metrics.ts dashboard/lib/station-metrics.test.ts
git commit -m "feat(metricas): lib station-metrics + hook de polling batch"
```

---

### Task 7: Fila de métricas en la tarjeta de `/spectrograms-live`

**Files:**
- Modify: `dashboard/components/SortableSpectrogramCard.tsx` (props :13-19; bloque del badge :74-86)
- Modify: `dashboard/app/(app)/spectrograms-live/page.tsx` (polling batch; pasar métricas a cada tarjeta, grid ~:390-395)
- Modify: `dashboard/messages/es.json` y `dashboard/messages/en.json` (namespace `charts.spectrogram.metrics`, PARIDAD)
- Test: `dashboard/components/SortableSpectrogramCard.test.tsx` (agregar tests; si no existe el archivo, crearlo siguiendo el patrón de mocks de `LiveSpectrogramCanvas.test.tsx`)

**Interfaces:**
- Consumes: `StationMetrics`, `latencySeconds` (Task 6); `useStationMetrics` (Task 6) desde la página.
- Produces: `SortableSpectrogramCardProps` gana `metrics?: StationMetrics`. Comportamiento: **en modo live con métricas disponibles, la fila reemplaza el badge de riesgo; sin métricas o en modo estático, el badge de riesgo queda como fallback** (decisión: el spec pide reemplazar el badge, pero un canal caído sin fallback dejaría la tarjeta sin señal de contexto).

- [ ] **Step 1: i18n primero** (las claves las consumen los tests)

En `dashboard/messages/es.json`, dentro de `charts.spectrogram` (junto a `riskLabel`):
```json
"metrics": {
  "rsam": "RSAM",
  "freqDominant": "f dom",
  "fi": "FI",
  "peakDb": "pico",
  "eventsHour": "ev/h",
  "latency": "lat",
  "tooltip": "RSAM (media móvil 10 min) · frecuencia dominante · Frequency Index (− fluidos / + fractura) · pico dB (escala fija 20-120) · eventos por hora · latencia"
}
```
En `en.json`, mismas claves: `"rsam": "RSAM"`, `"freqDominant": "dom f"`, `"fi": "FI"`, `"peakDb": "peak"`, `"eventsHour": "ev/h"`, `"latency": "lat"`, `"tooltip": "RSAM (10 min moving average) · dominant frequency · Frequency Index (− fluids / + fracture) · peak dB (fixed 20-120 scale) · events per hour · latency"`.

- [ ] **Step 2: Write the failing tests** (en `SortableSpectrogramCard.test.tsx`)

```tsx
// agregar (o crear el archivo con los mocks del patrón LiveSpectrogramCanvas.test.tsx:
// NextIntlClientProvider con es.json, stub de WebSocket/fetch/canvas)
import type { StationMetrics } from '@/lib/station-metrics';

const METRICS: StationMetrics = {
  channel: 'JP.JYT..BHZ',
  endtime: new Date().toISOString(),
  rsam: 123.4,
  freq_hz: 2.4,
  fi: -0.12,
  peak_db: 87.3,
  events_hour: 3,
};

it('en modo live con métricas muestra la fila y oculta el badge de riesgo', () => {
  renderCard({ liveChannel: 'JP.JYT..BHZ', metrics: METRICS });

  expect(screen.getByTestId('card-metrics-row')).toHaveTextContent('RSAM 123');
  expect(screen.getByTestId('card-metrics-row')).toHaveTextContent('FI -0.12');
  expect(screen.getByTestId('card-metrics-row')).toHaveTextContent('87.3');
  expect(screen.queryByTitle(/riesgo|risk/i)).toBeNull();
});

it('sin métricas el badge de riesgo queda como fallback', () => {
  renderCard({ liveChannel: 'JP.JYT..BHZ', metrics: undefined });

  expect(screen.queryByTestId('card-metrics-row')).toBeNull();
  expect(screen.getByTitle(/riesgo|risk/i)).toBeInTheDocument();
});
```
(`renderCard` es el helper local del archivo de test: render con provider + props mínimas de `city`; construirlo con una city real de `seismic-cities.ts`, ej. Tokyo.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run components/SortableSpectrogramCard.test.tsx`
Expected: FAIL (prop `metrics` inexistente / testid ausente)

- [ ] **Step 4: Write the implementation**

En `SortableSpectrogramCard.tsx`:
1. Props: agregar `metrics?: StationMetrics` (import type desde `@/lib/station-metrics`).
2. Reemplazar el bloque del badge (`:74-86`) por:
```tsx
{mode === 'live' && metrics ? (
  /* Fila de métricas de dominio (PR-W3): reemplaza al badge de riesgo
     estático cuando hay señal viva — el estado de la SEÑAL le gana a la
     clasificación de la zona. */
  <div
    data-testid="card-metrics-row"
    className="absolute bottom-2 left-2 right-2 z-10 flex items-center justify-between gap-1 rounded bg-black/60 px-1.5 py-0.5 font-data text-[9px] text-gray-200"
    title={t('metrics.tooltip')}
  >
    <span>{t('metrics.rsam')} {metrics.rsam === null ? '—' : Math.round(metrics.rsam)}</span>
    <span>{t('metrics.freqDominant')} {metrics.freq_hz === null ? '—' : `${metrics.freq_hz}Hz`}</span>
    <span>{t('metrics.fi')} {metrics.fi === null ? '—' : metrics.fi.toFixed(2)}</span>
    <span>{t('metrics.peakDb')} {metrics.peak_db === null ? '—' : metrics.peak_db.toFixed(1)}</span>
    <span>{t('metrics.eventsHour')} {metrics.events_hour ?? '—'}</span>
    <span>{t('metrics.latency')} {latency === null ? '—' : `${latency}s`}</span>
  </div>
) : (
  /* … bloque del badge de riesgo EXISTENTE, sin cambios … */
)}
```
con `const latency = metrics ? latencySeconds(metrics.endtime, Date.now()) : null;` arriba del return.

En `spectrograms-live/page.tsx`:
1. `const liveChannels = useMemo(() => Object.values(liveChannelsByCity), [liveChannelsByCity]);`
2. `const metricsByChannel = useStationMetrics(liveChannels, tab === 'cards');`
3. En el grid (`:390-395`), pasar `metrics={liveChannel ? metricsByChannel[liveChannel] : undefined}` (usando la misma variable con la que ya pasa `liveChannel`).

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run components/SortableSpectrogramCard.test.tsx && npx tsc --noEmit`
Expected: PASS + tsc limpio

- [ ] **Step 6: Verificar paridad i18n**

Run: `cd dashboard && npx vitest run` (la suite tiene test de paridad de claves; si no cubre el namespace nuevo, comparar a mano `metrics.*` en ambos archivos)
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/SortableSpectrogramCard.tsx dashboard/app/\(app\)/spectrograms-live/page.tsx dashboard/messages/es.json dashboard/messages/en.json dashboard/components/SortableSpectrogramCard.test.tsx
git commit -m "feat(metricas): fila de metricas en la tarjeta reemplaza el badge de riesgo"
```

---

### Task 8: Banda compacta en la tira del muro (gated por `showMetrics`)

**Files:**
- Modify: `dashboard/components/SpectronetStrip.tsx` (27 líneas hoy; props :5-10)
- Modify: `dashboard/components/SpectronetWall.tsx` (props :6-10, render :14-39)
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (polling; render del muro :858)
- Test: `dashboard/components/SpectronetWall.test.tsx` y `dashboard/components/SpectronetStrip.test.tsx` (crear si no existe)

**Interfaces:**
- Consumes: `StationMetrics`, `formatWallMetricsLine` (Task 6); `useStationMetrics` (Task 6); `wall.layout.showMetrics` (`types.ts:345`, hoy sin consumidor — este task lo estrena).
- Produces: `SpectronetStripProps` gana `metricsLine?: string | null`; `SpectronetWallProps` gana `metrics?: Record<string, StationMetrics>` y `nowMs?: number`. La banda se renderiza como overlay absoluto DENTRO del contenedor del canvas (no cambia la altura de la tira: el muro de la cartelera está dimensionado para entrar sin scroll).

- [ ] **Step 1: Write the failing tests**

En `SpectronetWall.test.tsx` (el mock de `SpectronetStrip` del archivo (:5-9) debe extenderse para exponer `data-metrics-line={metricsLine ?? ''}`):

```tsx
it('con showMetrics pasa la banda formateada a cada tira', () => {
  const wall = makeWall({ showMetrics: true });
  const metrics = {
    'JP.JYT..BHZ': {
      channel: 'JP.JYT..BHZ',
      endtime: '2026-08-21T14:32:10.000000Z',
      rsam: 123.4, freq_hz: 2.4, fi: -0.12, peak_db: 87.3, events_hour: 3,
    },
  };

  render(
    <SpectronetWall
      wall={wall}
      stripWidth={300}
      stripHeight={40}
      metrics={metrics}
      nowMs={Date.parse('2026-08-21T14:32:18.000Z')}
    />,
  );

  expect(screen.getAllByTestId('strip')[0]).toHaveAttribute(
    'data-metrics-line',
    'RSAM 123 · FI -0.12 · 8s',
  );
});

it('sin showMetrics no pasa banda aunque haya métricas', () => {
  const wall = makeWall({ showMetrics: false });
  render(<SpectronetWall wall={wall} stripWidth={300} stripHeight={40} metrics={{}} />);
  expect(screen.getAllByTestId('strip')[0]).toHaveAttribute('data-metrics-line', '');
});
```
(`makeWall` = fixture existente del archivo, parametrizando `showMetrics`.)

En `SpectronetStrip.test.tsx` (crear; mockear `LiveSpectrogramCanvas` con `vi.mock`):

```tsx
it('renderiza la banda de métricas cuando llega metricsLine', () => {
  render(<SpectronetStrip channel="JP.JYT..BHZ" label="TOKYO" width={300} height={40} metricsLine="RSAM 123 · FI -0.12 · 8s" />);
  expect(screen.getByTestId('strip-metrics-band')).toHaveTextContent('RSAM 123 · FI -0.12 · 8s');
});

it('sin metricsLine no hay banda', () => {
  render(<SpectronetStrip channel="JP.JYT..BHZ" label="TOKYO" width={300} height={40} />);
  expect(screen.queryByTestId('strip-metrics-band')).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run components/SpectronetWall.test.tsx components/SpectronetStrip.test.tsx`
Expected: FAIL

- [ ] **Step 3: Write the implementation**

`SpectronetStrip.tsx` — agregar prop y overlay dentro del contenedor del canvas (`:24`):
```tsx
interface SpectronetStripProps {
  channel: string;
  label: string;
  width: number;
  height: number;
  metricsLine?: string | null;
}
```
```tsx
<div className="relative">
  <LiveSpectrogramCanvas … variant="bare" />
  {metricsLine ? (
    /* Banda compacta (spec §3): overlay para NO cambiar la altura de la
       tira — el muro de la cartelera está calculado para entrar sin scroll. */
    <div
      data-testid="strip-metrics-band"
      className="pointer-events-none absolute bottom-0 left-0 z-10 bg-black/60 px-1 font-data text-[8px] leading-3 text-gray-200"
    >
      {metricsLine}
    </div>
  ) : null}
</div>
```

`SpectronetWall.tsx`:
```tsx
interface SpectronetWallProps {
  wall: WallResponse;
  stripWidth: number;
  stripHeight: number;
  metrics?: Record<string, StationMetrics>;
  nowMs?: number; // inyectable para tests; default Date.now() al render
}
```
En el map de channels (`:25-31`):
```tsx
const showMetrics = wall.layout.showMetrics;
const now = nowMs ?? Date.now();
// …
<SpectronetStrip
  …props existentes…
  metricsLine={
    showMetrics && metrics?.[item.channel]
      ? formatWallMetricsLine(metrics[item.channel], now)
      : null
  }
/>
```

`GlobeBroadcastOverlay.tsx`:
1. Canales del muro activo:
```tsx
const wallChannels = useMemo(
  () =>
    activeWall
      ? activeWall.layout.columns.flatMap((c) =>
          c.groups.flatMap((g) => g.channels.map((ch) => ch.channel)),
        )
      : [],
  [activeWall],
);
```
2. Polling solo cuando la cartelera está abierta Y el muro pide métricas:
```tsx
const wallMetrics = useStationMetrics(
  wallChannels,
  billboard && (activeWall?.layout.showMetrics ?? false),
);
```
3. Pasarlas al render (`:858`): `<SpectronetWall wall={activeWall} … metrics={wallMetrics} />`.

Decisión de alcance: el preview del armador (WallBuilder) NO muestra métricas — es una vista de edición; la banda vive en la cartelera. El toggle del armador ya persiste el flag (W2) y acá por fin hace algo.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run components/SpectronetWall.test.tsx components/SpectronetStrip.test.tsx components/GlobeBroadcastOverlay.test.tsx && npx tsc --noEmit`
Expected: PASS + tsc limpio (los tests existentes del overlay no deben romperse: el mock de fetch global ya devuelve `{}`)

- [ ] **Step 5: Verificación por mutación del gating**

Mutar `showMetrics && metrics?.[item.channel]` → `metrics?.[item.channel]` (ignorando el flag): debe fallar `sin showMetrics no pasa banda aunque haya métricas`. Revertir.

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/SpectronetStrip.tsx dashboard/components/SpectronetWall.tsx dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/SpectronetWall.test.tsx dashboard/components/SpectronetStrip.test.tsx
git commit -m "feat(metricas): banda RSAM/FI/lat en las tiras del muro con showMetrics"
```

---

### Task 10: UTC en el formateo compartido (`formatDateTimeCompact` + formats de next-intl)

**Files:**
- Modify: `dashboard/lib/utils.ts:85-92` (`formatDateTimeCompact`)
- Modify: `dashboard/i18n/request.ts:19-25` (bloque `formats`)
- Test: `dashboard/lib/utils.test.ts` (agregar; crear si no existe)

**Interfaces:**
- Consumes: nada.
- Produces: `formatDateTimeCompact(isoString)` devuelve **UTC** (`YYYY-MM-DD HH:MM:SS`); los formats nombrados de next-intl (`medium`/`short`/`time`) fijan `timeZone: 'UTC'`, así que **todo `format.dateTime(...)` de la app pasa a UTC sin tocar cada call-site**. Task 11 rotula la UI.

**Por qué esto primero:** es un cambio de una línea por función que arregla el bug de raíz. `formatDateTimeCompact` usa hoy `getHours()`/`getDate()` — hora **local del navegador**. Un usuario en Buenos Aires (UTC-3) ve un sismo de las 13:06 UTC como "10:06" en una app que rotula "UTC" al lado. Eso no es un detalle cosmético: es un dato sísmico mal presentado.

- [ ] **Step 1: Write the failing tests**

```typescript
// dashboard/lib/utils.test.ts (agregar; si el archivo no existe, crearlo con
// los imports del patrón de otros tests de lib/)
import { describe, expect, it } from 'vitest';

import { formatDateTimeCompact } from './utils';

describe('formatDateTimeCompact — siempre UTC', () => {
  it('formatea en UTC, no en la zona del proceso', () => {
    // 13:06 UTC debe salir 13:06 corra donde corra el test (TZ del CI puede
    // ser cualquiera). Con getHours() local esto falla fuera de UTC.
    expect(formatDateTimeCompact('2026-08-21T13:06:40.000Z')).toBe(
      '2026-08-21 13:06:40',
    );
  });

  it('no corre el día hacia atrás cerca de medianoche UTC', () => {
    // El caso que delata la zona local: 00:30 UTC es "el día anterior 21:30"
    // en Buenos Aires. La fecha debe seguir siendo la del 22.
    expect(formatDateTimeCompact('2026-08-22T00:30:00.000Z')).toBe(
      '2026-08-22 00:30:00',
    );
  });

  it('acepta el formato de endtime de ObsPy (microsegundos)', () => {
    expect(formatDateTimeCompact('2026-08-21T14:32:10.123456Z')).toBe(
      '2026-08-21 14:32:10',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && TZ=America/Argentina/Buenos_Aires npx vitest run lib/utils.test.ts`
Expected: FAIL — con `TZ` forzada a UTC-3 los tres tests muestran la hora corrida.
(Correr SIEMPRE con `TZ=...` explícita: si la máquina ya está en UTC, el test verde no prueba nada.)

- [ ] **Step 3: Write the implementation**

En `dashboard/lib/utils.ts`, reemplazar el cuerpo de `formatDateTimeCompact` (los getters locales por los UTC) y actualizar el docstring:

```typescript
/**
 * "YYYY-MM-DD HH:MM:SS" en **UTC**, estilo USGS: una sola línea corta que
 * sigue siendo ordenable a simple vista (año primero), a diferencia de
 * formatDateTime ("5 ago 2026, 1:05:39 p. m.") que es más legible pero casi
 * el doble de ancho.
 *
 * UTC y no la zona del navegador a propósito: el estándar del dominio
 * sísmico es UTC y todas las fuentes (USGS, EMSC, endtime de ObsPy) ya
 * llegan en UTC. Renderizar en hora local corría el dato hasta 14 h y
 * convivía con carteles que decían "UTC" al lado.
 */
export function formatDateTimeCompact(isoString: string): string {
  const date = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}
```

En `dashboard/i18n/request.ts`, agregar `timeZone: 'UTC'` a los tres formats nombrados y explicar por qué:

```typescript
/**
 * Formats globales nombrados (Decision 6). `formatDateTimeCompact` de
 * lib/utils (YYYY-MM-DD HH:MM:SS estilo USGS) NO se localiza — es formato
 * técnico ordenable, deliberadamente fuera de esta tabla (pero también UTC).
 *
 * timeZone: 'UTC' en los tres: el dominio sísmico trabaja en UTC y todas
 * las fuentes llegan en UTC. Fijarlo acá convierte a UTC TODOS los
 * `format.dateTime(...)` de la app de una sola vez, sin tocar call-sites.
 */
export const formats = {
  dateTime: {
    medium: { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' },
    short: { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' },
    time: { timeStyle: 'medium', timeZone: 'UTC' },
  },
} as const;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && TZ=America/Argentina/Buenos_Aires npx vitest run lib/utils.test.ts && npx tsc --noEmit`
Expected: 3 PASS + tsc limpio

- [ ] **Step 5: Correr la suite completa con TZ hostil**

Run: `cd dashboard && TZ=Asia/Tokyo npx vitest run 2>&1 | tail -8`
Expected: todo PASS. Si algún test existente falla, es que **asumía hora local** — arreglar el TEST (esperar UTC), no revertir el fix: el comportamiento nuevo es el correcto. Anotar cuáles se tocaron en el mensaje de commit.

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/utils.ts dashboard/i18n/request.ts dashboard/lib/utils.test.ts
git commit -m "fix(utc): formatDateTimeCompact y formats de next-intl en UTC"
```

---

### Task 11: Sufijo UTC visible en las horas de la UI

**Files:**
- Modify: `dashboard/components/LiveSpectrogramCanvas.tsx:189-209` (variante `default`, la hora de `lastUpdate`)
- Modify: `dashboard/components/SortableSpectrogramCard.tsx` (fila de métricas de Task 7: rotular la latencia)
- Modify: `dashboard/messages/es.json` y `en.json` (clave compartida `common.utcSuffix`, PARIDAD)
- Test: `dashboard/components/LiveSpectrogramCanvas.test.tsx` (agregar)

**Interfaces:**
- Consumes: los formats UTC de Task 10; `latencySeconds` (Task 6).
- Produces: toda hora absoluta visible lleva `UTC` al lado. **Las duraciones relativas NO** (una latencia de "8s" o un "hace 5 minutos" no tienen zona horaria — rotularlas sería ruido incorrecto).

**Alcance deliberado:** este task rotula las superficies que el PR-W3 toca (espectrogramas y tarjetas). El resto de la app (`GlobeEventPanel`, paneles de admin, mapas) YA quedó en UTC por Task 10 — el rótulo en esas vistas es un pase de UI aparte para no inflar este PR. Anotarlo en el cuerpo del PR como seguimiento explícito.

- [ ] **Step 1: i18n primero**

En `dashboard/messages/es.json` y `en.json`, dentro del namespace `common` (si no existe, crearlo al nivel de los otros namespaces raíz): `"utcSuffix": "UTC"` en AMBOS (no se traduce: "UTC" es UTC en todos los idiomas; la clave existe para no hardcodear la cadena en JSX y para que la auditoría de paridad la vea).

- [ ] **Step 2: Write the failing test**

```tsx
// dashboard/components/LiveSpectrogramCanvas.test.tsx (agregar al describe existente)
it('la hora de última actualización se muestra en UTC con su rótulo', async () => {
  renderCanvas({ variant: 'default' });   // helper existente del archivo

  const ws = MockWebSocket.instances[0];
  await act(async () => {
    ws.onmessage?.({
      data: JSON.stringify({
        channel: 'IU.MAJO.00.BHZ',
        endtime: '2026-08-21T13:06:40.000000Z',
        freqs: [1, 2],
        power_db: [40, 50],
      }),
    } as MessageEvent);
  });

  // 13:06:40 UTC, no la hora local del runner
  expect(screen.getByText(/13:06:40/)).toBeInTheDocument();
  expect(screen.getByText(/UTC/)).toBeInTheDocument();
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd dashboard && TZ=America/Argentina/Buenos_Aires npx vitest run components/LiveSpectrogramCanvas.test.tsx`
Expected: FAIL — falta el rótulo `UTC` (la hora ya sale bien por Task 10)

- [ ] **Step 4: Write the implementation**

En `LiveSpectrogramCanvas.tsx`, variante `default`, junto al `format.dateTime(new Date(lastUpdate), 'time')`, agregar el sufijo con `useTranslations('common')`:
```tsx
{format.dateTime(new Date(lastUpdate), 'time')} {tCommon('utcSuffix')}
```

En la fila de métricas de `SortableSpectrogramCard.tsx` (Task 7): la latencia es una **duración** (`8s`), NO lleva sufijo UTC. Si en esa fila se agregara alguna hora absoluta, ahí sí corresponde el rótulo.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd dashboard && TZ=Asia/Tokyo npx vitest run components/LiveSpectrogramCanvas.test.tsx components/SortableSpectrogramCard.test.tsx && npx tsc --noEmit`
Expected: PASS + tsc limpio

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/LiveSpectrogramCanvas.tsx dashboard/components/SortableSpectrogramCard.tsx dashboard/messages/es.json dashboard/messages/en.json dashboard/components/LiveSpectrogramCanvas.test.tsx
git commit -m "feat(utc): rotulo UTC visible en las horas de espectrogramas y tarjetas"
```

---

### Task 12: Catálogo de subestaciones buscable (estilo SWARM)

**Files:**
- Modify: `src/services/spectrogram_service.py` (agregar `station_catalog()` junto a `resolve_live_catalog` :131-154)
- Modify: `src/main.py` (endpoint `GET /spectrograms/station-catalog`, junto a `/spectrograms/live-channels` :2163-2186 — declararlo ANTES de `/spectrograms/{city_id}` :2212)
- Modify: `dashboard/lib/api.ts` (método `getStationCatalog()` junto a `getLiveChannels()` :131)
- Modify: `dashboard/lib/types.ts` (tipo `StationCatalogEntry`)
- Modify: `dashboard/components/WallManager.tsx:54-60` (el `catalog` pasa a salir del endpoint nuevo)
- Modify: `dashboard/components/WallBuilder.tsx` (el buscador existente filtra también por SCNL/estación/distancia; badge de "vivo")
- Modify: `dashboard/messages/es.json` y `en.json` (PARIDAD)
- Test: `tests/unit/test_station_catalog.py`, `dashboard/components/WallManager.test.tsx`

**Interfaces:**
- Consumes: `LIVE_CANDIDATES_BY_CITY` (`spectrogram_service.py:89-129`), `HIGH_RISK_SEISMIC_CITIES` con `lat`/`lon` (`dashboard/lib/seismic-cities.ts:10-11`), `fetch_active_channels` (`timescale_service.py:88`).
- Produces: `station_catalog(candidates_by_city, active_channels) -> list[dict]` con **una entrada por canal candidato** (75, no 27): `{"channel": "C1.MT14..BHZ", "city_id": "santiago", "station": "MT14", "network": "C1", "is_live": false, "is_primary": false}`; endpoint `GET /spectrograms/station-catalog`; tipo `StationCatalogEntry` en el front; `seismicAPI.getStationCatalog()`.

**Qué problema resuelve:** hoy el armador ofrece 27 canales — uno por ciudad, el que el failover eligió. Las otras 48 candidatas del catálogo **ya se están ingestando** (el ingestor se suscribe a todas, `channels_from_catalog` :286-312) pero son invisibles en la UI. Un usuario que quiere comparar dos estaciones de Santiago (MT05 vs MT14) no puede. Estilo SWARM: se lista TODO y el usuario elige; el badge "vivo" informa sin esconder.

- [ ] **Step 1: Write the failing backend test**

```python
# tests/unit/test_station_catalog.py
"""station_catalog expone TODAS las candidatas (75), no solo la ganadora
por ciudad que devuelve resolve_live_catalog (27)."""

from src.services.spectrogram_service import (
    LIVE_CANDIDATES_BY_CITY,
    station_catalog,
)

SAMPLE = {
    "santiago": ["C1.MT05..BHZ", "C1.MT14..BHZ"],
    "lima": ["II.NNA.00.BHZ"],
}


def test_devuelve_una_entrada_por_candidata():
    result = station_catalog(SAMPLE, active_channels=set())

    assert [e["channel"] for e in result] == [
        "C1.MT05..BHZ",
        "C1.MT14..BHZ",
        "II.NNA.00.BHZ",
    ]


def test_marca_primaria_solo_la_primera_de_cada_ciudad():
    result = station_catalog(SAMPLE, active_channels=set())
    by_channel = {e["channel"]: e for e in result}

    assert by_channel["C1.MT05..BHZ"]["is_primary"] is True
    assert by_channel["C1.MT14..BHZ"]["is_primary"] is False
    assert by_channel["II.NNA.00.BHZ"]["is_primary"] is True


def test_is_live_refleja_las_columnas_frescas():
    result = station_catalog(SAMPLE, active_channels={"C1.MT14..BHZ"})
    by_channel = {e["channel"]: e for e in result}

    assert by_channel["C1.MT14..BHZ"]["is_live"] is True
    assert by_channel["C1.MT05..BHZ"]["is_live"] is False


def test_sin_datos_de_frescura_nada_se_marca_vivo():
    # active_channels=None = "no se pudo consultar la base" (misma semántica
    # que resolve_live_catalog): se ofrece todo, sin mentir sobre frescura.
    result = station_catalog(SAMPLE, active_channels=None)

    assert len(result) == 3
    assert all(e["is_live"] is False for e in result)


def test_desglosa_red_y_estacion_del_scnl():
    result = station_catalog({"lima": ["II.NNA.00.BHZ"]}, active_channels=set())

    assert result[0]["network"] == "II"
    assert result[0]["station"] == "NNA"
    assert result[0]["city_id"] == "lima"


def test_el_catalogo_real_expone_mas_canales_que_ciudades():
    result = station_catalog(LIVE_CANDIDATES_BY_CITY, active_channels=set())

    assert len(result) > len(LIVE_CANDIDATES_BY_CITY)  # 75 vs 27
    assert len({e["channel"] for e in result}) == len(result)  # sin duplicados
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `./venv/bin/python -m pytest tests/unit/test_station_catalog.py -v --no-cov`
Expected: FAIL con `ImportError: cannot import name 'station_catalog'`

- [ ] **Step 3: Write the backend implementation**

En `src/services/spectrogram_service.py`, después de `resolve_live_catalog`:

```python
def station_catalog(
    candidates_by_city: Dict[str, List[str]], active_channels: Optional[set]
) -> List[Dict[str, object]]:
    """Catálogo COMPLETO de subestaciones: una entrada por candidata.

    resolve_live_catalog devuelve la ganadora de cada ciudad (lo que el
    dashboard consume por default); esto expone las 75 que el ingestor
    realmente está ingestando, para que el usuario elija subestación como
    en SWARM (comparar MT05 vs MT14 de Santiago, por ejemplo).

    `is_live` es informativo: una candidata muda se ofrece igual, con el
    badge en gris. active_channels=None ("no se pudo consultar la base",
    misma semántica que resolve_live_catalog) no marca nada como vivo en
    vez de mentir.
    """
    catalog: List[Dict[str, object]] = []
    for city_id, candidates in candidates_by_city.items():
        for index, channel in enumerate(candidates):
            parts = channel.split(".")
            catalog.append(
                {
                    "channel": channel,
                    "city_id": city_id,
                    "network": parts[0] if len(parts) > 0 else "",
                    "station": parts[1] if len(parts) > 1 else "",
                    "is_live": bool(active_channels) and channel in active_channels,
                    "is_primary": index == 0,
                }
            )
    return catalog
```

En `src/main.py`, junto a `/spectrograms/live-channels` (y ANTES de `/spectrograms/{city_id}`), replicando su manejo de Timescale ausente:

```python
@app.get("/spectrograms/station-catalog")
async def get_station_catalog() -> list[dict]:
    """Catálogo completo de subestaciones para el armador (PR-W3).

    Distinto de /live-channels: ese devuelve la ganadora por ciudad; este
    devuelve TODAS las candidatas ingestadas con su estado de frescura.
    """
    active = None
    if column_writer is not None:
        try:
            active = await column_writer.fetch_active_channels(LIVE_FRESHNESS_MINUTES)
        except Exception:
            logger.warning("station-catalog: no se pudo consultar frescura", exc_info=True)
    return station_catalog(LIVE_CANDIDATES_BY_CITY, active)
```
(Importar `station_catalog` junto a `resolve_live_catalog`. Copiar el patrón exacto de manejo de errores del endpoint `/live-channels` existente.)

- [ ] **Step 4: Run backend tests**

Run: `./venv/bin/python -m pytest tests/unit/test_station_catalog.py -v --no-cov`
Expected: 6 PASS

- [ ] **Step 5: Write the failing frontend test** (en `dashboard/components/WallManager.test.tsx`)

```tsx
it('el catálogo ofrece las subestaciones, no solo una por ciudad', async () => {
  // mock de getStationCatalog con dos candidatas de la misma ciudad
  renderManager({
    catalog: [
      { channel: 'C1.MT05..BHZ', city_id: 'santiago', network: 'C1', station: 'MT05', is_live: true, is_primary: true },
      { channel: 'C1.MT14..BHZ', city_id: 'santiago', network: 'C1', station: 'MT14', is_live: false, is_primary: false },
    ],
  });

  expect(await screen.findByText(/MT05/)).toBeInTheDocument();
  expect(screen.getByText(/MT14/)).toBeInTheDocument();
});

it('el buscador filtra por código de estación, no solo por ciudad', async () => {
  renderManager({ catalog: [/* mismas dos entradas */] });

  fireEvent.change(await screen.findByPlaceholderText(/buscar|search/i), {
    target: { value: 'MT14' },
  });

  expect(screen.queryByText(/MT05/)).toBeNull();
  expect(screen.getByText(/MT14/)).toBeInTheDocument();
});
```
(`renderManager` es el helper del archivo; usar `fireEvent`, NO `userEvent` — no está instalado en el repo, lección del W2.)

- [ ] **Step 6: Write the frontend implementation**

1. `dashboard/lib/types.ts`:
```typescript
/** Entrada del catálogo completo de subestaciones (PR-W3). */
export interface StationCatalogEntry {
  channel: string;
  city_id: string;
  network: string;
  station: string;
  is_live: boolean;
  is_primary: boolean;
}
```
2. `dashboard/lib/api.ts`: `getStationCatalog(): Promise<StationCatalogEntry[]>` → `GET /spectrograms/station-catalog`, con el mismo patrón de error que `getLiveChannels()`.
3. `dashboard/components/WallManager.tsx:54-60`: cambiar la SWR `walls-catalog` a `getStationCatalog()` y armar el `catalog: WallChannel[]` con label `"{Ciudad} · {STATION}"` (el label es lo que ve el usuario y lo que se persiste en el muro). Mantener el orden del backend (primarias primero dentro de cada ciudad) y **la primaria viva de cada ciudad arriba de todo** para no cambiar el flujo del usuario que solo quiere "la de Tokyo".
4. `dashboard/components/WallBuilder.tsx`: el buscador existente ("Search channel or city") debe matchear también contra `channel` y `station` (case-insensitive). Junto a cada candidata no viva, un punto gris; viva, verde — mismo lenguaje visual que el resto de la app. Claves i18n nuevas con paridad ES/EN para el placeholder actualizado y el tooltip del estado.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run components/WallManager.test.tsx components/WallBuilder.test.tsx && npx tsc --noEmit`
Expected: PASS + tsc limpio

- [ ] **Step 8: Verificación por mutación del filtro**

Mutar el buscador para que vuelva a matchear solo por ciudad: debe fallar `el buscador filtra por código de estación`. Revertir.

- [ ] **Step 9: Commit**

```bash
git add src/services/spectrogram_service.py src/main.py tests/unit/test_station_catalog.py dashboard/lib/api.ts dashboard/lib/types.ts dashboard/components/WallManager.tsx dashboard/components/WallBuilder.tsx dashboard/messages/es.json dashboard/messages/en.json dashboard/components/WallManager.test.tsx
git commit -m "feat(catalogo): subestaciones buscables en el armador (75 canales, no 27)"
```

---

### Task 13: Distancia a la ciudad en el catálogo (la "más cercana" de SWARM)

**Files:**
- Create: `dashboard/lib/station-distance.ts`
- Test: `dashboard/lib/station-distance.test.ts`
- Modify: `dashboard/components/WallManager.tsx` (ordenar por distancia dentro de cada ciudad), `dashboard/components/WallBuilder.tsx` (mostrar los km)

**Interfaces:**
- Consumes: `StationCatalogEntry` (Task 12), `HIGH_RISK_SEISMIC_CITIES` con `lat`/`lon` (`seismic-cities.ts:10-11, 24-25`).
- Produces: `haversineKm(aLat, aLon, bLat, bLon): number`; `STATION_COORDS: Record<string, {lat: number; lon: number}>`; `stationDistanceKm(entry: StationCatalogEntry): number | null`.

**Decisión de alcance (importante):** las coordenadas de las estaciones **no están en el repo** — hoy solo hay las de las ciudades. Pedirlas a FDSN en vivo agregaría una dependencia de red al armador, y el catálogo es fijo (75 canales verificados a mano, con las distancias ya anotadas en los comentarios de `spectrogram_service.py:74-88`). Por eso: **tabla estática `STATION_COORDS` en el front**, poblada desde los comentarios existentes del catálogo y completada con FDSN **una sola vez, a mano, al implementar**. Una estación sin coordenada devuelve `null` y se muestra sin km — nunca un número inventado.

- [ ] **Step 1: Write the failing tests**

```typescript
// dashboard/lib/station-distance.test.ts
import { describe, expect, it } from 'vitest';

import { haversineKm, stationDistanceKm } from './station-distance';

describe('haversineKm', () => {
  it('la distancia de un punto a sí mismo es cero', () => {
    expect(haversineKm(-33.4489, -70.6693, -33.4489, -70.6693)).toBe(0);
  });

  it('calcula una distancia conocida (Santiago–Valparaíso ≈ 100 km)', () => {
    const km = haversineKm(-33.4489, -70.6693, -33.0472, -71.6127);
    expect(km).toBeGreaterThan(90);
    expect(km).toBeLessThan(110);
  });

  it('es simétrica', () => {
    const ida = haversineKm(35.6762, 139.6503, -33.4489, -70.6693);
    const vuelta = haversineKm(-33.4489, -70.6693, 35.6762, 139.6503);
    expect(Math.abs(ida - vuelta)).toBeLessThan(0.001);
  });

  it('cruza el antimeridiano por el lado corto', () => {
    // 179.9E a 179.9W son 0.2 grados de longitud, ~22 km en el ecuador,
    // NO 359.8 grados. Es el bug clásico de restar longitudes a lo bruto.
    const km = haversineKm(0, 179.9, 0, -179.9);
    expect(km).toBeLessThan(50);
  });
});

describe('stationDistanceKm', () => {
  const entry = {
    channel: 'C1.VA01..BHZ',
    city_id: 'valparaiso',
    network: 'C1',
    station: 'VA01',
    is_live: true,
    is_primary: true,
  };

  it('devuelve los km entre la estación y su ciudad', () => {
    const km = stationDistanceKm(entry);
    expect(km).not.toBeNull();
    expect(km!).toBeLessThan(20); // VA01 está a ~4 km de Valparaíso
  });

  it('sin coordenada de la estación devuelve null (nunca un número inventado)', () => {
    expect(stationDistanceKm({ ...entry, channel: 'XX.NADA..HHZ', station: 'NADA' })).toBeNull();
  });

  it('sin ciudad conocida devuelve null', () => {
    expect(stationDistanceKm({ ...entry, city_id: 'atlantis' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd dashboard && npx vitest run lib/station-distance.test.ts`
Expected: FAIL (módulo inexistente)

- [ ] **Step 3: Write the implementation**

```typescript
// dashboard/lib/station-distance.ts
/**
 * Distancia estación ↔ ciudad para el armador (PR-W3, "la más cercana" de
 * SWARM).
 *
 * Tabla estática y no una consulta FDSN a propósito: el catálogo son 75
 * canales fijos verificados a mano (ver los comentarios de
 * spectrogram_service.py, que ya anotan varias de estas distancias), y
 * meterle una llamada de red al armador para un dato inmutable no se paga.
 * Una estación sin coordenada devuelve null: se muestra sin km, nunca con
 * un número inventado.
 */

import { HIGH_RISK_SEISMIC_CITIES } from './seismic-cities';
import type { StationCatalogEntry } from './types';

const EARTH_RADIUS_KM = 6371;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function haversineKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const dLat = toRadians(bLat - aLat);
  // Normalizar la diferencia de longitud a [-180, 180]: sin esto, cruzar
  // el antimeridiano da 359.8° en vez de 0.2°.
  let dLonDeg = bLon - aLon;
  if (dLonDeg > 180) dLonDeg -= 360;
  if (dLonDeg < -180) dLonDeg += 360;
  const dLon = toRadians(dLonDeg);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(aLat)) * Math.cos(toRadians(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Coordenadas de las estaciones del catálogo, por código de estación.
 * IMPORTANTE al implementar: completar esta tabla con los 75 canales de
 * LIVE_CANDIDATES_BY_CITY consultando FDSN UNA vez (station service de
 * IRIS/EarthScope) y pegando los valores acá. Lo que no se complete queda
 * fuera y se muestra sin km.
 */
export const STATION_COORDS: Record<string, { lat: number; lon: number }> = {
  VA01: { lat: -33.02, lon: -71.63 },
  // … completar el resto al implementar …
};

const CITY_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c]));

export function stationDistanceKm(entry: StationCatalogEntry): number | null {
  const station = STATION_COORDS[entry.station];
  const city = CITY_BY_ID.get(entry.city_id);
  if (!station || !city) return null;
  return Math.round(haversineKm(city.lat, city.lon, station.lat, station.lon));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd dashboard && npx vitest run lib/station-distance.test.ts && npx tsc --noEmit`
Expected: 7 PASS + tsc limpio

- [ ] **Step 5: Verificación por mutación de la distancia**

1. Quitar la normalización del antimeridiano — debe fallar `cruza el antimeridiano por el lado corto`.
2. Cambiar `Math.cos(toRadians(aLat))` por `1` — debe fallar la distancia conocida Santiago–Valparaíso.
3. Hacer que `stationDistanceKm` devuelva `0` en vez de `null` cuando falta la coordenada — deben fallar los dos tests de `null`.

- [ ] **Step 6: Integrar en el armador**

En `WallManager.tsx`: dentro de cada ciudad, ordenar las candidatas por distancia ascendente (las sin coordenada, al final); las primarias vivas siguen arriba de todo.
En `WallBuilder.tsx`: mostrar `· {km} km` junto al SCNL cuando `stationDistanceKm` no es null. El buscador ya matchea por estación (Task 12).

- [ ] **Step 7: Run the frontend suite**

Run: `cd dashboard && npx vitest run && npx tsc --noEmit`
Expected: todo PASS + tsc limpio

- [ ] **Step 8: Commit**

```bash
git add dashboard/lib/station-distance.ts dashboard/lib/station-distance.test.ts dashboard/components/WallManager.tsx dashboard/components/WallBuilder.tsx
git commit -m "feat(catalogo): distancia estacion-ciudad y orden por cercania"
```

---

### Task 9: Verificación final, rama y PR

**Files:**
- Ninguno nuevo — verificación y entrega.

- [ ] **Step 1: Suites completas, con zona horaria hostil**

```bash
./venv/bin/python -m pytest tests/ --no-cov -q 2>&1 | tail -5
cd dashboard && TZ=Asia/Tokyo npx vitest run 2>&1 | tail -5 && npx tsc --noEmit
```
Expected: todo PASS, tsc limpio. La `TZ` hostil es deliberada: con el runner en UTC, los tests de UTC pasarían sin probar nada.

- [ ] **Step 2: Verificación anti-regresión del contrato**

- El payload de `spec:{channel}` NO cambió (el frontend del canvas y TimescaleDB siguen intactos): `rg -n '"spec:' src/services/seedlink_ingestor.py` y revisar que `_compute_column` esté sin tocar.
- `validate_wall_layout` (`wall_service.py:104`) sigue aceptando `showMetrics` — correr `./venv/bin/python -m pytest tests/unit/test_wall_layout_validation.py -v --no-cov`.
- `/spectrograms/live-channels` sigue devolviendo UNA por ciudad (el catálogo nuevo es un endpoint aparte, no un cambio de contrato): `./venv/bin/python -m pytest tests/unit/test_spectrogram_service.py -v --no-cov`.
- Los muros guardados con el catálogo viejo siguen abriendo: los `WallChannel` persistidos guardan `{channel,label}` propios, así que un label nuevo ("Santiago · MT05") NO reescribe los existentes. Verificar cargando un muro creado antes del cambio.

- [ ] **Step 3: QA manual de las tres superficies** (2 minutos)

1. `/spectrograms-live?tab=cards`: la fila de métricas reemplaza el badge de riesgo en las tarjetas vivas.
2. `/spectrograms-live?tab=wall`: buscar "MT" en el armador debe listar varias subestaciones de Santiago con sus km; activar "Mostrar métricas", guardar.
3. `/globe` → cartelera (ícono de grilla): la banda `RSAM · FI · lat` aparece en las tiras, y las horas visibles dicen UTC.

- [ ] **Step 4: PR**

```bash
git checkout -b feat/spectronet-wall-w3   # si no se creó al arrancar
git push -u origin feat/spectronet-wall-w3
gh pr create --title "feat(metricas): RSAM, FI, catálogo de subestaciones y UTC (PR-W3)" --body "Implementa el §3 del spec del muro SPECTRONET más dos pedidos del usuario.

Métricas: el ingestor deriva RSAM (paridad SWARM 600s), frecuencia dominante, FI, pico dB, eventos/hora y latencia de datos ya en mano (anti-OOM PR #25), publica metrics:{canal} + snapshot TTL 60s, y la API los sirve con GET /stations/{channel}/metrics y batch. Frontend: fila completa en tarjetas y banda compacta en tiras del muro gated por showMetrics, con polling batch cada 15s.

Subestaciones: nuevo GET /spectrograms/station-catalog expone las 75 candidatas que el ingestor ya ingesta (antes la UI solo veía las 27 ganadoras del failover); el armador las busca por ciudad, red o código de estación y las ordena por cercanía.

UTC: formatDateTimeCompact y los formats de next-intl pasan a UTC — antes formateaban en la zona del navegador junto a carteles que decían 'UTC'. Seguimiento pendiente: rotular con el sufijo UTC las vistas fuera del alcance de este PR (GlobeEventPanel, paneles de admin, mapas), que ya quedaron en UTC por el cambio de formats."
```
Esperar checks en verde. Squash merge con el título del PR (patrón de la serie).

---

## Orden de ejecución

Tasks 1 → 8 (métricas, el §3 del spec), luego 10 → 13 (los dos pedidos del usuario del 2026-08-21), y Task 9 cierra con la verificación y el PR. Las Tasks 10-13 son independientes de 1-8: si se ejecutan en paralelo con worktrees, cuidado con los tres archivos compartidos (`messages/es.json`, `messages/en.json`, `WallBuilder.tsx`).

## Self-Review (hecho al escribir el plan)

- **Cobertura del spec §3**: RSAM (T1), freq dominante/FI/pico dB (T2), eventos/hora (T1), latencia (T6, client-side de `endtime`), canal Redis `metrics:{channel}` (T4), `GET /stations/{channel}/metrics` (T5), fila en tarjeta (T7), banda en tira con `showMetrics` (T8). Decisión de diseño fino que el spec delegaba: polling batch, no WS nuevo.
- **Cobertura de los pedidos del usuario (2026-08-21)**: subestaciones buscables estilo SWARM (T12: catálogo de 75 + buscador por estación; T13: distancia y orden por cercanía); todo en UTC (T10: el fix de raíz en `formatDateTimeCompact` y los formats de next-intl; T11: el rótulo visible).
- **Tipos consistentes**: el payload de métricas usa `freq_hz`/`events_hour` en TODAS las capas (ingestor T4, API T5, `StationMetrics` T6, componentes T7/T8). `StationCatalogEntry` (T12) usa `city_id`/`is_live`/`is_primary` en backend y frontend por igual, y T13 lo consume sin cambiarlo.
- **Restricción OOM**: las métricas usan el slice del buffer (≤4 s de señal) y las listas de la columna ya publicada; ningún endpoint recomputa espectros. El catálogo de subestaciones es un dict en memoria, sin costo.
- **Nota para el implementador de T4**: la firma real de `SeedLinkIngestor.__init__` manda — ajustar la construcción de los tests a los argumentos existentes (bus/column_writer/watchdog) en vez de copiar a ciegas los ejemplos.
- **Nota para el implementador de T10**: es esperable que algún test existente asumiera hora local y se ponga rojo. Se arregla el test (esperar UTC), no el fix.
- **Nota para el implementador de T13**: `STATION_COORDS` llega incompleta a propósito — completar los 75 canales consultando FDSN una vez, y dejar fuera lo que no se pueda verificar (devuelve `null` y se muestra sin km).
