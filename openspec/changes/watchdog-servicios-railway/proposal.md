# Proposal: Watchdog Externo de Servicios en Railway

## Intent

El proyecto ya tiene una alerta de disco de TimescaleDB (`src/services/disk_alert.py`, EN PROD) que funciona porque corre DENTRO del proceso del API — un proceso vivo puede avisar de un problema ajeno (disco lleno). Pero si el API MISMO se cae, o el `seedlink_ingestor`, o el `events_ingestor` mueren, ningún proceso interno puede avisar de su propia caída: el vigilante y el vigilado son el mismo proceso.

Railway ya reinicia automáticamente los procesos que crashean de verdad: `seedlink_ingestor.py` y `events_ingestor.py` terminan con un `raise RuntimeError(...)` explícito si el loop principal vuelve sin deber hacerlo (lección de un incidente pasado — "el ingestor salía con exit 0" — documentada en el propio código, ver `events_ingestor.py:191-198`). Por eso este change NO cubre "el proceso murió". Cubre el caso que Railway no puede ver: **el proceso sigue vivo, pero dejó de producir algo útil** (falso vivo) — un `seedlink_ingestor` que quedó colgado sin levantar la excepción, un `events_ingestor` sin heartbeat que nadie notaría hasta el próximo sismo, un API que responde pero con el pool de conexiones roto, o el dashboard de Vercel caído sin que nada del lado del backend se entere.

## Scope

### In Scope

- Nuevo servicio Python standalone en Railway (`src/services/watchdog.py` + `deploy/docker/Dockerfile.watchdog`), con un loop propio que se despierta cada 5 minutos, mismo patrón de proceso separado que `seedlink_ingestor.py` / `events_ingestor.py`.
- Chequeo de **API**: `GET https://api.geospectrum.org/health` — no-200 o timeout cuenta como caído.
- Chequeo de **UI**: `GET` a la URL pública del dashboard en Vercel — no-200 o timeout cuenta como caído.
- Chequeo de **seedlink_ingestor**: reutiliza el patrón de `TimescaleColumnWriter.fetch_active_channels(minutes)` (`src/services/timescale_service.py:88-103`) contra `spectrogram_columns`. Si TODOS los canales activos están mudos por encima del umbral (a fijar en design.md, con `STALE_AFTER_SECONDS=300` o `GIVE_UP_AFTER_SECONDS=900` de `seedlink_ingestor.py:63,71` como referencia), se considera caído. Un canal individual mudo NO alerta — SeedLink cae de a ratos y es normal.
- Chequeo de **events_ingestor**: agregar heartbeat propio en `src/services/events_ingestor.py`, que escriba periódicamente una key en Redis con TTL (mismo patrón de `MetricsStore.set_snapshot`, `src/services/metrics_store.py:32-41`, SET con `ex=ttl_s`), independiente de si hubo sismos o no. El watchdog lee esa key; su ausencia o vejez indica proceso colgado.
- Persistencia de estado del watchdog en Redis (mismo cliente `redis.asyncio` que el resto del stack) para: (a) no re-notificar la misma caída en cada ciclo de 5 minutos mientras sigue caída, y (b) notificar la RECUPERACIÓN cuando un componente vuelve a responder, incluyendo cuánto tiempo estuvo caído.
- Notificación por ntfy al topic dedicado `https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34` (separado del topic de `disk_alert`), tanto para caída como para recuperación.
- Nuevas variables de entorno / settings: URL del topic ntfy del watchdog, URL pública de la UI en Vercel, umbral de silencio del seedlink, intervalo del ciclo.

### Out of Scope

- Vigilar otros proyectos del usuario en Railway (ej. padelero) — decisión ya tomada de tratarlo como un proyecto aparte a explorar en otra sesión.
- Vigilar procesos adicionales más allá de los 4 listados (ej. un futuro asistente sísmico conversacional que todavía no existe como código).
- Cualquier forma de auto-remediación (reiniciar servicios, escalar, etc.) — el watchdog solo detecta y notifica.
- Dashboard o UI propia para ver el historial de incidentes del watchdog — la única interfaz es la notificación ntfy.
- Cambiar el comportamiento de reinicio automático de Railway o los `raise RuntimeError` existentes en `seedlink_ingestor.py` / `events_ingestor.py`.

## Approach

Servicio Python standalone en Railway, mismo patrón arquitectónico que `seedlink_ingestor.py` y `events_ingestor.py`: un loop `asyncio` con `stop_event` esperado (no `sleep` pelado, mismo criterio de `disk_alert.py:75-94` para no demorar el shutdown) que corre un ciclo completo de los 4 chequeos cada 5 minutos, con Dockerfile propio en `deploy/docker/` seleccionado vía `RAILWAY_DOCKERFILE_PATH` — igual que ya hace Railway para `Dockerfile.seedlink` y `Dockerfile.events-worker`.

Decisión de diseño clave: **NO es un job dentro de un servicio existente** — corre aislado para que un API o ingestor caído no se lleve al watchdog con él. Cada chequeo individual va envuelto en su propio `try/except` (el ciclo completo nunca debe morir por un solo chequeo fallido — mismo criterio que `disk_alert.py:85-90`).

Los 4 chequeos:
1. **API**: HTTP GET a `/health` con `httpx.AsyncClient` y timeout corto — reutiliza el patrón de request HTTP puro ya usado en todo el proyecto (sin SDKs de orquestación, coherente con las decisiones de `asistente-sismico-conversacional`).
2. **UI**: HTTP GET a la URL pública de Vercel — mismo patrón, sin autenticación.
3. **seedlink_ingestor**: SELECT read-only sobre `spectrogram_columns` reusando `fetch_active_channels`; "todos mudos" se calcula comparando el set de canales activos esperados (catálogo) contra los que devolvió la consulta dentro del umbral.
4. **events_ingestor**: lectura de una key Redis nueva (ej. `events_ingestor:heartbeat`) que `events_ingestor.py` escribe en cada vuelta de su loop de eventos (o en un sub-loop paralelo con `asyncio.gather`, ya que hoy `run()` solo orquesta EMSC+USGS). Ausencia de la key (expiró el TTL) o timestamp viejo indica proceso colgado.

Persistencia de estado propia del watchdog en Redis, con una key por componente (ej. `watchdog:state:{componente}`) guardando el estado actual (`up`/`down`) y desde cuándo, para poder: detectar transición (para no spamear ntfy en cada ciclo) y calcular la duración de la caída al notificar la recuperación.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/services/watchdog.py` | New | Loop principal del watchdog: los 4 chequeos, comparación de estado en Redis, notificación ntfy. Mismo patrón de `__main__` standalone que `seedlink_ingestor.py` / `events_ingestor.py` |
| `deploy/docker/Dockerfile.watchdog` | New | Dockerfile del servicio nuevo en Railway, calcado de `deploy/docker/Dockerfile.seedlink` (mismo `requirements.txt`, mismo `COPY` de `dashboard/lib/seismic-constants.json` si el chequeo de seedlink lo necesita, `CMD ["python", "-m", "src.services.watchdog"]`) |
| `src/services/events_ingestor.py` | Modified | Agregar heartbeat propio: escribir periódicamente una key en Redis con TTL, independiente de si hubo sismos. Requiere sumar un sub-loop (`asyncio.gather` junto a EMSC+USGS) o una tarea paralela dentro de `run()` |
| `src/config/settings.py` | Modified | Nuevas settings: `watchdog_ntfy_topic_url`, `watchdog_ui_url` (Vercel), `watchdog_seedlink_stale_after_seconds`, `watchdog_interval_seconds`, `watchdog_enabled` — mismo patrón opt-in que `disk_alert_enabled`/`ntfy_topic_url` (`settings.py:92-103`) |
| `src/services/timescale_service.py` | Read-only (reused) | `fetch_active_channels(minutes)` se invoca desde el watchdog sin modificarse |
| `.env.example` | Modified | Documentar las nuevas variables de entorno del watchdog |
| Railway (infraestructura) | New | Servicio nuevo `watchdog` con `RAILWAY_DOCKERFILE_PATH=deploy/docker/Dockerfile.watchdog`, acceso de solo lectura a TimescaleDB y a Redis, sin puerto expuesto (igual que seedlink/events-worker) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Falsos positivos por caída transitoria de red entre el watchdog y el componente chequeado (no es que el componente esté caído, es la red) | Med | **Decisión del usuario: alertar directo al primer fallo, sin reintentos.** El ciclo de 5 minutos ya acota el ruido — un blip aislado se resuelve solo en el próximo ciclo con su notificación de recuperación, sin agregar demora extra a una caída real |
| Redis mismo está caído, y el watchdog no puede ni leer el heartbeat del events_ingestor ni guardar su propio estado de transición | Med | **Decisión del usuario: notificar igual, sin deduplicar.** Sin Redis el watchdog no puede recordar "ya avisé de esto" y puede repetir la misma alerta cada ciclo mientras dure el problema — se acepta ese riesgo de spam puntual antes que quedarse mudo justo cuando algo grave puede estar pasando |
| Costo/huella de un servicio nuevo corriendo 24/7 en Railway, aunque sea liviano (misma imagen base que seedlink/events-worker) | Low | El ciclo de 5 minutos y la ausencia de procesamiento pesado (solo requests HTTP + 1 SELECT + lectura de Redis) lo hacen comparable en costo a `disk_alert` corriendo dentro del API hoy; verificar consumo real post-deploy |
| El heartbeat nuevo de `events_ingestor.py` introduce una fuente de fallo en un proceso ya frágil (memoria de "el ingestor salía con exit 0") | Med | El heartbeat debe estar en su propio `try/except` que jamás pueda tumbar el loop de EMSC/USGS — un fallo al escribir en Redis se loguea y se reintenta el próximo ciclo, nunca debe disparar el `raise RuntimeError` que sí corresponde a la ingesta real |
| El watchdog reporta al `events_ingestor` como caído durante una calma sísmica real prolongada si el umbral del heartbeat se confunde con el umbral de "último sismo" | Low (si se implementa como se especifica) | El heartbeat es explícitamente independiente de si hubo sismos — se escribe en cada vuelta del loop del proceso, no en cada evento recibido; el diseño debe dejar esto verificado con un test o una nota explícita para no repetir el error que ya se identificó con `EventStore.stats()` |

## Rollback Plan

El watchdog es aditivo y aislado: un servicio nuevo, un módulo nuevo, un heartbeat nuevo en un proceso existente. Rollback:
1. Apagar el servicio `watchdog` en Railway (o setear `WATCHDOG_ENABLED=false` si se implementa como flag opt-in, igual que `DISK_ALERT_ENABLED`) — no afecta a ningún otro servicio.
2. Revertir el commit que agrega el heartbeat en `events_ingestor.py` si se sospecha que introduce inestabilidad — es un cambio aislado y acotado dentro de ese archivo.
3. No hay migraciones de base de datos: no se crean tablas nuevas, solo se lee `spectrogram_columns` (ya existente) y se usan keys de Redis efímeras (TTL), que expiran solas sin necesidad de limpieza manual.
4. Si el watchdog empieza a generar falsos positivos en producción, puede apagarse sin impacto en API, UI, seedlink ni events_ingestor — ninguno de ellos depende de que el watchdog exista.

## Dependencies

- Topic ntfy dedicado ya generado: `https://ntfy.sh/geospectrum-watchdog-02d73c9b7f34` (separado del topic de `disk_alert`) — el usuario debe estar suscripto desde el celular antes de considerar el change verificado en producción.
- Acceso de solo lectura del watchdog a TimescaleDB (mismo DSN que usa `TimescaleColumnWriter` hoy, sin permisos de escritura adicionales).
- Acceso a Redis (mismo `redis_url` que ya usa `MetricsStore` y `RedisPubSubBus`).
- URL pública del dashboard en Vercel como variable de entorno nueva (`watchdog_ui_url`), hoy no existe en `settings.py`.
- Ninguna dependencia externa nueva de Python: `httpx`, `asyncpg` y `redis.asyncio` ya están en `requirements.txt` (usados por `disk_alert.py`, `timescale_service.py` y `metrics_store.py` respectivamente).

## Success Criteria

- [ ] Si el API deja de responder 200 en `/health`, llega una notificación ntfy al topic del watchdog dentro de un ciclo (≤5 minutos), y una segunda notificación de recuperación cuando vuelve a responder, con la duración de la caída.
- [ ] Si la UI de Vercel deja de responder, se notifica de la misma forma, sin depender del estado del backend.
- [ ] Si TODOS los canales de `spectrogram_columns` quedan sin actualizarse por encima del umbral definido en diseño, se notifica que el seedlink_ingestor está caído; un solo canal mudo NO genera notificación.
- [ ] Si el heartbeat de `events_ingestor` en Redis expira sin haberse renovado, se notifica que el events_ingestor está caído, incluso en ausencia total de sismos nuevos.
- [ ] Ningún componente deja de notificarse dos veces seguidas por el mismo incidente sin que haya mediado una recuperación intermedia (verificable revisando el estado persistido en Redis durante una caída simulada prolongada).
- [ ] El watchdog corre como servicio independiente en Railway y su caída (o la de Redis) no afecta la disponibilidad de API, UI, seedlink_ingestor ni events_ingestor.
