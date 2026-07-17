# Tasks: Rename "Seismic Monitor" to "GeoSpectrum"

Referencias de trazabilidad: `[Req-N]` apunta a los Requirements de
`specs/product-branding/spec.md` (N = orden de aparición). `[Dx]` apunta a las
Decisiones de `design.md`.

## Phase 0: Fix de CORS (independiente del rename)

- [x] 0.1 Editar `src/config/settings.py:85` — cambiar el default de
      `cors_allowed_origins` de 2 a 4 orígenes:
      `"http://localhost:3008,http://localhost:3000,http://127.0.0.1:3008,http://127.0.0.1:3000"`.
      No tocar la property `cors_origins_list` (L87-90), ya está correcta.
      [D2] [Req-3, escenario "Las 4 variantes locales están habilitadas por defecto"]
- [x] 0.2 Editar `src/main.py:158-169` — reemplazar la lista hardcodeada de
      `allow_origins` en `CORSMiddleware` por `settings.cors_origins_list`.
      Verificar que no quede ningún literal `["http://localhost:3008", ...]`
      pasado directamente a `allow_origins`.
      [D2] [Req-3, escenario "No existe una segunda lista de orígenes hardcodeada"]
- [x] 0.3 Agregar `test_cors_allows_configured_origins` en
      `tests/integration/test_api.py`, después de `test_metrics_endpoint`
      (~línea 76), mismo estilo/fixture `client` que los tests existentes:
      `GET /health` con header `Origin: http://localhost:3008`, asertar
      `status_code == 200` y `headers["access-control-allow-origin"] == "http://localhost:3008"`.
      [D2] [Req-3, escenario "Test de regresión de CORS pasa en verde"]
- [x] 0.4 Ejecutar `cd seismic-monitor && pytest tests/integration/test_api.py -k cors`
      y confirmar que el nuevo test pasa en verde antes de avanzar a Fase 1.

## Phase 1: Backend rename

- [x] 1.1 Editar `src/main.py` — título/descr. FastAPI (L146-147):
      `title="Seismic Monitor Service"` → `title="GeoSpectrum Service"`.
      [D3] [Req-1, escenario "Título de OpenAPI/Swagger"]
- [x] 1.2 Editar `src/main.py` — respuesta de `GET /` (L624):
      `"service": "Seismic Monitor"` → `"service": "GeoSpectrum"`.
      [D3] [Req-1, escenario "Respuesta del endpoint raíz"]
- [x] 1.3 Editar `src/main.py` — logs de arranque/cierre (L101, L138) que
      mencionan "Seismic Monitor" → "GeoSpectrum".
      [D3] [Req-1]
- [x] 1.4 Editar `src/main.py` — renombrar las 5 métricas de producto con
      prefijo `seismic_monitor_` → `geospectrum_` en L57 (`requests_total`),
      L63 (`events_fetched`), L69 (`alerts_generated`), L75
      (`data_source_errors`), L82 (`request_duration`). NO tocar ninguna otra
      métrica en este archivo que no tenga el prefijo `seismic_monitor_`.
      [D3] [Req-2, escenario "Métricas de producto expuestas con nuevo prefijo"]
- [x] 1.5 Editar `src/observability/metrics.py` — renombrar EXCLUSIVAMENTE las
      2 constantes con prefijo de producto: `source_fetch_duration_seconds`
      (L118: `"seismic_monitor_source_fetch_duration_seconds"` →
      `"geospectrum_source_fetch_duration_seconds"`) y `source_errors_total`
      (L125: `"seismic_monitor_source_errors_total"` →
      `"geospectrum_source_errors_total"`).
      [D3] [Req-2]
- [x] 1.6 Verificación negativa: confirmar que las 13 métricas de dominio en
      `src/observability/metrics.py` (prefijo `seismic_` sin `_monitor_`,
      incluyendo las familias `seismic_emsc_*`, `seismic_usgs_*`,
      `seismic_dispatcher_*`, `seismic_redis_*`, `seismic_sse_*`,
      `seismic_archive_*`, L19-110) siguen EXACTAMENTE igual, sin ninguna
      modificación de nombre. Ejecutar
      `rg -n 'seismic_(?!monitor)' src/observability/metrics.py` y confirmar
      que hay 13 definiciones intactas y NINGUNA con prefijo `seismic_monitor_`
      remanente.
      [D3] [Req-4, escenario "Las 13 métricas de dominio en metrics.py permanecen con prefijo seismic_"]
- [x] 1.7 Editar `src/observability/logging_config.py` — campo fijo `service`
      del formatter JSON (docstring L9, valor L52): `"seismic-monitor"` →
      `"geospectrum"`.
      [D3] [Req-1, escenario "Campo service en logs estructurados"]
- [x] 1.8 Editar `pyproject.toml` (`name`, `description`, `authors`),
      `src/__init__.py`, `tests/__init__.py` — branding en nombre de paquete y
      docstrings.
      [D3]
- [x] 1.9 Editar `scripts/seismic-cli.py` (docstrings, banner, descripción de
      argparse), `scripts/run-local.sh`, `scripts/run-docker.sh` — branding en
      texto visible, sin renombrar el propio archivo `seismic-cli.py` (fuera
      de scope según proposal.md, que solo lista contenido a editar).
      [D3]
- [x] 1.10 Editar `LICENSE` — copyright holder de "Seismic Monitor" a
      "GeoSpectrum".
      [D3]
- [x] 1.11 Actualizar `tests/integration/test_api.py` en la MISMA tarea que
      rompe estas aserciones (consecuencia directa de 1.1-1.5): editar
      `test_root_endpoint` (L66) para verificar `data["service"] == "GeoSpectrum"`
      (ya no `"Seismic Monitor"`), y `test_metrics_endpoint` (L75) para
      verificar la presencia de al menos una métrica con prefijo
      `geospectrum_` (ej. `geospectrum_requests_total`), ya no
      `seismic_monitor_*`. No modificar ninguna aserción sobre `SeismicEvent`
      u otro símbolo de dominio en este mismo archivo.
      [Req-6, escenarios "test_root_endpoint verifica el nuevo valor de service" y "test_metrics_endpoint verifica el nuevo prefijo de métrica"]
- [x] 1.12 Ejecutar `cd seismic-monitor && pytest tests/integration/test_api.py`
      completo y confirmar que `test_root_endpoint`, `test_metrics_endpoint`,
      y `test_cors_allows_configured_origins` (de 0.3) pasan en verde antes de
      avanzar a Fase 2.
      [Req-6, escenario "La suite completa de tests de integración pasa en verde"]

## Phase 2: Frontend rename

- [x] 2.1 Releer en disco (con la herramienta de lectura, no confiar en el
      contenido citado en proposal.md/design.md) el estado actual completo de
      `dashboard/components/AppSidebar.tsx` y `dashboard/app/layout.tsx`.
      Confirmar que el texto `Seismic Monitor` sigue apareciendo literal en
      `AppSidebar.tsx` (esperado ~L52, dentro de un `<span>` en
      `SidebarHeader`) y que `'Seismic Monitor Dashboard'` sigue en
      `layout.tsx` (esperado ~L25, `metadata.title`). Esta verificación es
      obligatoria por la colisión conocida con el change
      `redesign-dashboard-page` (implementado, no archivado). Si el texto ya
      no aparece literal en esas líneas, DETENER esta fase y reportar la
      discrepancia en vez de forzar el reemplazo por posición de línea.
      [D5]
- [x] 2.2 Con la confirmación de 2.1, aplicar el diff puntual de una sola
      línea en `dashboard/components/AppSidebar.tsx`: `Seismic Monitor` →
      `GeoSpectrum`, sin tocar imports, estructura ni ningún otro texto del
      componente.
      [D5]
- [x] 2.3 Con la confirmación de 2.1, aplicar el diff puntual en
      `dashboard/app/layout.tsx`: `title: 'Seismic Monitor Dashboard'` →
      `title: 'GeoSpectrum Dashboard'`. NO tocar `metadata.description`
      (vocabulario de dominio "seismic monitoring", fuera de scope).
      [D5]
- [x] 2.4 Editar `dashboard/components/Header.tsx` — texto de logo
      (componente sin imports/código muerto, se actualiza igual por
      consistencia según proposal.md).
      [D3]
- [x] 2.5 Editar `dashboard/package.json` — `name`:
      `seismic-monitor-dashboard` → `geospectrum-dashboard`.
      [D3]
- [x] 2.6 Editar `dashboard/lib/api.ts` y `dashboard/lib/types.ts` — headers
      JSDoc cosméticos con branding, sin tocar ningún tipo/símbolo de dominio
      sísmico (ej. `SeismicCity` en `dashboard/lib/seismic-cities.ts` NO se
      toca).
      [D3] [Req-4, escenario "Tipos y componentes de dominio sin cambios"]
- [x] 2.7 Editar `dashboard/README.md`, `dashboard/FEATURES.md`,
      `dashboard/start-dashboard.sh` — branding en docs y scripts del
      dashboard.
      [D3]
- [x] 2.8 Regenerar `dashboard/package-lock.json` ejecutando
      `cd seismic-monitor/dashboard && npm install` (nunca editar a mano, ver
      Out of Scope de proposal.md).
- [x] 2.9 Ejecutar `cd seismic-monitor/dashboard && npm run build` y confirmar
      que el dashboard compila sin errores tras el rename de
      `AppSidebar.tsx`/`layout.tsx`/`Header.tsx`/`package.json`.

## Phase 3: Docs

- [x] 3.1 Editar `README.md` (raíz del proyecto) — branding "Seismic Monitor"
      / "seismic-monitor" / "seismic_monitor" → "GeoSpectrum" / "geospectrum",
      preservando cualquier mención de "seismic" como vocabulario de dominio
      (monitoreo sísmico).
      [D3]
- [x] 3.2 Editar `docs/API.md` — branding y cualquier ejemplo de request/
      response que muestre el `service` o prefijo de métricas viejos,
      alineado con el contrato definido en 1.1-1.5.
      [D3]
- [x] 3.3 Editar `docs/RUNBOOK.md` — branding general y los ~25 ejemplos
      `kubectl -n seismic-monitor` → `kubectl -n geospectrum` (el nombre de
      namespace debe coincidir exactamente con el fijado en Fase 4/Decisión 4,
      aunque se escribe en esta fase según el orden ya decidido en design.md).
      [D1] [Req-5, escenario "Namespace K8s consistente entre todos los manifiestos"]
- [x] 3.4 Ejecutar
      `rg -n "Seismic Monitor|seismic-monitor|seismic_monitor" README.md docs/`
      y confirmar 0 resultados antes de avanzar a Fase 4.

## Phase 4: K8s/Docker/Prometheus

- [x] 4.1 Renombrar `metadata.namespace: seismic-monitor` → `geospectrum` en
      los 8 manifiestos que lo tienen bajo `deploy/k8s/`: `secret.yaml`,
      `configmap.yaml`, `hpa.yaml`, `ingress.yaml`,
      `deployment-inpres-adapter.yaml`, `service.yaml` (2 ocurrencias, L5 y
      L23), `servicemonitor.yaml`, `deployment.yaml`.
      [D4]
- [x] 4.2 Renombrar `deploy/k8s/namespace.yaml` — `metadata.name` y
      `metadata.labels.name` de `seismic-monitor` → `geospectrum`.
      [D4]
- [x] 4.3 Renombrar `deploy/k8s/kustomization.yaml` — `namespace:` (L5),
      `commonLabels.project` (L20), `images[0].name` y `images[0].newName`
      (`ghcr.io/your-org/seismic-monitor` → `ghcr.io/your-org/geospectrum`,
      L25-26).
      [D4]
- [x] 4.4 Renombrar recursos con nombre propio en cada manifiesto de
      `deploy/k8s/` (`metadata.name` / `app:` labels / `selector` / nombre de
      contenedor / nombre de imagen): `seismic-monitor-secrets`,
      `seismic-monitor-config`, `seismic-monitor-hpa`, `seismic-monitor-ingress`,
      `seismic-monitor-service`, `seismic-monitor` (deployment,
      servicemonitor, container name, image, pod anti-affinity en
      `deployment.yaml:110`) → equivalentes con `geospectrum`.
      [D4]
- [x] 4.5 Editar `deploy/k8s/ingress.yaml` — reemplazar el placeholder de
      dominio `seismic.example.com` (L31, L34) por el dominio real
      `geospectrum.org`. Tratar esto como cambio de VALOR de dominio, no como
      parte del rename de namespace/recursos.
      [D4] [Req-5, escenario "Dominio de ingress apunta al dominio real comprado"]
- [x] 4.6 Editar `deploy/docker/docker-compose.yml` Y `deploy/docker/prometheus.yml`
      EN LA MISMA TAREA (no en momentos distintos, para que Prometheus nunca
      quede apuntando a un target roto): en `docker-compose.yml` renombrar
      `seismic-monitor` (comentario L4/L7, nombre de servicio L18,
      `container_name` L23, `image` L22) → `geospectrum`, y la red
      `seismic-net` (L61,81,105,127,152) → `geospectrum-net`; en
      `prometheus.yml` renombrar `job_name: 'seismic-monitor'` →
      `job_name: 'geospectrum'` y `targets: ['seismic-monitor:8000']` →
      `targets: ['geospectrum:8000']`, verificando que el nombre coincide
      exactamente con el nuevo nombre de servicio de `docker-compose.yml`.
      [D4] [Req-5, escenario "Docker Compose y Prometheus referencian el mismo nombre de servicio"]
- [x] 4.7 Editar `deploy/k8s/README.md` — los 5 usos de
      `kubectl ... -n seismic-monitor` y el nombre del secret en el comando de
      ejemplo (L54) → `geospectrum`; el dominio de ejemplo (L63) →
      `geospectrum.org`.
      [D4]
- [x] 4.8 Editar `deploy/docker/Dockerfile` (L2 comentario, L9-10 labels) y
      `deploy/docker/Dockerfile.inpres-adapter` (L7 label maintainer):
      `Seismic Monitor` / `seismic-ops@example.com` → `GeoSpectrum` /
      `geospectrum-ops@example.com`.
      [D3] [D4]
- [x] 4.9 Verificación negativa: confirmar que
      `TIMESCALEDB_USER: "seismic"`, `POSTGRES_USER: seismic`,
      `POSTGRES_DB: seismic` en `deploy/k8s/secret.yaml` y
      `docker-compose.yml`, y el valor del password en texto plano en
      `secret.yaml`, permanecen SIN CAMBIOS (nombre de usuario/BD técnica y
      deuda técnica documentada por separado, ambos fuera de scope).
- [x] 4.10 Grep de cierre de Fase 4 — ejecutar
      `rg -n "seismic-monitor|seismic_monitor|Seismic Monitor" deploy/` y
      confirmar 0 resultados. Si aparece algún resultado, la fase NO está
      completa: no cerrar con matches pendientes salvo que se etiqueten
      explícitamente `# HISTORICAL:` (no aplica ninguna excepción de este tipo
      según el relevamiento de design.md).
      [D4] [Req-5, escenario "Grep de cierre sobre deploy/ no encuentra branding viejo"]
- [x] 4.11 Ejecutar `kubectl apply --dry-run=client -f deploy/k8s/` y
      confirmar que corre sin error de referencia rota entre namespace,
      secret, configmap, service y demás recursos.
      [D4] [Req-5, escenario "Manifiestos K8s aplican sin error de referencia rota"]
      NOTA DE EJECUCIÓN: en este entorno sandboxed `kubectl apply
      --dry-run=client` (y también con `--validate=false`) intenta contactar
      un API server real (`127.0.0.1:6443`) incluso en modo client-side, y no
      hay ningún cluster disponible (ni siquiera local/kind) — falla con
      `connection refused`, no por un error de los manifiestos. Se usó
      `kubectl kustomize deploy/k8s/` como verificación equivalente (build
      100% local, sin red): compiló sin errores y el YAML resultante muestra
      namespace `geospectrum` consistente en los 8 recursos, `Deployment`→
      `Service`→`HPA` con selectors/labels alineados, y el único residuo de
      "seismic" en el output renderizado es `TIMESCALEDB_USER: seismic`
      (excepción de vocabulario técnico ya documentada). Verificación
      pendiente para el usuario: correr `kubectl apply --dry-run=client -f
      deploy/k8s/` contra un cluster real (o kind/minikube) antes de un
      despliegue real — no es bloqueante para cerrar este change.

## Phase 5: Verificación final global

- [x] 5.1 Ejecutar
      `rg -n "seismic-monitor|seismic_monitor|Seismic Monitor" deploy/` una
      vez más sobre el estado final del repo (repetición de 4.10 como
      verificación de cierre de todo el change, no solo de Fase 4) y confirmar
      0 resultados.
      [Req-5, escenario "Grep de cierre sobre deploy/ no encuentra branding viejo"]
      RESULTADO: 0 resultados (exit code 1 de rg = sin matches). Confirmado.
- [x] 5.2 Ejecutar la búsqueda global de cierre sobre todo el repo:
      `rg -n "Seismic Monitor|seismic-monitor|seismic_monitor" --glob '!node_modules' --glob '!package-lock.json' --glob '!.git'`
      y confirmar que los ÚNICOS resultados (si los hay) son excepciones de
      dominio explícitamente documentadas en Decisión 3 de design.md
      (`SeismicEvent`, `SeismicMap*`, `SeismicCity`/`HIGH_RISK_SEISMIC_CITIES`,
      `text-seismic-600`, las 13 métricas `seismic_*` de dominio en
      `metrics.py`, `seismic` como usuario/BD técnica, `seismic.example.com`
      si quedara alguna referencia residual no cubierta por 4.5/4.7). Ningún
      otro match es aceptable.
      [Req-4] [Req-5]
      RESULTADO: se encontró y corrigió una inconsistencia real no prevista
      por el design (fuera de la lista cerrada de Decisión 3):
      `dashboard/README.md:190,192` tenía un ejemplo de `docker-compose.yml`
      del dashboard con `http://seismic-monitor:8000` y `depends_on:
      - seismic-monitor`, que quedó desalineado con el rename de servicio de
      Fase 4 (`docker-compose.yml` → `geospectrum`). Corregido en esta misma
      tarea (`geospectrum:8000` / `depends_on: - geospectrum`) por ser
      consecuencia directa de la Fase 4, no un cambio de scope nuevo.
      Excluyendo `openspec/**` (artefactos de proceso de este mismo change y
      de otros changes, no código de producto) y `docs/superpowers/**`
      (planes/specs de un change no relacionado, `realtime-event-stream`,
      fuera de este change), quedan 2 categorías de matches SIN modificar,
      ambas reportadas al usuario en el resumen de cierre:
      (a) `README.md:26,298` y `dashboard/FEATURES.md:129` — nombre real del
      directorio del repo en disco
      (`/Users/ezebc182/.../espectro-chechu/seismic-monitor/`), no branding de
      producto; el repo no fue renombrado como carpeta. Excepción de dominio
      no listada explícitamente en Decisión 3 pero de la misma naturaleza que
      "nombre de directorio del repo" — NO se toca sin instrucción explícita
      de renombrar el repo físico.
      (b) `ADVANCED_FEATURES_V2.md:396,399,402,405` — 4 métricas
      `seismic_monitor_*` (`event_detail_requests_total`,
      `rupture_models_found_total`, `emsc_errors_total`,
      `emsc_request_duration_seconds`) que NO existen en el código fuente
      (`rg` sobre `src/` no encuentra ninguna) y que no están en la lista
      cerrada de 7 métricas de producto de Decisión 3/spec. El archivo entero
      no aparece en proposal.md ni design.md (fuera del scope declarado de
      este change). Se reporta como HALLAZGO, no se modifica unilateralmente
      — requiere decisión del usuario: o es documentación de un roadmap nunca
      implementado (en cuyo caso el rename es cosmético y de bajo riesgo), o
      señala una feature real pendiente de auditar por separado.
- [x] 5.3 Correr la suite completa de tests backend:
      `cd seismic-monitor && pytest` y confirmar que pasa sin fallos ni
      errores (incluye `test_root_endpoint`, `test_metrics_endpoint`,
      `test_cors_allows_configured_origins`, y cualquier otro test existente
      no relacionado con branding que no debe romperse).
      [Req-6, escenario "La suite completa de tests de integración pasa en verde"]
      RESULTADO: `1 failed, 67 passed, 7 errors` en la suite completa.
      `tests/integration/test_api.py` (13 tests, incluye los 3 de branding/CORS)
      pasa 100% en verde de forma aislada. El failed
      (`test_geo_utils.py::test_ms_to_iso`) y los 7 errors
      (`test_redis_pubsub_bus.py::*`, `docker.errors.DockerException`) son
      preexistentes y no relacionados con este change — mismo patrón
      documentado en el change archivado previo
      (`archive/2026-07-13-unify-dashboard-events-source/tasks.md:70`): fecha
      hardcodeada con paso del tiempo, y Docker no disponible en este entorno
      sandboxed.
- [x] 5.4 Correr `cd seismic-monitor/dashboard && npm run build` y
      `cd seismic-monitor/dashboard && npx tsc --noEmit` y confirmar que
      ambos terminan sin errores tras el rename completo de frontend.
      RESULTADO: ambos terminan sin errores. `npm run build` compiló, tipeó y
      generó las 8 páginas estáticas correctamente; `tsc --noEmit` exit 0 sin
      output.
- [x] 5.5 Confirmar manualmente, contra las Success Criteria de
      `proposal.md`, que: `GET /` responde `{"service": "GeoSpectrum", ...}`;
      `/docs` muestra el título `GeoSpectrum Service`; `GET /metrics` expone
      únicamente las 7 métricas de producto con prefijo `geospectrum_` (no
      `seismic_monitor_`) junto con las 13 métricas de dominio `seismic_*`
      intactas; y `dashboard/package-lock.json` quedó regenerado (no editado a
      mano) y consistente con `dashboard/package.json`.
      [Req-1] [Req-2] [Req-4]
      RESULTADO: verificado con `TestClient` real contra la app FastAPI.
      `GET /` → `{"service": "GeoSpectrum", "version": "1.0.0", ...}`.
      `app.title == "GeoSpectrum Service"`. `GET /metrics` expone las 7
      familias `geospectrum_*` (`requests_total`, `events_fetched_total`,
      `alerts_generated_total`, `data_source_errors_total`,
      `request_duration_seconds`, `source_fetch_duration_seconds`,
      `source_errors_total`) con HELP/TYPE correctos, y 0 líneas con
      `seismic_monitor_`. Las métricas de dominio con prefijo `seismic_`
      (14 definiciones base en `metrics.py`, ~18 series contando variantes
      `_created` de Prometheus) permanecen intactas — el spec dice "13 (...)
      o más" de forma no exhaustiva ("incluyendo, entre otras"), no es una
      lista cerrada, así que no hay discrepancia real.
      `dashboard/package-lock.json` — `"name": "geospectrum-dashboard"`
      consistente con `package.json`, confirmado regenerado vía `npm install`
      (Fase 2, tarea 2.8).

## Nota de cierre del change

Change **COMPLETO**. Las 6 fases (0-5) están marcadas `[x]`. Verificación
funcional real ejecutada (no solo grep): suite de tests backend, build +
typecheck de frontend, contrato HTTP runtime contra `TestClient`, y build
local de Kubernetes vía `kubectl kustomize` (sin cluster disponible en este
entorno, ver nota en tarea 4.11).

Dos hallazgos quedan fuera del scope original del change y se reportan para
decisión del usuario, no bloquean el cierre:
1. `dashboard/README.md` tenía una inconsistencia real (no prevista por
   design.md) generada por el propio rename de Fase 4 — ya corregida en 5.2.
2. `ADVANCED_FEATURES_V2.md` documenta 4 métricas `seismic_monitor_*` que no
   existen en el código fuente y que nunca estuvieron en el scope declarado
   de este change — no modificado, requiere decisión explícita del usuario.
