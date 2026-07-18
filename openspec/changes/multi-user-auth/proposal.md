# Proposal: Autenticación Multi-Usuario con Roles

## Intent

Hoy GeoSpectrum no tiene ningún concepto de usuario, sesión ni autenticación: se confirmó por inspección directa que ningún endpoint de `src/main.py` declara una dependencia de auth (no hay `Depends()` de seguridad en ninguno de los 13 endpoints), no hay tabla de usuarios, no hay JWT ni librería de hashing de passwords en `requirements.txt`, y el frontend (`dashboard/lib`, `dashboard/hooks`) no envía ningún header `Authorization`. Todo el sistema es público y stateless.

Este change introduce un sistema de autenticación multi-usuario con roles (mínimo `admin` / `viewer`) para dejar de ser un sistema 100% anónimo. Es la base habilitante de tres iniciativas futuras ya decididas por el usuario pero **fuera de alcance de este change**: regiones de interés persistentes por usuario, dashboards personalizables guardables por usuario, y (potencialmente) control de acceso a funciones. Las tres necesitan un `user_id` real al que atar filas en TimescaleDB — sin este change no existe ese `user_id`.

La decisión de modelo (multi-usuario con roles, sistema propio vs. proveedor externo tipo Clerk/Auth0) ya fue tomada por el usuario a nivel de producto: se construye un sistema propio salvo que `sdd-design` evalúe explícitamente lo contrario como decisión técnica. Ese análisis técnico (JWT vs. sesiones server-side, librería de hashing, esquema de tabla) se define en `design.md`, no acá.

## Scope

### In Scope
- Modelo de datos de usuario: tabla `users` en TimescaleDB/Postgres (email, password hash, rol, timestamps) — sin ORM detectado en el proyecto (`requirements.txt` solo trae `psycopg2-binary`/`asyncpg` como drivers crudos), la estrategia de acceso a datos se decide en `design.md`.
- Roles mínimos: `admin` y `viewer`. Semántica exacta de cada rol (qué puede hacer un `viewer` vs. un `admin`) se define en `sdd-spec`.
- Backend: endpoints de registro/login/logout (o emisión de token), hashing seguro de passwords, emisión y validación de credenciales de sesión, middleware/dependencia de FastAPI para proteger rutas.
- Backend: decisión y aplicación de política de protección sobre los endpoints existentes de `src/main.py` (cuáles quedan públicos —p. ej. `/health`, `/metrics`— y cuáles pasan a requerir sesión autenticada).
- Frontend: página(s) de login, provider de sesión (nuevo elemento en `dashboard/app/providers.tsx`, junto a `ThemeProvider`/`TooltipProvider` ya existentes), guard de rutas protegidas, UI condicional según rol (ej. ocultar/deshabilitar acciones de admin para `viewer`).
- Manejo de secrets de auth (clave de firma de tokens, etc.) siguiendo el patrón ya establecido en `src/config/settings.py` (Pydantic `BaseSettings` + variables de entorno, mismo estilo que `TIMESCALEDB_PASSWORD`).
- Definición explícita de qué pasa con clientes no interactivos existentes que consumen la API sin credenciales (ver Risks).

### Out of Scope
- Regiones de interés persistentes por usuario (change futuro, depende de este).
- Personalización de Dashboard con drag-and-drop guardable por usuario (change futuro, depende de este).
- Charts combinables (change futuro, no depende de este).
- Recuperación de password por email, verificación de email, 2FA, SSO/OAuth con proveedores externos (Google, etc.) — quedan como posible trabajo futuro, no se descartan a nivel arquitectura pero no se implementan acá.
- Roles más granulares que `admin`/`viewer` (ej. permisos por ciudad, por fuente de datos) — se puede extender después si `sdd-spec` lo amerita, pero el mínimo viable de este change es dos roles.
- Migrar/actualizar `scripts/seismic-cli.py` para soportar autenticación — se documenta el impacto en Risks pero la decisión de cómo resolverlo (token estático, exención, deprecar el script) se toma en `sdd-design`.

## Approach

Introducir una capa de autenticación en el backend FastAPI (tabla `users` en TimescaleDB, hashing de passwords, emisión/validación de credenciales de sesión, dependencia de FastAPI reusable para proteger rutas) y su contraparte en el frontend Next.js 15 (páginas de login/logout, provider de sesión compuesto en `dashboard/app/providers.tsx`, guard de rutas en el árbol de `dashboard/app/layout.tsx`, UI condicional por rol). El mecanismo concreto de sesión (JWT stateless vs. sesión server-side con cookie httpOnly), la librería de hashing, y el esquema exacto de la tabla `users` son decisiones técnicas que se resuelven en `sdd-design`, con la puerta abierta a evaluar (y descartar con justificación) un proveedor externo si el análisis de esfuerzo/seguridad lo amerita.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `src/config/settings.py` | Modified | Nuevas variables de entorno para secrets de auth (clave de firma, TTL de sesión, etc.), siguiendo el patrón `Optional[str]` + `.env` ya usado para `TIMESCALEDB_PASSWORD` |
| `src/main.py` | Modified | Nuevos endpoints de auth (login/logout/registro o equivalente); dependencias de protección aplicadas a endpoints existentes según política que se defina en `sdd-spec` |
| `src/models/` | New | Modelo de usuario y rol (Pydantic, y esquema de tabla en TimescaleDB/Postgres) |
| `src/services/` | New | Servicio de autenticación (hashing, emisión/validación de credenciales) — patrón consistente con servicios existentes (`usgs_service`, `emsc_service`, etc.) |
| `requirements.txt` | Modified | Nueva(s) dependencia(s) de hashing de passwords y, si se opta por JWT, librería de firma/verificación (a definir en `sdd-design`) |
| `deploy/docker/docker-compose.yml` | Modified | Posible nueva variable de entorno para secret de auth; la tabla `users` vive en el Postgres/TimescaleDB ya provisionado (`POSTGRES_DB: seismic`), no requiere nuevo servicio |
| `dashboard/app/providers.tsx` | Modified | Nuevo `AuthProvider`/`SessionProvider` compuesto junto a `ThemeProvider` y `TooltipProvider` |
| `dashboard/app/layout.tsx` | Modified | Posible guard de rutas o wrapper condicional según estado de sesión |
| `dashboard/app/` | New | Página(s) de login (y logout si aplica) |
| `scripts/seismic-cli.py` | Impact TBD | Hoy hace requests sin ningún header de auth (`httpx.Client` sin `Authorization`); si los endpoints que consume (`/report`, `/events`, `/alerts`) pasan a requerir sesión, el script deja de funcionar salvo que se le dé un mecanismo de acceso — decisión pendiente para `sdd-design` |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| El sistema hoy es 100% público — ningún endpoint de `src/main.py` requiere nada. Migrar a auth es un cambio de contrato breaking para cualquier consumidor externo no interactivo, en particular `scripts/seismic-cli.py`, que hoy hace `httpx.Client(timeout=10.0)` sin headers de autorización contra `/report`, `/events`, `/alerts` | High | Decidir explícitamente en `sdd-design` una de: (a) dejar esos 3 endpoints públicos y solo proteger superficie nueva (regiones/dashboards del futuro), (b) emitir un token de servicio/API key de larga vida para el CLI, (c) deprecar el CLI. No se resuelve implícitamente — debe quedar en el design doc con justificación |
| Cambio de tamaño Medium-High: toca backend (tabla nueva, hashing, emisión/validación de tokens, middleware) Y frontend (login, guard de rutas, provider de sesión, UI condicional por rol) simultáneamente | High (es un hecho del scope, no una probabilidad) | Descomponer en `sdd-tasks` por fases (backend primero con endpoints protegidos vía flag, luego frontend); no tratar como "Low risk" — es un cambio transversal |
| Manejo incorrecto de secrets de auth (clave de firma, etc.) si no sigue el patrón ya validado del proyecto | Medium | Reusar el patrón de `src/config/settings.py` (Pydantic `BaseSettings`, `Optional[str]`, nunca hardcodeado, cargado por `.env`/variable de entorno como ya se hace con `TIMESCALEDB_PASSWORD`) |
| Sin ORM en el proyecto (`requirements.txt` solo trae drivers crudos `psycopg2-binary`/`asyncpg`) — construir queries de auth a mano aumenta superficie de SQL injection si no se usa parametrización estricta | Medium | `sdd-design` MUST especificar acceso a datos parametrizado (placeholders, nunca f-strings en SQL) siguiendo el patrón de `TimescaleColumnWriter` existente en `src/services/timescale_service.py` |
| CORS ya está configurado con `allow_credentials=True` (`src/main.py`) — introducir cookies de sesión interactúa directamente con esa configuración y con `cors_allowed_origins` | Medium | Validar en `sdd-design`/`sdd-verify` que el mecanismo de sesión elegido (cookie httpOnly vs. header Bearer) es compatible con la política CORS actual sin abrirla de más |
| Regresión en tests existentes que mockean endpoints sin autenticación (`tests/integration/test_api.py` parchea `fetch_usgs_events`/`fetch_emsc_events`/`fetch_inpres_events` en el namespace de `src.main`) | Medium | `sdd-tasks`/`sdd-apply` deben revisar y actualizar esos tests si los endpoints que tocan pasan a requerir sesión |

## Rollback Plan

Todo el trabajo de este change vive en módulos nuevos (`src/services/auth_service.py` o equivalente, tabla `users` nueva, páginas nuevas en `dashboard/app/`) más modificaciones acotadas a `src/main.py`, `src/config/settings.py`, `dashboard/app/providers.tsx` y `dashboard/app/layout.tsx`. Rollback:
1. Revertir el/los commit(s) del change (o `git revert`).
2. Si la tabla `users` ya fue migrada en TimescaleDB/Postgres, aplicar migración inversa (`DROP TABLE users` o equivalente) — la migración de creación debe ser reversible desde que se escriba en `sdd-tasks`.
3. Ningún endpoint existente pierde datos si se revierte: la fusión USGS/EMSC/INPRES (`report_service`) y el pipeline de espectrogramas no se tocan en este change, por lo que el rollback no afecta esas rutas críticas.
4. Si se optó por proteger endpoints existentes (`/report`, `/events`, `/alerts`, etc.) y el rollback los deja sin protección de nuevo, comunicar explícitamente que el sistema vuelve a ser público — no es un estado silencioso.

## Dependencies

- Postgres/TimescaleDB ya provisionado y corriendo (`deploy/docker/docker-compose.yml`, `POSTGRES_DB: seismic`) — no requiere infraestructura nueva, solo una tabla adicional.
- Decisión técnica pendiente en `sdd-design`: mecanismo de sesión (JWT vs. sesión server-side), librería de hashing de passwords, y si se descarta o no un proveedor externo (Clerk/Auth0/similar) frente a construir un sistema propio.
- Ninguna de las 3 iniciativas futuras (regiones, dashboards personalizados, charts combinables) es dependencia de este change — es al revés: ellas dependen de este.

## Success Criteria

- [ ] Existe un modelo de usuario persistente (tabla `users`) con al menos rol `admin` y `viewer`
- [ ] Un usuario puede registrarse/ser dado de alta y autenticarse (login) obteniendo una sesión válida
- [ ] Al menos un endpoint backend queda protegido de punta a punta (rechaza requests sin sesión válida con 401/403) y esto se verifica con un test automatizado
- [ ] El frontend tiene una página de login funcional que, tras autenticar, permite acceder a rutas protegidas y redirige/bloquea a quien no tiene sesión
- [ ] La UI refleja el rol del usuario autenticado (al menos una diferencia visible entre `admin` y `viewer`)
- [ ] Queda documentada en `design.md` la decisión sobre qué pasa con `scripts/seismic-cli.py` y con los endpoints hoy públicos (`/report`, `/events`, `/alerts`, `/health`, `/metrics`, etc.)
- [ ] Los tests existentes en `tests/integration/test_api.py` siguen pasando (actualizados si fue necesario por el cambio de contrato de algún endpoint)
