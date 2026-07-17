# Design: Rename "Seismic Monitor" to "GeoSpectrum"

## Technical Approach

Este change es un rename mecánico de branding + un fix de configuración aislado
(CORS) que comparte archivo (`src/main.py`) con el rename de backend. No hay
cambios de arquitectura, esquema de datos, ni contratos de API salvo por los
valores de texto/label que se renombran.

El riesgo real no es técnico (no hay lógica nueva) sino de **precisión en el
find/replace**: "seismic" es tanto marca (a renombrar) como vocabulario de
dominio (a preservar). Este documento resuelve ese riesgo con una lista
exhaustiva patrón → reemplazo, archivo por archivo (Decisión 3), de forma que
la fase de implementación (`sdd-apply`) no tenga que "interpretar" ningún match
— cada ocurrencia real relevada en el repo ya está clasificada aquí.

El resto del documento fija: orden de fases (Decisión 1), el diff exacto del
fix de CORS (Decisión 2), el checklist de verificación de K8s/deploy
(Decisión 4), y el procedimiento de no-colisión con `redesign-dashboard-page`
(Decisión 5).

## Architecture Decisions

### Decisión 1: Orden de fases de implementación

**Elección**: 6 fases secuenciales, cada una verificable de forma independiente
antes de pasar a la siguiente:

```
Fase 0 — Fix de CORS (settings.py + main.py)
Fase 1 — Backend rename (main.py, observability/, pyproject.toml, __init__.py,
          scripts/, tests/integration/test_api.py)
Fase 2 — Frontend rename (dashboard/, con verificación previa de no-colisión)
Fase 3 — Docs (README.md, docs/API.md, docs/RUNBOOK.md)
Fase 4 — K8s/Docker/Prometheus (deploy/)
Fase 5 — Verificación final global (grep de cierre + pytest + npm build)
```

**Alternativas consideradas**:
- *CORS al final*: rechazado. CORS toca `main.py:158-169`, el mismo bloque
  que Fase 1 va a tocar para el título FastAPI (línea 146) y las métricas
  (líneas 56-85). Hacerlo en fases separadas sobre el mismo archivo aumenta
  el riesgo de conflicto de diff / doble edición. Se hace primero porque es
  un cambio funcional aislado (no depende del rename) y así Fase 1 parte de
  `main.py` ya en su estado final de CORS.
- *Docs antes que backend*: rechazado. `docs/RUNBOOK.md` documenta
  comportamiento observable del backend (nombre del servicio en `/`, prefijo
  de métricas, namespace de K8s). Si docs se escribe antes de que el backend
  y K8s estén renombrados, hay riesgo de documentar un estado que todavía no
  existe. Docs va después de Fase 1 (backend) pero antes de Fase 4 (K8s) es
  incorrecto también, porque RUNBOOK referencia `kubectl -n geospectrum`
  (K8s). Por eso Docs (Fase 3) va después de Backend+Frontend pero el
  contenido de K8s en RUNBOOK se escribe sabiendo que Fase 4 usará
  exactamente `geospectrum` como nombre de namespace (fijado en Decisión 4
  antes de ejecutar, no durante).
- *K8s primero (mayor volumen)*: rechazado. K8s/Docker no tiene infraestructura
  viva (confirmado por el usuario en la propuesta), por lo que no hay urgencia
  de secuencia; en cambio tiene el mayor volumen de archivos (10 manifiestos +
  compose + 2 Dockerfiles + prometheus.yml) — postergarlo a Fase 4 evita que
  un error de renombrado ahí bloquee la verificación temprana del backend, que
  sí tiene comportamiento ejecutable (pytest).
- *Frontend antes que backend*: rechazado. El dashboard consume `service` desde
  `GET /` solo para mostrarlo si acaso (no hay un fetch verificado en este
  change), pero more importante: Fase 2 requiere el paso de verificación de
  Decisión 5 (releer `AppSidebar.tsx`/`layout.tsx` en disco), que es
  independiente del orden respecto al backend. Se coloca después del backend
  simplemente porque el backend tiene tests automatizados que dan señal rápida
  de éxito/fracaso; el frontend no tiene esa señal en este change (no se pide
  agregar tests de frontend).

**Rationale**: minimizar el "blast radius" de cada fase — cada una termina en
un estado verificable (pytest para 0-1, build dry-run para 2, grep para 3,
`kubectl apply --dry-run=client` para 4) antes de tocar la siguiente capa.

### Decisión 2: Mecánica exacta del fix de CORS

**Estado real confirmado en disco** (leído en esta sesión de diseño, no
asumido de la exploración):

`src/config/settings.py:85` (actual):
```python
cors_allowed_origins: str = "http://localhost:3008,http://localhost:3000"
```

`src/config/settings.py:87-90` (actual, ya correcto y sin uso — no se toca):
```python
@property
def cors_origins_list(self) -> list[str]:
    """Parsea cors_allowed_origins (CSV) a lista."""
    return [o.strip() for o in self.cors_allowed_origins.split(",") if o.strip()]
```

`src/main.py:158-169` (actual):
```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3008",  # Dashboard Next.js
        "http://localhost:3000",  # Fallback para desarrollo
        "http://127.0.0.1:3008",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

**Elección — diff exacto**:

`src/config/settings.py:85`:
```python
# Antes
cors_allowed_origins: str = "http://localhost:3008,http://localhost:3000"
# Después
cors_allowed_origins: str = (
    "http://localhost:3008,http://localhost:3000,"
    "http://127.0.0.1:3008,http://127.0.0.1:3000"
)
```

`src/main.py:158-169`:
```python
# Antes
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3008",  # Dashboard Next.js
        "http://localhost:3000",  # Fallback para desarrollo
        "http://127.0.0.1:3008",
        "http://127.0.0.1:3000",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Después
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

`cors_origins_list` no se toca — ya está correcta. `settings.py:85` pasa de 2 a
4 orígenes (superset exacto de lo que estaba hardcodeado en `main.py`), por lo
que el comportamiento resultante en desarrollo sin `.env` es idéntico al
actual: mismo resultado, ahora vía config en vez de hardcode.

**Test de CORS — sí se agrega** (la propuesta lo deja como consideración; se
decide agregarlo porque hoy no existe ninguno y el bug original — código muerto
desconectado — es exactamente el tipo de regresión que un test de 5 líneas
previene a futuro):

Ubicación: `tests/integration/test_api.py`, agregado después de
`test_metrics_endpoint` (línea ~76), mismo estilo que los tests existentes
(usa la fixture `client`, sin mocks de red porque el middleware CORS actúa
antes de llegar al handler):

```python
def test_cors_allows_configured_origins(client):
    """Test que CORS responde Access-Control-Allow-Origin para un origen
    configurado en settings.cors_origins_list (fix: antes el middleware
    ignoraba settings y usaba una lista hardcodeada)."""
    response = client.get(
        "/health",
        headers={"Origin": "http://localhost:3008"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:3008"
```

**Alternativas consideradas**: agregar un test que verifique CADA uno de los 4
orígenes — rechazado por redundante; `starlette.CORSMiddleware` no tiene lógica
condicional por origen individual una vez que la lista está bien parseada, un
solo caso representativo cubre la regresión real (desconexión config↔middleware).

### Decisión 3: Estrategia de búsqueda/reemplazo segura

**Elección**: lista exhaustiva y cerrada de patrones exactos con su reemplazo,
relevada por grep real sobre el repo en esta sesión de diseño (no un regex
genérico que el implementador deba "interpretar"). Todo lo que NO aparece en
esta lista permanece intacto.

**Patrones de marca a reemplazar** (aplican en TODO archivo listado en la
tabla de File Changes, salvo excepciones explícitas marcadas):

| Patrón exacto | Reemplazo | Notas |
|---|---|---|
| `Seismic Monitor` (display, con espacio) | `GeoSpectrum` | Título/UI/docs. Ej: `AppSidebar.tsx:52`, `layout.tsx:25` (`Seismic Monitor Dashboard` → `GeoSpectrum Dashboard`), `main.py:146` (`title="Seismic Monitor Service"` → `title="GeoSpectrum Service"`), `main.py:624` (`"service": "Seismic Monitor"` → `"service": "GeoSpectrum"`), logs `main.py:101,138` |
| `seismic-monitor` (kebab-case) | `geospectrum` | `package.json` name, namespace K8s, nombres de recursos K8s, servicio/red docker-compose, job Prometheus |
| `seismic_monitor` (snake_case, prefijo de métrica) | `geospectrum` | Prefijo de las 5 métricas en `main.py:57,63,69,75,82` y de `source_fetch_duration_seconds`/`source_errors_total` en `metrics.py:118,125` (ver detalle abajo) |
| `seismic-monitor-dashboard` (package.json name) | `geospectrum-dashboard` | Único match, `dashboard/package.json` |
| `seismic-ops@example.com` | `geospectrum-ops@example.com` | Email placeholder de contacto en Dockerfiles — es branding de contacto del proyecto, no dominio físico |

**Excepciones — NO tocar (vocabulario de dominio confirmado)**:

| Patrón encontrado | Ubicación | Motivo |
|---|---|---|
| `SeismicEvent` | `src/models/event.py`, imports en `main.py`, `test_api.py` | Tipo de dominio (evento sísmico) |
| `SeismicMap`, `SeismicMapWithCities`, `AdvancedSeismicMap` | `dashboard/components/*.tsx` | Componentes de dominio (mapa de sismos) |
| `SeismicCity`, `HIGH_RISK_SEISMIC_CITIES` | `dashboard/lib/seismic-cities.ts` | Tipo/constante de dominio |
| `text-seismic-600` | Clases Tailwind en componentes | Token de diseño de dominio |
| `seismic_emsc_*`, `seismic_usgs_*`, `seismic_dispatcher_*`, `seismic_redis_*`, `seismic_sse_*`, `seismic_archive_*` (Gauges/Counters en `metrics.py:19-110`) | `src/observability/metrics.py` | **Prefijo `seismic_` genérico de dominio** (monitoreo sísmico), NO `seismic_monitor_` (branding de producto) — la propuesta solo pide renombrar el prefijo de producto `seismic_monitor_*`. Distinción verificada por grep: son 2 prefijos distintos y coexisten en el mismo archivo (`seismic_emsc_websocket_connected` vs `seismic_monitor_source_fetch_duration_seconds`, líneas 19 y 118) |
| `TIMESCALEDB_USER: "seismic"`, `POSTGRES_USER: seismic`, `POSTGRES_DB: seismic`, `timescaledb_db: str = "seismic"` | `deploy/k8s/secret.yaml:10`, `docker-compose.yml:140-141`, `settings.py:61` | Nombre de usuario/base de datos técnica, no branding de producto — cambiarlo sería una migración de datos fuera de scope |
| `seismic.example.com` | `deploy/k8s/ingress.yaml:31,34`, `deploy/k8s/README.md:63` | Placeholder de DOMINIO — no es el mismo string que `seismic-monitor`; ver Decisión 4 para su reemplazo específico a `geospectrum.org` |

**Nota sobre `metrics.py`**: SOLO 2 constantes de ese archivo tienen el
prefijo de producto y se renombran:
- `source_fetch_duration_seconds`: `"seismic_monitor_source_fetch_duration_seconds"` → `"geospectrum_source_fetch_duration_seconds"` (línea 118)
- `source_errors_total`: `"seismic_monitor_source_errors_total"` → `"geospectrum_source_errors_total"` (línea 125)

Las 13 constantes restantes de `metrics.py` (prefijo `seismic_` sin `_monitor_`)
NO se tocan.

**Nota sobre `main.py` — 5 métricas de producto** (todas con prefijo
`seismic_monitor_`, todas se renombran a `geospectrum_`):
`requests_total` (L57), `events_fetched` (L63), `alerts_generated` (L69),
`data_source_errors` (L75), `request_duration` (L82).

**Alternativas consideradas**: un único `sed -i 's/seismic/geospectrum/g'`
global — rechazado explícitamente. Rompería `SeismicEvent` → `GeospectrumEvent`
(rename no solicitado de un tipo de dominio usado en 3+ archivos con imports
cruzados) y las 13 métricas de dominio en `metrics.py`. La tabla de arriba es
la única fuente de verdad para `sdd-apply`; ningún otro match de "seismic" en
el repo debe modificarse salvo que aparezca explícitamente listado.

### Decisión 4: Verificación de namespace K8s completo y consistente

**Estado real relevado** (grep ejecutado en esta sesión, no inferido): el
namespace `seismic-monitor` aparece en **10 archivos** bajo `deploy/k8s/` (como
`metadata.namespace`, `namespace: seismic-monitor` en kustomization, o
`app: seismic-monitor` en selectors/labels) más `deploy/docker/prometheus.yml`
(job name y target) y `deploy/docker/docker-compose.yml` (nombre de servicio,
container_name, red).

**Elección — checklist verificable, a ejecutar al cierre de Fase 4**:

1. Renombrar `metadata.namespace: seismic-monitor` → `metadata.namespace: geospectrum` en los 8 manifiestos que lo tienen: `secret.yaml`, `configmap.yaml`, `hpa.yaml`, `ingress.yaml`, `deployment-inpres-adapter.yaml`, `service.yaml` (aparece 2 veces, líneas 5 y 23), `servicemonitor.yaml`, `deployment.yaml`.
2. Renombrar `namespace.yaml`: `metadata.name` y `metadata.labels.name` de `seismic-monitor` → `geospectrum`.
3. Renombrar `kustomization.yaml`: `namespace:` (L5), `commonLabels.project` (L20), `images[0].name` y `images[0].newName` (`ghcr.io/your-org/seismic-monitor` → `ghcr.io/your-org/geospectrum`, L25-26).
4. Renombrar recursos con nombre propio (`metadata.name` / `app:` labels / `selector` / `container name` / `image name`) en cada manifest: `seismic-monitor-secrets`, `seismic-monitor-config`, `seismic-monitor-hpa`, `seismic-monitor-ingress`, `seismic-monitor-service`, `seismic-monitor` (deployment, servicemonitor, container name, image, pod anti-affinity `deployment.yaml:110`) → equivalentes con `geospectrum`.
5. `ingress.yaml`: reemplazar el placeholder de dominio `seismic.example.com` (L31, L34) por el dominio real `geospectrum.org` (confirmado comprado por el usuario) — este es un reemplazo de VALOR de dominio, no de namespace; se ejecuta en el mismo paso pero es conceptualmente distinto (ver Decisión 3, tabla de excepciones).
6. `docker-compose.yml`: `seismic-monitor` (comentario L4,7; nombre de servicio L18; `container_name` L23; `image` L22) → `geospectrum`; red `seismic-net` (L61,81,105,127,152) → `geospectrum-net`.
7. `prometheus.yml`: `job_name: 'seismic-monitor'` → `job_name: 'geospectrum'`; `targets: ['seismic-monitor:8000']` → `targets: ['geospectrum:8000']` (debe coincidir con el nuevo nombre de servicio del paso 6, porque Prometheus resuelve el target por DNS de docker-compose).
8. `deploy/k8s/README.md`: los 5 usos de `kubectl ... -n seismic-monitor` y el nombre del secret en el comando de ejemplo (L54) → `geospectrum`; el dominio de ejemplo (L63) → `geospectrum.org`.
9. `deploy/docker/Dockerfile` (L2 comentario, L9-10 labels) y `Dockerfile.inpres-adapter` (L7 label maintainer): `Seismic Monitor` / `seismic-ops@example.com` → `GeoSpectrum` / `geospectrum-ops@example.com`.

**Checklist de cierre — grep que DEBE dar 0 resultados** (ejecutar después del
paso 9, antes de considerar Fase 4 completa):

```bash
rg -n "seismic-monitor|seismic_monitor|Seismic Monitor" deploy/
```

Si el grep devuelve algún resultado, la fase NO está completa — no se permite
cerrar Fase 4 con matches pendientes salvo que sean falsos positivos
verificados manualmente (en el relevamiento actual no existe ninguno: todos
los matches de `deploy/` corresponden a branding a renombrar). No hay
comentarios que documenten el nombre histórico en `deploy/` hoy, por lo que no
aplica la excepción de "comentario histórico" mencionada como posibilidad en
la tarea — si `sdd-apply` decide dejar uno, debe quedar explícitamente
etiquetado `# HISTORICAL:` para que este mismo grep pueda excluirlo con
`rg -n "seismic-monitor|seismic_monitor|Seismic Monitor" deploy/ | rg -v "HISTORICAL"`.

**Verificación funcional adicional** (más allá del grep textual):
```bash
kubectl apply --dry-run=client -f deploy/k8s/
```
Debe ejecutar sin error de referencia rota (namespace/secret/configmap
inconsistente entre manifiestos).

### Decisión 5: Verificación de no-colisión con `redesign-dashboard-page`

**Elección**: paso obligatorio de lectura-antes-de-escribir, ejecutado en esta
misma sesión de diseño (no delegado a "se verá en apply"):

1. Se leyó `dashboard/components/AppSidebar.tsx` completo en disco (97
   líneas) — el texto `Seismic Monitor` está en la línea 52, dentro de un
   `<span>` simple en `SidebarHeader`, exactamente como lo describe la
   propuesta ("texto de logo activo"). No hay diferencias estructurales
   respecto a lo asumido por la propuesta.
2. Se leyó `dashboard/app/layout.tsx` completo en disco (59 líneas) — el
   texto está en `metadata.title` (L25: `'Seismic Monitor Dashboard'`) y no
   hay `metadata.description` con "Seismic" (la description actual ya es
   genérica: `'Real-time seismic monitoring with USGS and INPRES
   integration'` — la propuesta menciona actualizar "description" también;
   dado que esta description usa "seismic" como concepto de dominio
   (monitoreo sísmico), NO se renombra — solo se actualiza si contiene
   branding de producto, que no es el caso aquí).
3. Conclusión de no-colisión: ambos archivos están en el estado que la
   propuesta asume; `redesign-dashboard-page` no dejó esos dos textos en un
   estado distinto al relevado en la exploración original. **Aplicar el
   cambio como diff puntual de una sola línea por archivo**, sin tocar
   ninguna otra parte de esos componentes (imports, estructura, otros
   textos), incluso si a simple vista parecen mejorables — ese no es el
   alcance de este change.

**Diff exacto a aplicar**:

`dashboard/components/AppSidebar.tsx:52`:
```tsx
// Antes
            Seismic Monitor
// Después
            GeoSpectrum
```

`dashboard/app/layout.tsx:25`:
```tsx
// Antes
  title: 'Seismic Monitor Dashboard',
// Después
  title: 'GeoSpectrum Dashboard',
```
(`description` en L26 se mantiene sin cambios — es vocabulario de dominio, no
branding.)

**Regla operativa para `sdd-apply`**: antes de tocar cualquiera de estos dos
archivos, releer su estado actual en disco con la herramienta de lectura (no
confiar en el contenido citado en proposal.md ni en este design.md como
verdad absoluta, porque pueden haber cambiado entre el diseño y la
implementación). Si el texto `Seismic Monitor` / `'Seismic Monitor Dashboard'`
ya no aparece literal en esas líneas, DETENER y reportar la discrepancia en
vez de forzar el reemplazo por posición de línea.

**Alternativas consideradas**: sobrescribir el archivo completo basado en el
snapshot de la propuesta — rechazado explícitamente por el riesgo de colisión
documentado en el propio proposal.md (Risks: "releer su estado actual en disco
... y aplicar el rename como diff incremental, no como sobrescritura").

## Data Flow

No aplica — este change no introduce ni modifica flujos de datos en
runtime. El único "flujo" relevante es el de configuración:

```
.env (o default) ──→ Settings.cors_allowed_origins ──→ cors_origins_list (property)
                                                              │
                                                              ▼
                                          CORSMiddleware(allow_origins=...)
```

Antes del fix, la rama derecha estaba desconectada (`main.py` ignoraba
`settings` y usaba una lista hardcodeada paralela). Después del fix, hay una
única fuente de verdad.

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `src/config/settings.py` | Modify | L85: ampliar default de `cors_allowed_origins` a 4 orígenes |
| `src/main.py` | Modify | Fix CORS (L158-169), título/desc FastAPI (L146-147), logs (L101,138), 5 métricas `seismic_monitor_*`→`geospectrum_*` (L57,63,69,75,82), respuesta `GET /` (L624) |
| `src/observability/metrics.py` | Modify | 2 métricas `seismic_monitor_*`→`geospectrum_*` (L118,125); las otras 13 con prefijo `seismic_` NO se tocan |
| `src/observability/logging_config.py` | Modify | Campo fijo `service` (L9 docstring, L52) `"seismic-monitor"`→`"geospectrum"` |
| `pyproject.toml`, `src/__init__.py`, `tests/__init__.py` | Modify | Nombre de paquete/docstrings |
| `scripts/seismic-cli.py`, `scripts/run-local.sh`, `scripts/run-docker.sh` | Modify | Docstrings, banners |
| `LICENSE` | Modify | Copyright holder |
| `tests/integration/test_api.py` | Modify | L66 (`data["service"]`), L75 (prefijo de métrica); agrega `test_cors_allows_configured_origins` |
| `dashboard/components/AppSidebar.tsx` | Modify | L52 texto de logo (diff puntual, ver Decisión 5) |
| `dashboard/app/layout.tsx` | Modify | L25 `metadata.title` (diff puntual, ver Decisión 5); `description` NO se toca |
| `dashboard/components/Header.tsx` | Modify | Texto de logo (código muerto, sin imports) |
| `dashboard/package.json` | Modify | `name` → `geospectrum-dashboard` |
| `dashboard/package-lock.json` | Regenerate | Vía `npm install`, nunca editado a mano |
| `dashboard/lib/api.ts`, `dashboard/lib/types.ts` | Modify | Headers JSDoc |
| `dashboard/README.md`, `dashboard/FEATURES.md`, `dashboard/start-dashboard.sh` | Modify | Branding |
| `README.md`, `docs/API.md`, `docs/RUNBOOK.md` | Modify | Branding + ~25 ejemplos `kubectl -n` |
| `deploy/k8s/namespace.yaml`, `configmap.yaml`, `secret.yaml`, `hpa.yaml`, `service.yaml`, `servicemonitor.yaml`, `deployment.yaml`, `deployment-inpres-adapter.yaml`, `ingress.yaml`, `kustomization.yaml`, `README.md` | Modify | Namespace + nombres de recurso (ver Decisión 4); `ingress.yaml` además dominio real `geospectrum.org` |
| `deploy/docker/docker-compose.yml` | Modify | Servicio, container_name, red `seismic-net`→`geospectrum-net` |
| `deploy/docker/Dockerfile`, `Dockerfile.inpres-adapter` | Modify | Labels, comentarios, email maintainer |
| `deploy/docker/prometheus.yml` | Modify | `job_name` y `targets` (debe coincidir con nuevo nombre de servicio compose) |

## Interfaces / Contracts

Contrato HTTP observable que cambia (documentado para que quien verifique
sepa qué comparar contra Success Criteria de la propuesta):

```
GET / (antes)
{"service": "Seismic Monitor", "version": "1.0.0", ...}

GET / (después)
{"service": "GeoSpectrum", "version": "1.0.0", ...}

GET /docs (antes): título "Seismic Monitor Service"
GET /docs (después): título "GeoSpectrum Service"

GET /metrics (antes): seismic_monitor_requests_total, seismic_monitor_events_fetched_total,
  seismic_monitor_alerts_generated_total, seismic_monitor_data_source_errors_total,
  seismic_monitor_request_duration_seconds, seismic_monitor_source_fetch_duration_seconds,
  seismic_monitor_source_errors_total

GET /metrics (después): geospectrum_requests_total, geospectrum_events_fetched_total,
  geospectrum_alerts_generated_total, geospectrum_data_source_errors_total,
  geospectrum_request_duration_seconds, geospectrum_source_fetch_duration_seconds,
  geospectrum_source_errors_total
  (las 13 métricas seismic_* de dominio en metrics.py permanecen sin cambios)
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit/Integration (backend) | `GET /` responde `service: "GeoSpectrum"`; `GET /metrics` expone prefijo `geospectrum`; CORS responde `Access-Control-Allow-Origin` para origen configurado | Actualizar `test_root_endpoint` (L66) y `test_metrics_endpoint` (L75) en `tests/integration/test_api.py`; agregar `test_cors_allows_configured_origins` nuevo, mismo archivo. Ejecutar `pytest` (comando de `openspec/config.yaml`: `cd seismic-monitor && pytest`) |
| Build (frontend) | El dashboard compila tras el rename de `AppSidebar.tsx`/`layout.tsx`/`package.json` | `cd seismic-monitor/dashboard && npm install && npm run build` (regenera `package-lock.json` como exige Success Criteria) |
| Config (K8s) | Manifiestos válidos y consistentes tras el rename de namespace/recursos | `kubectl apply --dry-run=client -f deploy/k8s/` |
| Grep de cierre (global) | Ninguna ocurrencia residual de branding viejo fuera de las excepciones de dominio | `rg -n "Seismic Monitor|seismic-monitor|seismic_monitor" --glob '!node_modules' --glob '!package-lock.json' --glob '!.git'` sobre todo el repo — debe listar SOLO las excepciones documentadas en Decisión 3 (o cero, si se decide no dejar ninguna referencia histórica) |
| E2E | No aplica — no hay infraestructura E2E en este repo para este flujo y el change no introduce comportamiento nuevo verificable por E2E | — |

## Migration / Rollout

No aplica migración de datos ni schema. Es un rename de strings/labels/config.
Rollout: `git revert` del/los commits del change (ver Rollback Plan de
`proposal.md`). Dado que no hay cluster K8s vivo (confirmado por el usuario),
no hay coordinación de despliegue real requerida — los manifiestos renombrados
son el primer despliegue con este nombre, no una migración de uno existente.

## Open Questions

Ninguna que bloquee el diseño. Todas las decisiones de esta ronda quedaron
resueltas con evidencia directa del código (lectura real de archivos, no
inferencia). Punto de atención para `sdd-tasks`/`sdd-apply` (no bloqueante,
ya cubierto por la Decisión 5): re-verificar en el momento de aplicar que
`AppSidebar.tsx`/`layout.tsx` no cambiaron desde esta sesión de diseño, por si
`redesign-dashboard-page` avanza en paralelo.
