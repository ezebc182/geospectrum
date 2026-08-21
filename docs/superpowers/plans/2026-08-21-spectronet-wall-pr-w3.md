# PR-W3 — Métricas por canal (RSAM · FI · pico dB · eventos/h · latencia): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El ingestor calcula métricas de dominio por canal (RSAM, frecuencia dominante, Frequency Index, pico dB, eventos/hora) y las distribuye vía Redis; el dashboard las muestra como fila completa en las tarjetas de `/spectrograms-live` y como banda compacta en las tiras del muro cuando `showMetrics` está activo.

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
- TDD estricto; **verificación por mutación** en los detectores (countEvents) y en el Frequency Index.
- Tests backend: `./venv/bin/python -m pytest <ruta> -v --no-cov` (venv en `venv/`, NO `.venv/`; Docker arriba para testcontainers). Frontend: `cd dashboard && npx vitest run` y SIEMPRE `npx tsc --noEmit` (vitest no chequea tipos, `next build` sí).
- La publicación de métricas es best-effort: un fallo de métricas JAMÁS debe frenar la ingesta de columnas.

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

### Task 9: Verificación final, rama y PR

**Files:**
- Ninguno nuevo — verificación y entrega.

- [ ] **Step 1: Suites completas**

```bash
./venv/bin/python -m pytest tests/ --no-cov -q 2>&1 | tail -5
cd dashboard && npx vitest run 2>&1 | tail -5 && npx tsc --noEmit
```
Expected: todo PASS, tsc limpio.

- [ ] **Step 2: Verificación anti-regresión del contrato**

- El payload de `spec:{channel}` NO cambió (el frontend del canvas y TimescaleDB siguen intactos): `rg -n '"spec:' src/services/seedlink_ingestor.py` y revisar que `_compute_column` esté sin tocar.
- `validate_wall_layout` (`wall_service.py:104`) sigue aceptando `showMetrics` — correr `./venv/bin/python -m pytest tests/unit/test_wall_layout_validation.py -v --no-cov`.

- [ ] **Step 3: PR**

```bash
git checkout -b feat/spectronet-wall-w3   # si no se creó al arrancar
git push -u origin feat/spectronet-wall-w3
gh pr create --title "feat(metricas): RSAM, FI y métricas por canal en tarjetas y muro (PR-W3)" --body "Implementa el §3 del spec del muro SPECTRONET: el ingestor deriva RSAM (paridad SWARM 600s), frecuencia dominante, FI, pico dB, eventos/hora y latencia de datos ya en mano (anti-OOM PR #25), publica metrics:{canal} + snapshot TTL 60s, y la API los sirve con GET /stations/{channel}/metrics y batch. Frontend: fila completa en tarjetas de /spectrograms-live y banda compacta en tiras del muro gated por showMetrics, con polling batch cada 15s."
```
Esperar checks en verde. Squash merge con el título del PR (patrón de la serie).

---

## Self-Review (hecho al escribir el plan)

- **Cobertura del spec §3**: RSAM (T1), freq dominante/FI/pico dB (T2), eventos/hora (T1), latencia (T6, client-side de `endtime`), canal Redis `metrics:{channel}` (T4), `GET /stations/{channel}/metrics` (T5), fila en tarjeta (T7), banda en tira con `showMetrics` (T8). Decisión de diseño fino que el spec delegaba: polling batch, no WS nuevo.
- **Tipos consistentes**: el payload JSON usa `freq_hz`/`events_hour` en TODAS las capas (ingestor T4, API T5, `StationMetrics` T6, componentes T7/T8).
- **Restricción OOM**: las métricas usan el slice del buffer (≤4 s de señal) y las listas de la columna ya publicada; ningún endpoint recomputa espectros.
- **Nota para el implementador de T4**: la firma real de `SeedLinkIngestor.__init__` manda — ajustar la construcción de los tests a los argumentos existentes (bus/column_writer/watchdog) en vez de copiar a ciegas los ejemplos.
