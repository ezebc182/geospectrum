# Design: Watchdog Externo de Servicios en Railway

## Technical Approach

Nuevo proceso Python standalone (`src/services/watchdog.py`), calcado en su forma de arranque de `seedlink_ingestor.py` / `events_ingestor.py`: `asyncio.run(_main())` en `if __name__ == "__main__":`, sin servidor HTTP ni puerto expuesto. El loop principal corre 4 chequeos independientes cada `WATCHDOG_INTERVAL_SECONDS` (default 300), cada uno envuelto en su propio `try/except` (mismo criterio que `disk_alert.py:85-90`): un chequeo que revienta no debe tumbar a los otros tres ni al ciclo siguiente.

Cada chequeo produce un resultado binario `up`/`down`. Ese resultado se compara contra el último estado conocido, persistido en Redis (`WatchdogStateStore`, nuevo, mismo cliente `redis.asyncio` y mismo estilo de `MetricsStore`). Solo se notifica por ntfy en las **transiciones** (`up→down` o `down→up`), nunca en cada ciclo mientras el estado se mantiene — así se cumple "sin reintentos, pero sin spam" sin necesitar lógica de reintento alguna: el ciclo de 5 minutos ES el reintento natural, y la transición ES la deduplicación.

El heartbeat de `events_ingestor.py` se agrega como una `asyncio.Task` más dentro de `asyncio.gather()`, en su propio `try/except` infinito que jamás propaga — un fallo ahí se loguea y se reintenta el próximo ciclo, exactamente como ya hace `disk_alert.py` con su propio ciclo.

## Architecture Decisions

### Decision: Umbral de "seedlink_ingestor caído" = 600 segundos

**Choice**: `WATCHDOG_SEEDLINK_STALE_AFTER_SECONDS = 600` (10 minutos), un valor propio del watchdog, distinto de las dos constantes internas de `seedlink_ingestor.py`.

**Alternatives considered**:
- `STALE_AFTER_SECONDS=300` (el umbral interno de "canal individual mudo, forzar reconexión"): descartado porque es la métrica de UN canal, no de "todos los canales". Además, a 300s coincide con exactamente 1 ciclo del watchdog (también 300s) — un solo ciclo de mala suerte (el watchdog corre justo cuando el ingestor está a mitad de una reconexión normal) dispararía un falso positivo en cada reconexión rutinaria, que según el propio proposal "SeedLink cae de a ratos y es normal".
- `GIVE_UP_AFTER_SECONDS=900` (el umbral interno de "me rindo y exploto con RuntimeError"): descartado porque usar el MISMO valor anula el propósito del watchdog. El caso que el proposal pide cubrir es el "falso vivo" — el proceso colgado SIN levantar la excepción. Si el watchdog esperara los mismos 900s, en el caso feliz (el ingestor sí se mata solo y Railway lo reinicia) el watchdog notificaría casi al mismo tiempo que ya se resolvió solo, y en el caso patológico (el proceso está vivo pero trabado antes de llegar a esa comprobación, p. ej. bloqueado en `client.run()` sin recibir jamás el `terminate()`) se pierden 900s adicionales de opacidad.
- Valor propio de 600s (2 ciclos del watchdog): elegido porque da margen a una reconexión completa (`RECONNECT_DELAY_SECONDS=5` + tiempo de negociación SeedLink, todo del orden de segundos) sin nunca coincidir con exactamente 1 ciclo de chequeo, y **alerta antes** que el propio `GIVE_UP_AFTER_SECONDS=900` — cubriendo la ventana donde el ingestor sigue vivo, no llegó a rendirse, pero ya no está produciendo nada útil.

**Rationale**: 600s es menor que 900s (alerta temprano, antes de que Railway vea siquiera un reinicio) y mayor que 300s + margen operativo (no confunde una reconexión normal con una caída). Es un valor NUEVO y explícito en `settings.py`, no una referencia cruzada a constantes internas de otro módulo — desacopla al watchdog de cambios futuros en `seedlink_ingestor.py`.

### Decision: Heartbeat de `events_ingestor` como tarea paralela dentro del mismo `asyncio.gather()`

**Choice**: Agregar una tercera corrutina al `asyncio.gather()` existente en `EventsIngestor.run()` (hoy `asyncio.gather(self.emsc.run(), self.usgs.run())` pasa a `asyncio.gather(self.emsc.run(), self.usgs.run(), self._heartbeat_loop())`). `_heartbeat_loop()` escribe una key en Redis cada `WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS` (default 60s, igual al poll de USGS) con TTL `WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS` (default 180s = 3x intervalo, mismo margen 3x que ya usa `fdsn_warmup` entre ciclo y TTL).

**Alternatives considered**:
- `asyncio.create_task()` suelto (no dentro del `gather`): descartado. Si `_heartbeat_loop()` lanzara una excepción no atrapada, una Task suelta sin `await` la pierde en silencio (unhandled exception en el loop, visible solo como warning de asyncio) — peor que fallar visiblemente. Meterla en el `gather()` la sujeta al mismo ciclo de vida que EMSC/USGS.
- Escribir el heartbeat en `handle_event()` (cada evento recibido): descartado explícitamente por el proposal — el heartbeat debe ser independiente de si hubo sismos, para no repetir el error ya documentado con `EventStore.stats()`.
- **Riesgo real que exige neutralizarlo**: si `_heartbeat_loop()` propaga CUALQUIER excepción, `asyncio.gather()` sin `return_exceptions=True` cancela las otras dos corrutinas (EMSC/USGS) inmediatamente — el heartbeat tumbaría la ingesta real, exactamente lo que el proposal prohíbe. Por eso `_heartbeat_loop()` es un `while True` con su try/except propio alrededor de CADA escritura a Redis (nunca alrededor del `while` entero, para que seguir corriendo no dependa de que el `except` no tenga un bug); solo un `asyncio.CancelledError` se re-propaga (igual que `EventsIngestor.run()` ya hace), todo lo demás se loguea con `logger.warning(..., exc_info=True)` y se reintenta en el próximo ciclo. Nunca hace `raise` fuera de ese manejo — jamás compite con el `raise RuntimeError` del `__main__`, que sigue disparándose solo si `gather()` vuelve (heartbeat incluido) sin que medie shutdown.

**Rationale**: Reutiliza el mecanismo de fallo ya probado del proceso (`gather` + `CancelledError` explícito) sin tocar la semántica de "si `run()` vuelve, es un fallo". Un heartbeat que se cae solo (por Redis caído) se degrada a "no logueo nada nuevo, reintento en 60s" sin afectar EMSC/USGS ni disparar el `RuntimeError` de cierre del proceso.

### Decision: Esquema de Redis — JSON con status+timestamp, TTL solo en el heartbeat de eventos

**Choice**: Dos familias de keys, ambas con el prefijo `watchdog:`:

- `watchdog:state:{componente}` → estado PROPIO del watchdog sobre cada uno de los 4 componentes (`api`, `ui`, `seedlink`, `events`). Valor: JSON `{"status": "up"|"down", "since": "<ISO8601 UTC>"}`. **Sin TTL** — debe sobrevivir indefinidamente mientras el componente siga caído, incluso si eso dura días; expirarlo por accidente perdería la deduplicación y el cálculo de duración de la caída.
- `events_ingestor:heartbeat` → la única key que escribe `events_ingestor.py` (no el watchdog). Valor: timestamp ISO8601 UTC plano (no hace falta JSON, es un solo campo). **Con TTL** de `WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS` (180s) — su ausencia (expiró) o vejez es la señal de "colgado"; TTL nativo de Redis reemplaza cualquier lógica de limpieza manual.

**Alternatives considered**:
- Keys separadas por campo (`watchdog:state:{c}:status`, `watchdog:state:{c}:since`): descartado, dos GETs no-atómicos por componente introducen una ventana de inconsistencia sin beneficio — el patrón ya establecido en el proyecto (`MetricsStore.set_snapshot`) usa un único blob JSON por key.
- TTL en `watchdog:state:{componente}`: descartado. Si expirara mientras el componente sigue caído (una caída de 2+ horas con un TTL corto, o el watchdog mismo reiniciándose), el watchdog "olvidaría" que ya notificó y reenviaría la alerta de caída como si fuera nueva — comportamiento indistinguible de un bug, y contrario a "no re-notificar mientras sigue caída".

**Rationale**: Reutiliza exactamente el patrón `SET`/`GET` con JSON de `MetricsStore`, con la única diferencia deliberada (sin TTL) justificada por la semántica distinta: `MetricsStore` cachea un valor que debe caducar si nadie lo renueva; `watchdog:state` es el registro de un incidente que debe persistir mientras dure.

### Decision: Redis caído → notificar igual, degradando SIN estado (ya decidido por el usuario, aquí solo el mecanismo)

**Choice**: `WatchdogStateStore.get_state()` / `set_state()` atrapan cualquier excepción de Redis y devuelven/aceptan `None` en vez de propagar. El loop principal, al no poder leer el estado anterior, trata cada chequeo `down` como si fuera una transición `up→down` (notifica) y cada `up` NO genera notificación de "recuperación" (no hay "since" del cual calcular duración, y no hay evidencia de que antes estuviera caído). Esto es exactamente lo que el proposal ya pidió ("notificar igual, sin poder deduplicar") — el diseño solo fija que la ausencia de Redis hace que el watchdog notifique cada `down` en cada ciclo (spam aceptado) pero nunca notifique una "recuperación" fantasma.

**Rationale**: Evita el peor escenario silencioso (que un fallo de Redis apague las alertas) al costo aceptado de spam, sin inventar un estado en memoria del proceso que se perdería igual en cada restart de Railway.

### Decision: Mensaje de ntfy — título por componente, tags distintivos, prioridad diferenciada

**Choice**: Un único helper `_notify_ntfy(component, event, extra)` con:

| Componente | Tag ntfy | Nombre en el título |
|---|---|---|
| `api` | `rotating_light` | API |
| `ui` | `globe_with_meridians` | Dashboard (UI) |
| `seedlink` | `satellite` | SeedLink (ingesta en vivo) |
| `events` | `earth_americas` | Ingesta de eventos sísmicos |

- **Caída**: `Title: "GeoSpectrum watchdog: {Nombre} CAÍDO"`, `Priority: urgent`, `Tags: "warning,{tag}"`, body con el detalle del chequeo (código HTTP, o "sin datos de ningún canal", o "heartbeat vencido hace Ns").
- **Recuperación**: `Title: "GeoSpectrum watchdog: {Nombre} recuperado"`, `Priority: default`, `Tags: "white_check_mark,{tag}"`, body con la duración de la caída (`"estuvo caído Xm Ys"`) si se pudo calcular (Redis disponible), o `"volvió a responder (duración desconocida — Redis no disponible durante la caída)"` si no.

**Alternatives considered**: un solo topic/mensaje genérico "algo está mal, revisar logs": descartado explícitamente por el proposal, que pide poder distinguir los 4 componentes desde el celular sin abrir logs.

**Rationale**: Sigue el tono de `disk_alert.py` (título accionable, prioridad urgent, tags de emoji ntfy) pero con tag e identificador únicos por componente — el operador sabe QUÉ se cayó con solo leer la notificación push, sin abrir la app.

### Decision: Nombres de settings nuevos

**Choice** (siguiendo el patrón `disk_alert_*` / `fdsn_warmup_*` de `settings.py:74-103`):

```python
watchdog_enabled: bool = False
watchdog_ntfy_topic_url: Optional[str] = None
watchdog_interval_seconds: int = 300
watchdog_api_url: str = "https://api.geospectrum.org/health"
watchdog_ui_url: Optional[str] = None
watchdog_api_timeout_s: float = 10.0
watchdog_ui_timeout_s: float = 10.0
watchdog_seedlink_stale_after_seconds: int = 600
watchdog_events_heartbeat_ttl_seconds: int = 180
```

Más, en `events_ingestor.py` (no en `watchdog.py`, porque lo escribe ESE proceso):
```python
watchdog_events_heartbeat_interval_seconds: int = 60
```

**Rationale**: `watchdog_enabled` sigue el mismo patrón opt-in de `disk_alert_enabled`/`fdsn_warmup_enabled` — permite desactivar el chequeo entero sin quitar el servicio de Railway (rollback rápido vía env var, tal como pide el proposal). `watchdog_ui_url` es `Optional[str] = None` (no un default hardcodeado): sin configurarlo, ese chequeo específico se salta con un `logger.info` (igual criterio que `google_client_id` opcional), no bloquea a los otros tres. Todas las `*_timeout_s` siguen la convención ya usada (`usgs_timeout_s`, `inpres_timeout_s`) de sufijo `_s` para floats en segundos.

### Decision: Selección del Dockerfile en Railway

**Choice**: Documentar en el design (no hay código a leer para esto — es config de infraestructura) que Railway NO lee `RAILWAY_DOCKERFILE_PATH` de ningún archivo del repo: es una variable de entorno que se configura por servicio en el dashboard de Railway (Settings → Build → Dockerfile Path), igual que ya está seteada para los servicios `seedlink` y `events-worker` existentes (confirmado por los comentarios en cabecera de `Dockerfile.seedlink` y `Dockerfile.events-worker`, que documentan la selección pero no la definen — la definición vive en la config del proyecto de Railway, fuera del repo).

**Rationale**: No hay una variable `RAILWAY_DOCKERFILE_PATH` declarada en `settings.py` ni en `.env.example` porque Railway la consume ANTES de que el contenedor exista — es config de build, no config de runtime de la app. Se documenta el paso manual en "Migration / Rollout" más abajo.

## Data Flow

```
                     ┌─────────────────────────────────────────┐
                     │   watchdog.py  (proceso standalone)      │
                     │   loop cada WATCHDOG_INTERVAL_SECONDS    │
                     └─────────────────────────────────────────┘
                                       │
        ┌──────────────┬──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
   check_api()     check_ui()   check_seedlink()  check_events()
   GET /health     GET ui_url   fetch_active_      GET events_ingestor:
   (httpx)         (httpx)      channels()         heartbeat (redis)
        │              │        (asyncpg, RO)           │
        │              │              │                  │
        └──────────────┴──────┬───────┴──────────────────┘
                               ▼
                    resultado por componente: up | down
                               │
                               ▼
              WatchdogStateStore.get_state(componente)  (redis)
                               │
              ┌────────────────┴────────────────┐
              ▼                                  ▼
        sin cambio de estado              transición detectada
        (no notifica)                     (up→down o down→up)
                                                  │
                                                  ▼
                                     WatchdogStateStore.set_state(...)
                                                  │
                                                  ▼
                                     POST ntfy topic (httpx)


   events_ingestor.py (proceso aparte, YA corriendo):
        asyncio.gather(emsc.run(), usgs.run(), _heartbeat_loop())
                                                  │
                                                  ▼
                              SET events_ingestor:heartbeat <ts> EX 180
                              (cada 60s, try/except propio, nunca propaga)
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `src/services/watchdog.py` | Create | Loop principal: 4 funciones de chequeo (`check_api`, `check_ui`, `check_seedlink`, `check_events`), `WatchdogStateStore` (get/set state en Redis), `_notify_ntfy`, `run_watchdog_loop()` con el mismo patrón `stop_event` esperado que `disk_alert.py:75-94`, y `__main__` standalone (conecta Redis + asyncpg RO, arranca el loop, `asyncio.run`) |
| `deploy/docker/Dockerfile.watchdog` | Create | Calco de `Dockerfile.seedlink`: mismo `requirements.txt`, mismo `COPY` de `dashboard/lib/seismic-constants.json` (no es necesario para el watchdog en sí, pero cualquier import transitivo de `src.services.timescale_service` u otros módulos que lo carguen al importar exige tenerlo — verificar en implementación si `watchdog.py` puede evitar esa cadena de imports; si no, mantener el `COPY` por seguridad), `CMD ["python", "-m", "src.services.watchdog"]` |
| `src/services/events_ingestor.py` | Modify | Agregar método `_heartbeat_loop()` a `EventsIngestor`, sumarlo al `asyncio.gather()` de `run()`. Requiere inyectar un cliente Redis (`redis.asyncio`) — mismo criterio que `metrics_store` en `seedlink_ingestor.py`: se pasa por constructor, conectado en el `__main__` antes de instanciar `EventsIngestor` |
| `src/config/settings.py` | Modify | Agregar el bloque `watchdog_*` (ver Decision de settings arriba), comentado con el mismo estilo narrativo que el bloque `disk_alert_*` (:86-103) |
| `.env.example` | Modify | Documentar las variables nuevas: `WATCHDOG_ENABLED`, `WATCHDOG_NTFY_TOPIC_URL`, `WATCHDOG_INTERVAL_SECONDS`, `WATCHDOG_API_URL`, `WATCHDOG_UI_URL`, `WATCHDOG_SEEDLINK_STALE_AFTER_SECONDS`, `WATCHDOG_EVENTS_HEARTBEAT_TTL_SECONDS`, `WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS` |
| `src/services/timescale_service.py` | Read-only (reused) | `fetch_active_channels(minutes)` invocado desde `check_seedlink()` sin modificar el archivo |
| Railway (dashboard, fuera del repo) | New | Servicio `watchdog` nuevo: `RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.watchdog`, variables de entorno (ver Migration / Rollout), sin puerto expuesto (igual que `seedlink`/`events-worker`) |

## Interfaces / Contracts

```python
# src/services/watchdog.py

COMPONENTS = ("api", "ui", "seedlink", "events")

class CheckResult:
    up: bool
    detail: str  # para el body de ntfy: "HTTP 503", "sin datos de 3/3 canales", etc.

class WatchdogStateStore:
    """Estado persistido en Redis. None si Redis no responde (degradación)."""
    async def get_state(self, component: str) -> Optional[dict]:  # {"status": "up"|"down", "since": iso8601}
        ...
    async def set_state(self, component: str, status: str, since: str) -> None:
        ...

async def check_api(client: httpx.AsyncClient, url: str, timeout: float) -> CheckResult: ...
async def check_ui(client: httpx.AsyncClient, url: str, timeout: float) -> CheckResult: ...
async def check_seedlink(
    pool: asyncpg.Pool, stale_after_s: int, expected_channels: list[str]
) -> CheckResult: ...
async def check_events(redis_client, ttl_grace_s: int = 0) -> CheckResult:
    """down si la key events_ingestor:heartbeat no existe (expiró o nunca se escribió)."""
    ...

async def evaluate_and_notify(
    component: str, result: CheckResult, store: WatchdogStateStore, ntfy_topic_url: str
) -> None:
    """Compara contra el estado persistido, notifica SOLO en transición."""
    ...
```

```python
# src/services/events_ingestor.py (nuevo método en EventsIngestor)

async def _heartbeat_loop(self) -> None:
    """
    while True; cada watchdog_events_heartbeat_interval_seconds escribe
    'events_ingestor:heartbeat' = now().isoformat() con EX =
    watchdog_events_heartbeat_ttl_seconds. Try/except alrededor de CADA
    escritura (no del while): un fallo se loguea y se reintenta el próximo
    ciclo. Solo asyncio.CancelledError se re-propaga.
    """
```

Redis, valores concretos:
```
watchdog:state:api      -> '{"status": "down", "since": "2026-08-30T14:05:00+00:00"}'   (sin TTL)
watchdog:state:ui       -> '{"status": "up",   "since": "2026-08-30T09:00:00+00:00"}'   (sin TTL)
watchdog:state:seedlink -> '{"status": "up",   "since": "2026-08-30T08:00:00+00:00"}'   (sin TTL)
watchdog:state:events   -> '{"status": "up",   "since": "2026-08-30T08:00:00+00:00"}'   (sin TTL)
events_ingestor:heartbeat -> "2026-08-30T14:10:03+00:00"                                (TTL 180s)
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `evaluate_and_notify`: no notifica en `up→up` ni `down→down`; notifica en ambas transiciones; con `store` que simula Redis caído (`get_state`/`set_state` devuelven `None`/no-op), notifica `down` siempre y nunca `recuperación` | pytest + mocks de `WatchdogStateStore` y de `httpx.AsyncClient.post` (capturar el payload) |
| Unit | `check_seedlink`: todos los canales activos ausentes del resultado de `fetch_active_channels` con antigüedad > umbral → `down`; un canal individual ausente pero el resto presente → `up` | mock de `asyncpg.Pool`/`fetch_active_channels` devolviendo distintos subconjuntos |
| Unit | `check_events`: key ausente → `down`; key presente y reciente → `up` | mock de cliente Redis (`redis.asyncio`) |
| Unit | `EventsIngestor._heartbeat_loop`: una excepción en `redis.set()` no propaga fuera del loop ni cancela `gather()` | test con un stub de Redis que lanza en la primera llamada y responde bien en la segunda; verificar que el loop sigue vivo |
| Integration | `run_watchdog_loop` completo contra un Redis real (testcontainer, mismo patrón ya usado en el proyecto — ver memoria "tests-integracion-usan-testcontainer") y un servidor `httpx` local simulando `/health` caído/vivo | Simular una caída → recuperación completa y verificar las 2 notificaciones (mock del POST a ntfy) y el estado final en Redis |
| Manual (no automatizable) | Notificación real llega al celular con el formato esperado por los 4 componentes | El usuario, suscripto al topic ntfy, provoca cada caída real (apagar el servicio api en Railway, cortar la UI, etc.) — ver Success Criteria del proposal |

## Migration / Rollout

No hay migración de base de datos (reutiliza `spectrogram_columns` existente, sin escritura). Rollout:

1. Mergear el código (`watchdog.py`, `Dockerfile.watchdog`, cambios en `events_ingestor.py` y `settings.py`).
2. En el dashboard de Railway, crear un servicio nuevo `watchdog` en el mismo proyecto:
   - `RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.watchdog`
   - Variables de entorno compartidas ya existentes en el proyecto: `TIMESCALEDB_HOST/PORT/DB/USER/PASSWORD` (mismo DSN de solo lectura, sin permisos de escritura adicionales — no requiere un usuario de Postgres nuevo, alcanza con el mismo rol si solo hace `SELECT`), `REDIS_URL`.
   - Variables nuevas propias del watchdog: `WATCHDOG_ENABLED=true`, `WATCHDOG_NTFY_TOPIC_URL=https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34`, `WATCHDOG_API_URL=https://api.geospectrum.org/health`, `WATCHDOG_UI_URL=<url pública de Vercel>`.
   - Sin puerto expuesto (Railway no necesita healthcheck HTTP para este servicio, igual que `seedlink`/`events-worker`).
3. En el servicio `events-worker` existente, no hace falta ninguna variable nueva: `WATCHDOG_EVENTS_HEARTBEAT_INTERVAL_SECONDS`/`_TTL_SECONDS` tienen defaults razonables en `settings.py` y son opcionales.
4. Deploy y verificar en logs de `watchdog` que arrancó y corrió al menos un ciclo completo sin excepciones.
5. Confirmar que el usuario está suscripto al topic `https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34` desde el celular (dependencia ya señalada en el proposal) antes de dar el change por verificado.
6. Rollback: apagar el servicio `watchdog` en Railway, o `WATCHDOG_ENABLED=false` (el `__main__` debe chequear el flag y salir con log informativo sin iniciar el loop, mismo patrón que `disk_alert_enabled` en el lifespan del API). El cambio en `events_ingestor.py` es reversible con un revert de commit aislado si se sospecha inestabilidad.

## Open Questions

Ninguna que bloquee la implementación. Dos notas para quien implemente, no decisiones pendientes:

- El `COPY` de `dashboard/lib/seismic-constants.json` en `Dockerfile.watchdog` se mantiene por seguridad (mismo criterio que en `Dockerfile.seedlink`/`Dockerfile.events-worker`), aunque `watchdog.py` en sí no lo necesite — si al implementar se confirma que ningún import transitivo (p. ej. `src.services.timescale_service`) lo requiere, se puede omitir; si hay duda, mantenerlo cuesta una sola línea y evita repetir el incidente de `FileNotFoundError` del 2026-08-26.
- El catálogo de "canales activos esperados" que usa `check_seedlink()` para decidir "TODOS mudos" debe salir de `DEFAULT_CHANNELS` / `channels_from_catalog(LIVE_CANDIDATES_BY_CITY)` (ya expuesto por `seedlink_ingestor.py:432-461`) — se reutiliza tal cual, sin duplicar la lista.
