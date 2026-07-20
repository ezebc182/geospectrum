# Proposal: Login/registro con Google (OAuth) como alternativa al email/password existente

## Intent

Hoy el único mecanismo de alta y autenticación es `POST /auth/register` + `POST /auth/login` con email/password (ver `openspec/changes/multi-user-auth/`, implementado y en `main` — 30/30 tests, commits `48cf2e4`, `28425ad`, `a0db04b`). El usuario pidió agregar "login con Google (OAuth) y creación de cuenta". Se aclaró explícitamente un punto de alcance crítico: la intención original mencionaba Better Auth (librería Node/TS) como posible reemplazo del backend de auth, pero tras repreguntar se confirmó que Better Auth era un medio, no el fin — lo que se necesita es que los usuarios puedan crear cuenta / loguearse con su cuenta de Google, **además** del login email/password que ya existe. Decisión explícita y no negociable: **no se reemplaza el `AuthService` de Python/FastAPI** (asyncpg, sin ORM, JWT HS256 en cookie httpOnly) — se **extiende**.

El problema de negocio es reducir fricción de alta (evitar que el usuario tenga que inventar y recordar una password nueva) sin descartar el trabajo de auth ya construido, testeado y desplegado.

## Scope

### In Scope
- Nuevo flujo OAuth 2.0 Authorization Code con Google: `GET /auth/google/login` (redirige a Google) y `GET /auth/google/callback` (recibe el `code`, intercambia por perfil, resuelve/crea usuario, emite la misma cookie de sesión httpOnly que ya emite `/auth/login`).
- Reutilizo estricto de `AuthService.create_access_token()` para emitir la cookie — no se inventa un mecanismo de sesión paralelo al ya existente.
- Migración `003` sobre la tabla `users`: `password_hash` pasa de `NOT NULL` a nullable, y se agrega columna `google_id` (nullable, `UNIQUE`) para identificar la cuenta de Google vinculada.
- Nueva dependencia: `Authlib`, para el intercambio `authorization code → token` y validación del ID token de Google (patrón estándar recomendado para FastAPI; ver Dependencies).
- Botón "Iniciar sesión con Google" en `dashboard/app/login/page.tsx`, junto al formulario email/password existente.
- Aplicación de la regla de bootstrap del primer `superadmin` (ver `openspec/changes/multi-user-auth/design.md` Decision 6) también al flujo de Google — un registro vía Google MUST pasar por la misma regla de "tabla vacía → superadmin, si no → viewer", no por un camino separado que la esquive.
- Identificación explícita (no resolución todavía — ver Risks) de qué pasa cuando un email ya registrado con password intenta loguearse después con Google.

### Out of Scope
- Reemplazo de `AuthService`, del modelo JWT/cookie httpOnly, o de cualquier pieza del sistema de auth ya implementado.
- Migración a Better Auth o a cualquier librería de auth de Node/TS — descartado explícitamente por el usuario tras aclarar el objetivo real.
- Otros proveedores OAuth (GitHub, Microsoft, etc.) — solo Google en este change.
- Recuperación de password, 2FA, verificación de email propia (Google ya verifica el email en su lado) — siguen fuera de alcance, heredado de `multi-user-auth`.
- Endpoint de gestión de usuarios (asignar rol, listar usuarios) — sigue diferido, no es parte de este change.
- Protección de endpoints de datos sísmicos existentes (`/report`, `/events`, etc.) — sigue sin tocarse, mismo criterio que `multi-user-auth` Decision 2.
- Desvinculación de cuenta Google / cambio de método de login post-registro — no se especifica en este batch.

## Approach

Se añade una segunda vía de autenticación (`google`) que converge en el mismo punto de salida que la vía existente (`password`): emisión de cookie `session` httpOnly vía `AuthService.create_access_token()`. El backend gana dos endpoints nuevos bajo `/auth/google/*` que usan Authlib para hablar con los endpoints OAuth de Google (`authorize` + `token` + `userinfo`/ID token). La tabla `users` se extiende (no se reemplaza) para poder representar tanto usuarios `password`-only, `google`-only, como potencialmente ambos — lo cual exige resolver primero la pregunta de negocio del Risk #1 antes de poder implementar el `callback` con seguridad.

El frontend agrega un botón que dispara `window.location.href = '/auth/google/login'` (redirect completo de navegador, no fetch — es el patrón correcto para Authorization Code flow con cookies) junto al formulario existente en `dashboard/app/login/page.tsx`.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `deploy/sql/migrations/003_add_google_oauth.sql` | New | `ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL`, `ALTER TABLE users ADD COLUMN google_id TEXT UNIQUE`. Reversible (ver Rollback Plan). |
| `src/services/auth_service.py` | Modified | Nuevos métodos: `get_user_by_google_id()`, `create_user_from_google()` (o extensión de `create_user()` para aceptar `google_id` y `password_hash: Optional[str]`) — respetando la regla de bootstrap de `create_user()` ya existente, no un camino paralelo. |
| `src/models/user.py` | Modified | `UserInDB.password_hash` pasa a `Optional[str]`; se agrega `google_id: Optional[str]`. Posible campo/enum de "método de auth" si se decide en specs (ver Risk #2). |
| `src/api/deps.py` | Unmodified (probable) | `get_current_user`/`require_role`/`require_min_role` no cambian: siguen operando sobre el mismo JWT/cookie, agnósticos de si el usuario se autenticó por password o Google. A confirmar en `sdd-design`. |
| `src/main.py` | Modified | Nuevos endpoints `GET /auth/google/login`, `GET /auth/google/callback`; registro del cliente OAuth de Authlib en `lifespan()` (mismo patrón que `auth_service`), con el mismo criterio de fail-fast que ya existe para `AUTH_SECRET_KEY` si faltan `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` — a decidir en `sdd-design` si el fail-fast es total o si OAuth puede estar deshabilitado sin tumbar el arranque (ver Rollback Plan). |
| `src/config/settings.py` | Modified | Nuevos campos: `google_client_id: Optional[str]`, `google_client_secret: Optional[str]`, `google_redirect_uri: Optional[str]` (o derivado de config existente). |
| `requirements.txt` | Modified | Agrega `Authlib` (nueva dependencia — no existe hoy ninguna librería OAuth en el proyecto, confirmado por lectura de `requirements.txt`). |
| `dashboard/app/login/page.tsx` | Modified | Botón "Iniciar sesión con Google" que redirige a `/auth/google/login`. |
| `dashboard/lib/auth.ts` / `dashboard/hooks/use-auth.tsx` | Possibly Modified | A confirmar en `sdd-design` si necesitan cambios — el flujo de Google no pasa por `fetch` desde el cliente (es redirect de navegador completo), por lo que es probable que no requieran tocarse; `getMe()` ya es agnóstico del método de login. |
| `deploy/docker/docker-compose.yml` | Modified | Agrega `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` (comentados con placeholder, mismo estilo que `AUTH_SECRET_KEY`). |
| `tests/unit/` y `tests/integration/` | New/Modified | Tests de los nuevos métodos de `AuthService` y del flujo `/auth/google/callback` (mockeando la respuesta de Google, no llamando a Google real en CI). |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| **Email ya registrado con password intenta loguearse después con Google (mismo email)** — no es un detalle de implementación, es una decisión de seguridad de producto. Linkear automáticamente por email asume que el email de Google es confiable (Google sí lo verifica, a diferencia de otros proveedores OAuth genéricos), pero linkear sin ningún paso adicional permite que, si alguna vez existiera una cuenta con password creada con un email que el atacante no controla pero sí puede registrar en Google con ese mismo email — escenario de bajo riesgo dado que Google exige verificación de propiedad del email, pero no nulo — se produzca una toma de cuenta. | High (decisión de producto tomada, pendiente de especificar en detalle) | **RESUELTO por el usuario (no re-preguntar): opción (a), auto-link por email.** Si `GET /auth/google/callback` recibe un `email` (verificado por Google — confirmado vía `email_verified` claim del ID token, no asumido) que coincide con una fila existente en `users` con `password_hash IS NOT NULL`, se vincula `google_id` a esa fila existente en vez de crear una cuenta nueva o rechazar el login. El usuario resultante puede loguearse indistintamente con password o con Google a partir de ese momento. `sdd-spec` debe: (1) exigir explícitamente la verificación de `email_verified=true` del ID token de Google antes de auto-linkear — un email no verificado del lado de Google NO debe disparar el link automático; (2) escribir el escenario Given/When/Then correspondiente en `specs/auth/spec.md`; (3) decidir si corresponde notificar al usuario (ej. email) de que se vinculó una cuenta Google a su cuenta existente, para que pueda detectar un intento no autorizado. |
| Migración 003 hace `password_hash` nullable — cualquier código que hoy asuma `password_hash: str` no-nulo (ej. en `AuthService.get_user_by_email` → `UserInDB`) puede romper en tiempo de ejecución si no se actualiza el tipo y los call sites en el mismo change. | Medium | `sdd-design`/`sdd-tasks` deben tratar el cambio de tipo (`Optional[str]`) y sus call sites (`verify_password` no debe invocarse con `password_hash=None`) como tarea de primera clase, no un detalle menor. |
| Bootstrap del primer `superadmin` (regla "tabla vacía → superadmin") debe aplicar igual si el primer usuario del sistema se registra vía Google — si el flujo de Google usa un método de creación de usuario distinto de `AuthService.create_user()` que no reimplemente esa regla, un primer usuario por Google podría quedar como `viewer` sin nadie con privilegios para gestionar el sistema (o peor, sin la regla, un camino de escalación no controlado). | Medium | El método nuevo de creación de usuario vía Google MUST reusar la misma lógica de conteo/transacción que `create_user()` (ni un `if/else` duplicado ni un WHERE distinto) — a especificar como requirement explícito en `sdd-spec`, con escenario dedicado. |
| Credenciales de Google Cloud Console (Client ID/Secret) no existen todavía — son un prerequisito externo, no algo que el pipeline de `sdd-apply` pueda generar. | Medium | Ver Dependencies. El change puede avanzar en specs/design/tasks sin las credenciales reales, pero `sdd-apply` no puede completarse (levantar el servidor con OAuth activo) ni `sdd-verify` puede probar el flujo end-to-end sin que el usuario las provea. |
| Nueva dependencia (Authlib) amplía la superficie de ataque/mantenimiento del backend — primera librería de terceros para auth además de `passlib`/`python-jose`. | Low | Authlib es la librería estándar recomendada en la documentación oficial de FastAPI para OAuth; no se evalúan alternativas en este proposal salvo que `sdd-design` encuentre una razón técnica concreta para no usarla. |
| Si el fail-fast de `lifespan()` se extiende a las credenciales de Google (mismo criterio que `AUTH_SECRET_KEY` hoy), el servidor no arrancaría en ningún ambiente sin esas credenciales configuradas — incluyendo desarrollo local de quien no las tiene todavía. | Medium | A decidir en `sdd-design`: probablemente OAuth de Google debe ser opcional en el arranque (si `GOOGLE_CLIENT_ID`/`SECRET` faltan, los endpoints `/auth/google/*` responden 503 o no se registran, pero el servidor arranca igual) — a diferencia de `AUTH_SECRET_KEY`, que es transversal a *todo* el sistema de auth, Google OAuth es una vía adicional, no la única. |

## Rollback Plan

1. **Código**: revertir el/los commits del change. Sin flag de feature explícito salvo que `sdd-design` decida agregar uno (ver Risk de fail-fast arriba) — evaluar si conviene una env var `GOOGLE_OAUTH_ENABLED` para poder desactivar el flujo sin revertir código, dado que ya existe precedente de "componente opcional" en el proyecto (Redis se trata como best-effort en `lifespan()`).
2. **Login/registro con password**: MUST seguir funcionando exactamente igual si OAuth se deshabilita o se revierte — el flujo `/auth/register` y `/auth/login` no cambian de contrato en este change (mismo criterio que `multi-user-auth` Decision 5: la superficie nueva es aditiva, no reemplaza la existente).
3. **Migración 003 — reversibilidad**: el `ALTER COLUMN password_hash DROP NOT NULL` es trivialmente reversible (`SET NOT NULL`) **siempre que no existan filas con `password_hash IS NULL`** en el momento del rollback (i.e., usuarios creados solo por Google) — si existen, el rollback requiere primero decidir qué hacer con esas filas (eliminarlas, o exigirles setear password antes de poder revertir). La columna `google_id` se dropea sin condicionamiento (`DROP COLUMN google_id`). El archivo de migración 003 MUST documentar ambos pasos y la advertencia, siguiendo el mismo formato que `002_add_role_hierarchy.sql` (que ya documenta una advertencia de rollback condicional análoga).
4. **Datos**: si se decide eliminar la capacidad de login por Google después de tener usuarios reales que solo usan ese método, esos usuarios quedan sin forma de acceder (no tienen password) — este caso MUST tratarse en `sdd-design`/`sdd-tasks` como parte del rollback real, no asumirse trivial.

## Dependencies

- **Credenciales de Google Cloud Console (OAuth Client ID + Client Secret)**: prerequisito externo que el **usuario** debe generar manualmente en Google Cloud Console (crear proyecto, configurar pantalla de consentimiento OAuth, crear credenciales de tipo "Web application", registrar el/los `redirect_uri` de callback). Esto **no puede ser creado por el sub-agente de `sdd-apply`** — es una acción fuera del repositorio que requiere una cuenta de Google Cloud del usuario. El change puede avanzar hasta `sdd-tasks` sin estas credenciales, pero `sdd-apply` (para probar el flujo real) y `sdd-verify` las necesitan.
- **Authlib**: nueva dependencia de Python a agregar a `requirements.txt`. No hay ninguna librería OAuth instalada hoy (confirmado: `requirements.txt` no menciona Authlib ni ningún cliente OAuth).
- Depende del sistema de auth de `multi-user-auth` ya mergeado en `main` (`48cf2e4`, `28425ad`, `a0db04b`) — este change es una extensión, no funciona de forma independiente.

## Success Criteria

- [ ] Un usuario nuevo puede crear cuenta y loguearse exclusivamente con su cuenta de Google, sin necesidad de definir una password.
- [ ] Un usuario existente que ya usa email/password sigue pudiendo loguearse exactamente igual que antes de este change (no regresión).
- [ ] El auto-link por email (decisión ya tomada, ver Risk #1) está documentado en `specs/auth/spec.md` con escenarios Given/When/Then explícitos, incluyendo el requisito de `email_verified=true` del ID token de Google como condición para vincular.
- [ ] El primer usuario del sistema (tabla `users` vacía) que se registra vía Google recibe `role="superadmin"`, igual que si se hubiera registrado vía password — la regla de bootstrap de `multi-user-auth` Decision 6 aplica sin excepción por método de login.
- [ ] La migración `003` es reversible y su reversibilidad (incluyendo el caso condicional de filas con `password_hash IS NULL`) está documentada en el propio archivo SQL.
- [ ] Si las credenciales de Google no están configuradas, el servidor sigue arrancando (a menos que `sdd-design` justifique explícitamente lo contrario) y el login por password sigue disponible.
