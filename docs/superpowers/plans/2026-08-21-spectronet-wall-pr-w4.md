# PR-W4 — Push de eventos: worker + persistencia + `/ws/events` + indicador live

Cierra la serie SPECTRONET (W1 #26, W2 #27, W3 #29). Implementa el §5 del spec
`docs/superpowers/specs/2026-08-20-spectronet-wall-design.md:104-112`.

## El problema

Hoy un sismo tarda **1-2 minutos** en aparecer en pantalla:

```
frontend pollea 30 s  →  caché TTL 30 s  →  USGS actualiza ~60 s
```

Tres latencias encadenadas. El contador "Actualización en 23s" del globo es la
cara visible de ese diseño.

Además los eventos son **100 % efímeros**: `fetch → merge en memoria → caché
30 s → response`. No hay tabla de eventos (verificado: `deploy/sql/migrations/`
llega a `013_walls`, `db/migrations/` sólo tiene `001_spectrogram_columns`).

## Decisiones tomadas con el usuario (2026-08-21)

1. **Persistir, no sólo publicar.** El worker escribe en tabla Y publica a
   Redis. Cierra la decisión de julio ("persistir eventos con worker aparte").
2. **Push con fallback automático.** El polling SWR no se borra: queda con
   `refreshInterval: 0` mientras el WS vive y se reactiva solo si cae.
3. **Un PR completo** (backend + frontend), como W1-W3.

## Restricción que manda el diseño: Redis Pub/Sub pierde mensajes

`RedisPubSubBus` es fire-and-forget, sin backpressure ni replay
(`src/services/event_bus.py:122-224`). Para columnas de espectrograma da igual
—si se pierde una, la siguiente llega en 1 s—. **Un evento sísmico importa
individualmente.**

Por eso la tabla no es un extra: es lo que hace que el pub/sub sea aceptable.

```
worker ──┬─→ INSERT eventos (fuente de verdad, sobrevive todo)
         └─→ PUBLISH events:new (entrega rápida, best-effort)

/ws/events al conectar:
  1. snapshot desde la TABLA (no desde USGS)   ← cubre lo que el pub/sub perdió
  2. stream de los nuevos
```

Un cliente que reconecta pide el snapshot y recupera lo que se perdió mientras
estaba desconectado. Sin tabla, ese hueco no se puede cerrar.

## Arquitectura

```
┌─ Proceso separado (Dockerfile.events-worker) ────────────────┐
│  EMSC WebSocket  wss://www.seismicportal.eu/standing_order/  │
│       ↓ push real (segundos)                                 │
│  USGS poll cada 60 s (GeoJSON)                               │
│       ↓                                                       │
│  dedupe por canonical_id ─→ INSERT tabla ─→ PUBLISH Redis    │
└──────────────────────────────────────────────────────────────┘
                              ↓ events:new
┌─ API (src/main.py) ──────────────────────────────────────────┐
│  @app.websocket("/ws/events")   ← patrón de /ws/spectrogram  │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌─ Frontend ───────────────────────────────────────────────────┐
│  useEventStream()  →  mutate('broadcast-events')             │
│  AppSidebar: indicador   GlobeBroadcastOverlay: reemplaza el │
│                          countdown "Actualización en Ns"     │
└──────────────────────────────────────────────────────────────┘
```

## Precedentes que se respetan

| Lección | Origen | Cómo se aplica acá |
|---|---|---|
| El worker muere VISIBLE si queda mudo | `seedlink_ingestor.py:467-473` — salía con exit 0 y Railway daba SUCCESS sobre un ingestor muerto | `raise RuntimeError(...) from failure` al salir del loop + `self.failure` capturado con `except BaseException` |
| `PYTHONUNBUFFERED=1` | `Dockerfile.seedlink:14-18` — el proceso puede morir en el arranque sin emitir una línea | Mismo ENV en el Dockerfile nuevo |
| El pool de asyncpg nace en el loop del worker | `seedlink_ingestor.py:423-426` | Instanciar en `__main__`, conectar dentro de `run()` |
| Migraciones idempotentes, sin Alembic | `scripts/apply_migrations.py:1-18` | `CREATE TABLE IF NOT EXISTS` |
| `RUN_MIGRATIONS_ON_STARTUP=false` en workers | `settings.py:80-83` — sólo el servicio api hace DDL | El worker nuevo no migra |
| Un test no debe recibir config que producción no tiene | commit 92b0328 (fix UTC de hoy) | `IntlTestProvider` en los tests nuevos, nunca `NextIntlClientProvider` suelto |
| Verificar por mutación | `verificar-tests-por-mutacion` | Romper el dedupe y el fallback a propósito; deben fallar tests |
| Verificar contra la base, no con mocks | `tests/integration/conftest.py:1-12` | Los tests del store van con testcontainer |
| Efecto que lee un ref sin tenerlo en deps | `GlobeBroadcastOverlay.tsx:382-440` | El push escribe en el caché SWR; el efecto de sync del ref (`:405-418`) SE MANTIENE |

## Dónde va la tabla

`deploy/sql/migrations/014_seismic_events.sql`.

**No** en `db/migrations/` aunque sea "dato sísmico": `tests/conftest.py:26` sólo
aplica `deploy/sql/migrations`, así que una tabla en `db/` no existiría en los
tests con Postgres real. Elegir el otro directorio sería elegir no poder
testear.

## Tasks

### Backend

- [ ] **T1 — Migración `014_seismic_events.sql`**
  Tabla `seismic_events`: `id` (canonical, PK), `fuentes` (text[]), `hora_utc`
  (timestamptz, index), `lat`, `lon`, `prof_km`, `mag` (index), `mag_tipo`,
  `lugar`, `sentido`, `revisado`, `created_at`. Idempotente.
  Index compuesto `(hora_utc DESC, mag)` para el snapshot de 24 h.

- [ ] **T2 — `src/services/event_store.py`**
  `EventStore` con pool asyncpg propio: `upsert_event(event) -> bool` (True si
  es NUEVO, False si ya estaba — es lo que decide si se publica),
  `recent_events(hours, min_mag)`, `connect()`, `close()`.
  El upsert usa `ON CONFLICT (id) DO UPDATE` con los campos que pueden cambiar
  (mag, revisado): EMSC manda revisiones del mismo evento.
  **Tests contra testcontainer, no mocks.**

- [ ] **T3 — `canonical_id` y dedupe entre fuentes**
  Un mismo sismo llega como `usgs_us7000abcd` y `emsc_1234567`. Reusar el
  criterio de `merge_service.py:111` (`_fuse_two_events`), que ya resuelve esto
  para `/report`. Función pura, tests unitarios.

- [ ] **T4 — `src/ingestors/emsc_listener.py`**
  Cliente del WS de EMSC (`websockets==12.0` ya está en requirements.txt:84).
  Reconexión con backoff exponencial + jitter, watchdog de silencio (patrón
  `channel_watchdog.py`), y `failure` capturado como el seedlink.

- [ ] **T5 — `src/ingestors/usgs_poller.py`**
  Poll cada 60 s reusando `fetch_usgs_events()` (`usgs_service.py:17`), que ya
  existe y ya es global sin bbox.

- [ ] **T6 — `src/services/events_ingestor.py` + `__main__`**
  Orquesta T4 y T5, dedupe con T3, persiste con T2, publica a `events:new`.
  `__main__` con el patrón exacto del seedlink, incluido el `raise` final.

- [ ] **T7 — `@app.websocket("/ws/events")`**
  Patrón de `main.py:2164-2181`. Público (misma política que
  `/spectrograms/*`, ver `stations.py:4-6`). Snapshot al conectar + stream.
  **Estrena `TestClient.websocket_connect` en este repo** (hoy no hay ni un
  test de WS).

- [ ] **T8 — `GET /events/recent`**
  Lee de la tabla, no de USGS. Es el fallback REST del frontend y la fuente del
  snapshot.

- [ ] **T9 — `deploy/docker/Dockerfile.events-worker`**
  Copia de `Dockerfile.seedlink` cambiando sólo el `CMD`. Con
  `PYTHONUNBUFFERED=1`.

### Frontend

- [ ] **T10 — `lib/ws-base.ts`**
  Extraer el `WS_BASE` hoy hardcodeado en `LiveSpectrogramCanvas.tsx:32-33`
  para no duplicar el `.replace(/^http/, 'ws')`.

- [ ] **T11 — `hooks/use-event-stream.ts`**
  Abre el WS, expone `status: 'connecting' | 'live' | 'reconnecting' | 'offline'`
  (mismo vocabulario que `LiveSpectrogramCanvas.tsx:64`). Backoff exponencial
  con tope (el de espectros es fijo de 3 s, acá el spec pide backoff real).
  Escribe con `mutate('broadcast-events', updater, { revalidate: false })`.
  Cleanup con los tres flags coordinados de `LiveSpectrogramCanvas.tsx:144-149`.

- [ ] **T12 — `components/LiveIndicator.tsx`**
  Semáforo verde/amarillo/rojo, reusando el vocabulario visual de
  `LiveSpectrogramCanvas.tsx:195-199`.

- [ ] **T13 — Provider en `app/(app)/layout.tsx`**
  UNA sola conexión WS compartida entre sidebar y globo. Sin esto, dos
  `useEventStream()` abren dos WebSockets. El overlay se monta por portal a
  `document.body` pero está bajo el layout de `(app)`, así que el provider
  cubre a los dos.

- [ ] **T14 — Sidebar**
  Indicador en `AppSidebar.tsx:65-70` (header). Ojo `collapsible="icon"`: el
  texto necesita `group-data-[collapsible=icon]:hidden` y tooltip, como `:67`.

- [ ] **T15 — Globo: reemplazar el countdown**
  `GlobeBroadcastOverlay.tsx:338-348` + render `:695-697`. El `useSWR` de
  `:157-159` pasa a `refreshInterval: wsLive ? 0 : 30_000`.
  **No tocar** el efecto de sync del ref (`:405-418`): sigue siendo necesario.

- [ ] **T16 — i18n**
  `common.live.*` (transversal sidebar+globo, junto a `utcSuffix`). Paridad
  ES/EN — `messages/parity.test.ts` lo verifica y `global.d.ts:9-14` hace que
  una clave inexistente rompa el build.

### Cierre

- [ ] **T17 — Verificación por mutación**
  - Romper el dedupe → un test debe fallar con evento duplicado.
  - Quitar el `raise` final del worker → el test del exit code debe fallar.
  - Forzar `wsLive = true` con el WS caído → el test del fallback debe fallar.
  - Backend: `./venv/bin/python -m pytest tests/ -v --no-cov` (Docker arriba).
  - Frontend: `TZ=Asia/Tokyo ./node_modules/.bin/vitest run` + `tsc --noEmit`.
    Node: `export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$PATH"` — el del
    shell es v12 y revienta.

- [ ] **T18 — PR**

## Fuera de alcance

- Métricas Prometheus del worker (el plan viejo las nombraba:
  `docs/superpowers/plans/2026-04-29-realtime-event-stream.md:902-919`).
- Backfill histórico de la tabla — arranca vacía y se llena hacia adelante.
- INPRES en el worker: sigue por `/report`, es un scraper con proceso propio.
- Actualizar `docs/RUNBOOK.md`, que es de la era k8s y no cubre Railway.
  Queda como deuda documental declarada.

## Orden de ejecución

T1 → T2 → T3 (base de datos y lógica pura, testeables solos) → T4/T5 en
paralelo → T6 → T7/T8 → T9. Después T10 → T11 → T12 → T13 → T14/T15 → T16.
T17 y T18 cierran.
