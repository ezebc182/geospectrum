# Proposal: Rename "Seismic Monitor" to "GeoSpectrum"

## Intent

El usuario compró el dominio `geospectrum.org` y quiere renombrar el producto de
"Seismic Monitor" a "GeoSpectrum" en todo el codebase: código, UI, documentación,
CLI y despliegue (K8s/Docker), incluyendo métricas Prometheus.

En el mismo change se corrige un bug de CORS encontrado durante la exploración:
`src/config/settings.py` ya tiene una property `cors_origins_list` correctamente
implementada que nunca se conecta a `src/main.py`, el cual usa una lista
hardcodeada de 4 orígenes en su lugar. Se agrupa en este change porque comparte
archivo (`src/main.py`) con el rename del título de servicio y es de bajo costo
resolverlo ahora.

CONFIRMADO POR EL USUARIO: no hay cluster K8s ni dashboard de Grafana activo en
producción/staging usando los nombres actuales — es seguro renombrar sin
coordinar downtime.

## Scope

### In Scope

**Branding (rename "Seismic Monitor" / "seismic-monitor" / "seismic_monitor" → "GeoSpectrum" / "geospectrum"):**

- Frontend: `dashboard/app/layout.tsx` (metadata title/description), `dashboard/components/AppSidebar.tsx` (texto de logo activo), `dashboard/components/Header.tsx` (texto de logo, componente sin imports — código muerto, se actualiza igual por consistencia), `dashboard/package.json` (`name`), `dashboard/lib/api.ts` y `dashboard/lib/types.ts` (headers JSDoc), `dashboard/README.md`, `dashboard/FEATURES.md`, `dashboard/start-dashboard.sh`
- Backend: `src/main.py` (título FastAPI visible en `/docs`, respuesta de `GET /`, logs de arranque/cierre, 5 métricas Prometheus `seismic_monitor_*` → `geospectrum_*`), `src/observability/logging_config.py` (campo `service` fijo en JSON formatter), `src/observability/metrics.py` (~15 métricas con prefijo `seismic_` → `geospectrum_`), `pyproject.toml` (`name`, `description`, `authors`), `src/__init__.py`, `tests/__init__.py`, `scripts/seismic-cli.py` (docstrings, banner, descripción de argparse), `scripts/run-local.sh`, `scripts/run-docker.sh`, `LICENSE` (copyright holder)
- Tests acoplados a los strings de branding: `tests/integration/test_api.py` (aserciones sobre `data["service"]` y prefijo de métrica en `/metrics`)
- Docs: `README.md`, `docs/API.md`, `docs/RUNBOOK.md` (incluye ~25 ejemplos `kubectl -n seismic-monitor` → `-n geospectrum`)
- K8s/Docker: `deploy/k8s/*.yaml` (namespace, configmap, secret —solo nombre del recurso, no el valor de password—, hpa, service, servicemonitor, deployment —imagen, contenedor, anti-afinidad—, kustomization, ingress —dominio placeholder → `geospectrum.org` real), `deploy/docker/docker-compose.yml` (servicio, red), `Dockerfile` (label), `deploy/prometheus.yml` o equivalente (scrape job/target)

**Fix de CORS:**

- `src/config/settings.py:85` — ampliar el default de `cors_allowed_origins` de 2 a 4 orígenes (agregar las variantes `127.0.0.1`) para no romper desarrollo local sin `.env`
- `src/main.py:158-169` — reemplazar la lista hardcodeada de `allow_origins` por `settings.cors_origins_list`
- Agregar un test básico de CORS (no existe ninguno hoy)

### Out of Scope

- Vocabulario de dominio: NO se renombra nada que use "seismic" como concepto de dominio (terremoto/sísmico), solo lo que es branding/nombre de producto. Explícitamente fuera de scope:
  - `src/models/event.py::SeismicEvent`
  - `dashboard/components/SeismicMap.tsx`, `SeismicMapWithCities.tsx`, `AdvancedSeismicMap.tsx`
  - `dashboard/lib/seismic-cities.ts` (tipo `SeismicCity`, constante `HIGH_RISK_SEISMIC_CITIES`)
  - Clase Tailwind `text-seismic-600`
  - Cualquier otro uso de "seismic" que describa el fenómeno físico, no el producto
- Corregir el valor de password en texto plano de `deploy/k8s/secret.yaml` (deuda técnica ya documentada por separado; en este change solo se renombra el nombre del recurso, no se toca el valor)
- Registrar/verificar el dominio `geospectrum.org` a nivel DNS/hosting (fuera del alcance de código)
- `package-lock.json` no se edita a mano — se regenera con `npm install` como parte de la validación del change

## Approach

Rename mecánico guiado por búsqueda case-sensitive de los tres patrones
(`Seismic Monitor`, `seismic-monitor`, `seismic_monitor`) archivo por archivo,
excluyendo explícitamente los usos de dominio listados en Out of Scope. Se separa
en fases para poder verificar cada capa de forma independiente:

1. Backend (código + métricas + tests acoplados)
2. Frontend (UI + package.json)
3. Docs
4. K8s/Docker/Prometheus
5. Fix de CORS (independiente del rename, agrupado por tocar `src/main.py`)

Convención de naming adoptada (no había una regla previa en el repo):

| Contexto | Forma |
|---|---|
| Display/título (UI, docs, FastAPI title) | `GeoSpectrum` |
| kebab-case (`package.json` name, `pyproject.toml` name, namespace K8s) | `geospectrum` |
| Prefijo de logs/métricas | `geospectrum` (minúscula) |

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `dashboard/app/layout.tsx` | Modified | Metadata title/description |
| `dashboard/components/AppSidebar.tsx` | Modified | Texto de logo en sidebar (activo) |
| `dashboard/components/Header.tsx` | Modified | Texto de logo (componente sin imports, código muerto) |
| `dashboard/package.json` | Modified | `name: seismic-monitor-dashboard` → `geospectrum-dashboard` |
| `dashboard/lib/api.ts`, `dashboard/lib/types.ts` | Modified | Headers JSDoc cosméticos |
| `dashboard/README.md`, `FEATURES.md`, `start-dashboard.sh` | Modified | Branding en docs y scripts del dashboard |
| `src/main.py` | Modified | Título FastAPI, respuesta `GET /`, logs, 5 métricas `seismic_monitor_*`, fix de CORS (`allow_origins=settings.cors_origins_list`) |
| `src/observability/logging_config.py` | Modified | Campo `service` fijo en JSON formatter |
| `src/observability/metrics.py` | Modified | ~15 métricas Prometheus `seismic_*` → `geospectrum_*` |
| `src/config/settings.py` | Modified | Ampliar default de `cors_allowed_origins` a 4 orígenes (fix de CORS) |
| `pyproject.toml`, `src/__init__.py`, `tests/__init__.py` | Modified | Nombre de paquete, docstrings |
| `scripts/seismic-cli.py`, `run-local.sh`, `run-docker.sh` | Modified | Docstrings, banners |
| `LICENSE` | Modified | Copyright holder |
| `tests/integration/test_api.py` | Modified | Aserciones de `service` y prefijo de métrica en `/metrics`; nuevo test de CORS |
| `README.md`, `docs/API.md`, `docs/RUNBOOK.md` | Modified | Branding y ejemplos `kubectl -n` |
| `deploy/k8s/*.yaml` | Modified | Nombres de recursos, imagen, ingress con dominio real `geospectrum.org` |
| `deploy/docker/docker-compose.yml`, `Dockerfile` | Modified | Nombre de servicio/red, label |
| `deploy/prometheus.yml` (o equivalente) | Modified | Nombre de scrape job/target |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Colisión con el change `redesign-dashboard-page` (implementado en código, aún no archivado), que también toca `AppSidebar.tsx` y `layout.tsx` | Medium | Antes de tocar esos archivos en este change, releer su estado actual en disco (no asumir el contenido de la exploración) y aplicar el rename como diff incremental sobre lo ya implementado, no como sobrescritura |
| Renombrar métricas Prometheus rompe el contrato de observabilidad si algo externo ya scrapea con el prefijo viejo | Low | Confirmado por el usuario que no hay dashboards/alertas activos hoy; se documenta la decisión en el change para que quede registro si en el futuro se agregan paneles de Grafana |
| Editar `package-lock.json` a mano genera inconsistencia con `package.json` | Low | No se edita a mano; se regenera con `npm install` como parte de la verificación |
| Ampliar el default de `cors_allowed_origins` con un valor incorrecto rompe CORS en local sin `.env` | Low | Nuevo default explícito: `http://localhost:3008,http://localhost:3000,http://127.0.0.1:3008,http://127.0.0.1:3000` (superset exacto de las 4 URLs que ya estaban hardcodeadas en `main.py`) |
| Desalineación de documentación si `docs/RUNBOOK.md` no se actualiza en el mismo change (K8s está en scope) | Medium | Los ~25 ejemplos `kubectl -n seismic-monitor` se actualizan a `-n geospectrum` como parte de este mismo change, no se pospone |
| Inconsistencia si queda algún archivo con el nombre viejo tras el rename manual | Medium | Verificación final con búsqueda case-sensitive de los 3 patrones sobre todo el repo (excluyendo `node_modules`, `.git`, `package-lock.json`) antes de cerrar el change |

## Rollback Plan

El change es puramente de renombrado de strings/identificadores + un fix de
configuración aislado (CORS). No hay migraciones de datos ni cambios de schema.
Rollback es un `git revert` del/los commit(s) del change. Si ya se desplegaron
recursos K8s con los nuevos nombres, revertir requiere primero aplicar los
manifiestos viejos (`kubectl apply -f deploy/k8s/` con la versión anterior) antes
de revertir el código, para evitar recursos huérfanos con el nombre nuevo.

## Dependencies

- Ninguna dependencia externa bloqueante. El dominio `geospectrum.org` ya está
  comprado por el usuario (confirmado), por lo que el placeholder de
  `deploy/k8s/ingress.yaml` puede apuntar a un dominio real.
- Coordinar con el estado de `redesign-dashboard-page` (change previo, no
  archivado) antes de tocar `AppSidebar.tsx` y `layout.tsx` — ver Risks.

## Success Criteria

- [x] Ninguna ocurrencia de `Seismic Monitor` / `seismic-monitor` / `seismic_monitor`
      permanece en el repo como branding, excepto los usos de dominio listados en
      Out of Scope (verificable con búsqueda case-sensitive)
      EVIDENCIA: grep repo-wide (tasks.md 5.2) confirma 0 matches de branding
      sin resolver fuera de: (a) nombre del directorio del repo en disco
      (`README.md`, `dashboard/FEATURES.md` — no es branding, es la ruta real
      del proyecto), (b) artefactos de proceso `openspec/**` de este mismo
      change y de otros changes (no código de producto), (c) docs de un
      change no relacionado (`docs/superpowers/**`). Se corrigió además una
      inconsistencia real encontrada en `dashboard/README.md` no prevista por
      design.md. HALLAZGO reportado (no bloqueante, fuera del scope
      declarado): `ADVANCED_FEATURES_V2.md` tiene 4 métricas
      `seismic_monitor_*` que no existen en el código fuente — ver nota de
      cierre en tasks.md.
- [x] `GET /` responde `{"service": "GeoSpectrum", ...}` y `/docs` muestra el
      título `GeoSpectrum Service` (o equivalente definido en Approach)
      EVIDENCIA: verificado con `TestClient` real (tasks.md 5.5) —
      `GET /` devuelve `{"service": "GeoSpectrum", "version": "1.0.0", ...}`;
      `app.title == "GeoSpectrum Service"`.
- [x] Todas las métricas Prometheus expuestas en `/metrics` usan el prefijo
      `geospectrum_`
      EVIDENCIA: las 7 métricas de producto (`requests_total`,
      `events_fetched_total`, `alerts_generated_total`,
      `data_source_errors_total`, `request_duration_seconds`,
      `source_fetch_duration_seconds`, `source_errors_total`) expuestas con
      prefijo `geospectrum_`; 0 líneas con `seismic_monitor_` en `/metrics`
      (verificado con `TestClient`, tasks.md 5.5).
- [x] `tests/integration/test_api.py` pasa con las aserciones actualizadas
      EVIDENCIA: 13/13 tests de `test_api.py` pasan en verde, incluyendo
      `test_root_endpoint`, `test_metrics_endpoint`, y el nuevo
      `test_cors_allows_configured_origins` (tasks.md 5.3).
- [x] CORS usa `settings.cors_origins_list` y un test básico de CORS pasa
      EVIDENCIA: `src/main.py` usa `allow_origins=settings.cors_origins_list`
      (Fase 0); `test_cors_allows_configured_origins` pasa en verde.
- [x] `docs/RUNBOOK.md` no contiene ningún ejemplo `kubectl -n seismic-monitor`
      EVIDENCIA: `rg -n "kubectl -n seismic-monitor" docs/RUNBOOK.md` → 0
      resultados.
- [~] Manifiestos K8s aplican sin error (`kubectl apply --dry-run=client -f deploy/k8s/`)
      EVIDENCIA PARCIAL: `kubectl apply --dry-run=client` (con y sin
      `--validate=false`) falla en este entorno sandboxed porque intenta
      contactar un API server real (`127.0.0.1:6443`, connection refused) —
      no hay cluster disponible, ni siquiera local. Se usó `kubectl kustomize
      deploy/k8s/` como verificación equivalente 100% local: compiló sin
      errores, namespace `geospectrum` consistente en los 8 recursos,
      selectors/labels alineados entre Deployment/Service/HPA, dominio de
      ingress resuelto a `geospectrum.org`. Verificación pendiente para el
      usuario contra un cluster real (o kind/minikube) antes de un despliegue
      efectivo — no bloqueante para cerrar este change.
- [x] `dashboard/package-lock.json` regenerado y consistente con `package.json`
      (vía `npm install`, no edición manual)
      EVIDENCIA: `"name": "geospectrum-dashboard"` consistente en ambos
      archivos; regenerado en Fase 2 (tarea 2.8) vía `npm install`.
