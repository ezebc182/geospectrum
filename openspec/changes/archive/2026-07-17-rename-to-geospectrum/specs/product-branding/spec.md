# Product Branding Specification — Rename "Seismic Monitor" → "GeoSpectrum"

## Purpose

Especifica el comportamiento observable del servicio backend, de la configuración
de CORS, y de los artefactos de despliegue (K8s/Docker/Prometheus) después de
renombrar el producto de "Seismic Monitor" a "GeoSpectrum", así como la regla
negativa que protege el vocabulario de dominio "seismic" (terremoto/sísmico) de
ser alcanzado por el rename de marca.

No existe un `openspec/specs/product-branding/spec.md` previo en el repositorio
(el dominio de identidad/branding de producto nunca fue especificado antes), por
lo que este documento se redacta como spec completa (no delta), acotada al
alcance de `rename-to-geospectrum`.

Convención de casing adoptada (fijada en `design.md` del change, Approach):

| Contexto | Forma |
|---|---|
| Display/título (UI, docs, FastAPI title) | `GeoSpectrum` |
| kebab-case (`package.json` name, `pyproject.toml` name, namespace K8s) | `geospectrum` |
| Prefijo de logs/métricas | `geospectrum` (minúscula) |

## Requirements

### Requirement: Identidad de servicio expuesta por el backend

El backend MUST identificarse como `GeoSpectrum` en toda superficie HTTP
observable directamente por un cliente o por un operador que consulte la
documentación autogenerada, reemplazando toda referencia previa a
"Seismic Monitor".

#### Scenario: Título de OpenAPI/Swagger

- GIVEN el servicio backend corriendo
- WHEN un cliente solicita `GET /docs` (Swagger UI) o `GET /openapi.json`
- THEN el título del servicio (`info.title` en el schema OpenAPI, mostrado como
  encabezado en Swagger UI) es `GeoSpectrum Service`
- AND el título ya NO contiene la cadena `Seismic Monitor`

#### Scenario: Respuesta del endpoint raíz

- GIVEN el servicio backend corriendo
- WHEN un cliente hace `GET /`
- THEN la respuesta HTTP es 200
- AND el body JSON contiene `"service": "GeoSpectrum"`
- AND el body ya NO contiene `"service": "Seismic Monitor"`

#### Scenario: Campo service en logs estructurados

- GIVEN el servicio backend arrancando o procesando una request, con logging
  estructurado en JSON habilitado (`src/observability/logging_config.py`)
- WHEN se emite cualquier línea de log a través del formatter JSON
- THEN el campo fijo `service` del registro JSON tiene el valor `"geospectrum"`
- AND ningún log estructurado emite `"service": "seismic-monitor"`

### Requirement: Métricas Prometheus de producto usan el prefijo geospectrum

Las métricas Prometheus que identifican al producto/servicio (no las métricas
de dominio sísmico) MUST exponerse bajo el prefijo `geospectrum_` en
`GET /metrics`, reemplazando el prefijo previo `seismic_monitor_`.

Esto aplica exactamente a las 7 métricas de producto identificadas en
`design.md` (Decisión 3 / Interfaces): `requests_total`, `events_fetched`,
`alerts_generated`, `data_source_errors`, `request_duration` (definidas en
`src/main.py`), y `source_fetch_duration_seconds`, `source_errors_total`
(definidas en `src/observability/metrics.py`).

#### Scenario: Métricas de producto expuestas con nuevo prefijo

- GIVEN el servicio backend corriendo y habiendo procesado al menos una request
- WHEN un cliente hace `GET /metrics`
- THEN la respuesta incluye las series `geospectrum_requests_total`,
  `geospectrum_events_fetched_total`, `geospectrum_alerts_generated_total`,
  `geospectrum_data_source_errors_total`, `geospectrum_request_duration_seconds`,
  `geospectrum_source_fetch_duration_seconds`, `geospectrum_source_errors_total`
- AND la respuesta ya NO incluye ninguna serie con prefijo `seismic_monitor_`

#### Scenario: Ninguna métrica huérfana con prefijo viejo

- GIVEN el archivo `src/main.py` y `src/observability/metrics.py` después del
  rename
- WHEN se inspecciona el código fuente en busca del literal `seismic_monitor`
- THEN no aparece ninguna ocurrencia como nombre de métrica Prometheus

### Requirement: Configuración de CORS usa la fuente única de verdad

El middleware CORS del backend MUST construir su lista de orígenes permitidos
exclusivamente a partir de `settings.cors_origins_list`, y MUST NOT mantener
una lista hardcodeada independiente de esa configuración.

`settings.cors_allowed_origins` MUST tener como valor por defecto un superset
exacto de los 4 orígenes de desarrollo local usados históricamente:
`http://localhost:3008`, `http://localhost:3000`, `http://127.0.0.1:3008`,
`http://127.0.0.1:3000`.

#### Scenario: Origen configurado recibe el header CORS correspondiente

- GIVEN el backend corriendo con la configuración por defecto (sin `.env`)
- WHEN un cliente hace `GET /health` enviando el header `Origin: http://localhost:3008`
- THEN la respuesta HTTP es 200
- AND el header de respuesta `access-control-allow-origin` es exactamente
  `http://localhost:3008`

#### Scenario: Las 4 variantes locales están habilitadas por defecto

- GIVEN el backend corriendo con la configuración por defecto (sin `.env`)
- WHEN se inspecciona `settings.cors_origins_list`
- THEN la lista contiene exactamente los 4 orígenes: `http://localhost:3008`,
  `http://localhost:3000`, `http://127.0.0.1:3008`, `http://127.0.0.1:3000`

#### Scenario: No existe una segunda lista de orígenes hardcodeada

- GIVEN el archivo `src/main.py` después del fix
- WHEN se inspecciona la configuración de `CORSMiddleware`
- THEN el parámetro `allow_origins` referencia `settings.cors_origins_list`
- AND no existe ningún literal de lista de URLs (`["http://localhost:3008", ...]`)
  pasado directamente a `allow_origins`

#### Scenario: Test de regresión de CORS pasa en verde

- GIVEN la suite de tests de integración (`tests/integration/test_api.py`)
- WHEN se ejecuta `test_cors_allows_configured_origins`
- THEN el test hace `GET /health` con header `Origin: http://localhost:3008`
- AND verifica `response.status_code == 200`
- AND verifica `response.headers["access-control-allow-origin"] == "http://localhost:3008"`
- AND el test pasa en verde

### Requirement: El vocabulario de dominio "seismic" permanece intacto

El sistema MUST NOT modificar ninguna ocurrencia de "seismic" que describa el
fenómeno físico o concepto de dominio (monitoreo sísmico), incluso cuando
comparta el mismo substring que la marca renombrada. Esta es una prohibición
explícita sobre el mismo conjunto de archivos que sí reciben el rename de
marca — el rename MUST ser selectivo, no un reemplazo global de "seismic".

#### Scenario: Tipos y componentes de dominio sin cambios

- GIVEN el código fuente después de aplicar el rename de marca completo
- WHEN se inspecciona `src/models/event.py`, `dashboard/components/SeismicMap.tsx`,
  `dashboard/components/SeismicMapWithCities.tsx`,
  `dashboard/components/AdvancedSeismicMap.tsx`, y `dashboard/lib/seismic-cities.ts`
- THEN el símbolo `SeismicEvent` sigue existiendo sin cambio de nombre
- AND los símbolos `SeismicMap`, `SeismicMapWithCities`, `AdvancedSeismicMap`
  siguen existiendo sin cambio de nombre
- AND el tipo `SeismicCity` y la constante `HIGH_RISK_SEISMIC_CITIES` siguen
  existiendo sin cambio de nombre

#### Scenario: Clase Tailwind de dominio sin cambios

- GIVEN los componentes de dashboard que usan la clase `text-seismic-600`
- WHEN se inspecciona el código fuente después del rename
- THEN la clase `text-seismic-600` sigue apareciendo literal, sin renombrar

#### Scenario: Las 13 métricas de dominio en metrics.py permanecen con prefijo seismic_

- GIVEN `src/observability/metrics.py` después del rename
- WHEN se inspeccionan las métricas Gauge/Counter definidas en ese archivo
- THEN las 13 métricas con prefijo `seismic_` (no `seismic_monitor_`) —
  incluyendo, entre otras, las familias `seismic_emsc_*`, `seismic_usgs_*`,
  `seismic_dispatcher_*`, `seismic_redis_*`, `seismic_sse_*`, `seismic_archive_*` —
  conservan su nombre original sin modificación
- AND únicamente las 2 métricas que tenían el prefijo de producto
  `seismic_monitor_` (`source_fetch_duration_seconds`, `source_errors_total`)
  fueron renombradas a `geospectrum_`

#### Scenario: Distinción verificable entre métrica de dominio y métrica de producto

- GIVEN la respuesta de `GET /metrics`
- WHEN se cuenta cuántas series exponen el prefijo `seismic_` (dominio, sin
  `_monitor_`) y cuántas exponen el prefijo `geospectrum_` (producto)
- THEN existen exactamente 13 series (o más, si derivan en múltiples labels de
  la misma métrica base) bajo prefijo `seismic_` de dominio
- AND existen exactamente 7 series de producto bajo prefijo `geospectrum_`
- AND ninguna serie usa el prefijo `seismic_monitor_`

### Requirement: Consistencia total de los manifiestos de despliegue

Ningún manifiesto bajo `deploy/` (K8s, Docker Compose, Dockerfiles,
configuración de Prometheus) MUST quedar a medio renombrar: todos los recursos,
namespaces, labels, selectors, nombres de contenedor, nombres de imagen, redes,
y targets de scraping que referenciaban `seismic-monitor` / `seismic_monitor` /
`Seismic Monitor` como identidad de producto MUST usar consistentemente
`geospectrum` (o `GeoSpectrum` en el caso de labels/comentarios de display).

#### Scenario: Grep de cierre sobre deploy/ no encuentra branding viejo

- GIVEN el árbol completo de `deploy/` después de aplicar el rename
- WHEN se ejecuta `rg -n "seismic-monitor|seismic_monitor|Seismic Monitor" deploy/`
- THEN el comando devuelve 0 resultados
- AND si algún resultado apareciera, MUST estar explícitamente etiquetado con
  el comentario `# HISTORICAL:` para ser considerado una excepción documentada
  (no aplica en el estado relevado por `design.md`, donde no existe ninguna
  excepción de este tipo)

#### Scenario: Namespace K8s consistente entre todos los manifiestos

- GIVEN los manifiestos bajo `deploy/k8s/` después del rename
- WHEN se inspecciona `metadata.namespace` en `secret.yaml`, `configmap.yaml`,
  `hpa.yaml`, `ingress.yaml`, `deployment-inpres-adapter.yaml`, `service.yaml`,
  `servicemonitor.yaml`, `deployment.yaml`, y `metadata.name` /
  `metadata.labels.name` en `namespace.yaml`, y `namespace:` en
  `kustomization.yaml`
- THEN todos los valores son `geospectrum`, sin ninguna ocurrencia de
  `seismic-monitor`

#### Scenario: Docker Compose y Prometheus referencian el mismo nombre de servicio

- GIVEN `deploy/docker/docker-compose.yml` y `deploy/docker/prometheus.yml`
  después del rename
- WHEN se compara el nombre de servicio/`container_name` en `docker-compose.yml`
  contra el `targets` configurado en `prometheus.yml`
- THEN ambos usan el mismo nombre (`geospectrum`), de forma que la resolución
  DNS interna de docker-compose sigue funcionando
- AND la red de docker-compose es `geospectrum-net` (reemplazando `seismic-net`)

#### Scenario: Manifiestos K8s aplican sin error de referencia rota

- GIVEN los manifiestos renombrados bajo `deploy/k8s/`
- WHEN se ejecuta `kubectl apply --dry-run=client -f deploy/k8s/`
- THEN el comando se ejecuta sin error de referencia inconsistente entre
  namespace, secret, configmap, service y los demás recursos

#### Scenario: Dominio de ingress apunta al dominio real comprado

- GIVEN `deploy/k8s/ingress.yaml` después del rename
- WHEN se inspecciona el host configurado
- THEN el placeholder `seismic.example.com` fue reemplazado por `geospectrum.org`
- AND este reemplazo es tratado como cambio de VALOR de dominio, distinto del
  rename de namespace/recursos (no se debe confundir con vocabulario de
  dominio "seismic" del Requirement anterior — este placeholder nunca fue
  vocabulario de dominio sísmico, era un dominio de ejemplo genérico)

### Requirement: Los tests de integración existentes acoplados a branding siguen pasando

Los tests `test_root_endpoint` y `test_metrics_endpoint` en
`tests/integration/test_api.py`, que hacen aserciones directas sobre el valor
del campo `service` y sobre el prefijo de las métricas expuestas en
`/metrics`, MUST actualizarse para reflejar los nuevos valores de marca y MUST
seguir pasando en verde después del rename.

#### Scenario: test_root_endpoint verifica el nuevo valor de service

- GIVEN el test `test_root_endpoint` en `tests/integration/test_api.py`
- WHEN se ejecuta después del rename
- THEN el test hace `GET /` y verifica que `data["service"] == "GeoSpectrum"`
- AND el test ya NO verifica `data["service"] == "Seismic Monitor"`
- AND el test pasa en verde

#### Scenario: test_metrics_endpoint verifica el nuevo prefijo de métrica

- GIVEN el test `test_metrics_endpoint` en `tests/integration/test_api.py`
- WHEN se ejecuta después del rename
- THEN el test hace `GET /metrics` y verifica la presencia de al menos una
  métrica con prefijo `geospectrum_` (por ejemplo
  `geospectrum_requests_total`)
- AND el test ya NO verifica la presencia de métricas con prefijo
  `seismic_monitor_`
- AND el test pasa en verde

#### Scenario: La suite completa de tests de integración pasa en verde

- GIVEN la suite completa de `tests/integration/test_api.py` después del
  rename, incluyendo `test_root_endpoint`, `test_metrics_endpoint`, y el nuevo
  `test_cors_allows_configured_origins`
- WHEN se ejecuta `pytest` (comando definido en `openspec/config.yaml`:
  `cd seismic-monitor && pytest`)
- THEN todos los tests de ese archivo pasan sin fallos ni errores

## Out of Scope (heredado de la propuesta, no se especifica aquí)

- Registro/verificación DNS del dominio `geospectrum.org` — fuera del alcance
  de código, no se especifica comportamiento de infraestructura externa.
- Corrección del valor de password en texto plano de `deploy/k8s/secret.yaml`
  — deuda técnica documentada por separado; este spec solo cubre el rename del
  nombre del recurso `secret.yaml`, no el valor almacenado.
- Cambios de arquitectura, esquema de datos o contratos de API funcionales más
  allá de los valores de texto/label de identidad de producto (ver
  `design.md`, Technical Approach: "No hay cambios de arquitectura, esquema de
  datos, ni contratos de API salvo por los valores de texto/label que se
  renombran").
