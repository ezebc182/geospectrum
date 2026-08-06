# Design: Registro por invitación con emails (Resend + react-email) y onboarding guiado

## Technical Approach

La fuente de verdad de las invitaciones vive en el **backend** (tabla `invitations`, migración 007, tokens hasheados con SHA-256, consumo transaccional atómico junto con la creación del usuario), y el **email** vive en el **dashboard** (react-email + Resend en una API route de Next, server-side only) — decisión ya cerrada en el proposal, no se reabre.

El flujo de creación es en dos pasos orquestados por la UI de admin: (1) `POST /auth/invitations` al backend devuelve el token en claro UNA sola vez; (2) la UI llama a `POST /api/invitations/send` (Next), que valida la sesión admin+ verificando la cookie `session` con `jose` + `AUTH_SECRET_KEY` (exactamente el mismo mecanismo que `dashboard/middleware.ts`), renderiza el template de `dashboard/emails/` y envía vía el SDK de Resend. Tras un envío exitoso, la route marca `email_sent_at` en el backend (Decision 4) para que la lista de invitaciones muestre si el email salió o no.

El cierre del registro es una **precondición aditiva** sobre `create_user()` y `resolve_or_create_google_user()`: en ambos caminos, el consumo de la invitación (un único `UPDATE ... WHERE ... RETURNING`) corre dentro de la MISMA `conn.transaction()` que ya envuelve la creación del usuario — sin duplicar la regla de bootstrap (`_determine_bootstrap_role()`) ni el auto-link por email ya implementados. Hallazgo clave de este design (Decision 5): el camino Google **no necesita el token** — la invitación se consume por match de email, lo que elimina todo el plumbing de pasar el token a través del redirect flow de OAuth.

El onboarding es frontend-first: `GET /auth/me` se extiende con `onboarding_completed_at` (leído de la base, no del JWT — Decision 6), un provider en el layout de `(app)` decide si montar el wizard, y el tour interactivo usa **driver.js** (Decision 7) anclado a atributos `data-tour-id` propios.

## Architecture Decisions

### Decision 1: Migración 007 — tabla `invitations`, token SHA-256, backfill de `onboarding_completed_at`

**Choice**: SQL exacto en Interfaces / Contracts. Puntos estructurales:

- `id UUID PRIMARY KEY DEFAULT gen_random_uuid()` y `role TEXT NOT NULL CHECK (role IN ('superadmin','admin','moderador','viewer'))` — misma convención que `users` (001/002). El CHECK se duplica textualmente (no hay dominio/tipo compartido en el esquema actual y crear uno tocaría 002 ya aplicada).
- `token_hash TEXT NOT NULL UNIQUE`: SHA-256 hex del token en claro. El token es `secrets.token_urlsafe(32)` (256 bits de entropía) — **SHA-256 sin salt alcanza y bcrypt sería un error**: bcrypt es para secretos de baja entropía (passwords humanas) donde el costo por intento importa; acá el ataque por fuerza bruta sobre 256 bits es inviable, y el hash determinístico es lo que permite el lookup indexado `WHERE token_hash = $1` (bcrypt no es determinístico: obligaría a un scan + verify fila por fila, como ya paga `consume_backup_code()` con sus 10 filas — inaceptable para una tabla que crece).
- `invited_by UUID REFERENCES users(id) ON DELETE SET NULL` (nullable): si el admin que invitó borra su cuenta (`delete_account()` existente), la invitación sigue siendo válida — se pierde trazabilidad, no funcionalidad. `ON DELETE CASCADE` mataría invitaciones pendientes por un evento no relacionado; `RESTRICT` bloquearía el borrado de cuenta ya implementado.
- Estado **derivado, no columna**: `revoked_at IS NOT NULL` → revocada; `accepted_at IS NOT NULL` → aceptada; `expires_at < now()` → expirada; si no → pendiente. Una columna `status` textual puede desincronizarse de los timestamps (dos fuentes de verdad); los timestamps además responden "cuándo".
- `accepted_by UUID REFERENCES users(id) ON DELETE SET NULL`: trazabilidad de qué usuario resultó de la invitación.
- `email_sent_at TIMESTAMPTZ` (nullable): confirmación de envío — ver Decision 4.
- **Sin unique parcial sobre email pendiente**: un índice `UNIQUE (email) WHERE accepted_at IS NULL AND revoked_at IS NULL` no puede incluir `expires_at < now()` (los predicados de índice exigen expresiones inmutables — `now()` no lo es), así que una invitación expirada bloquearía crear una nueva para el mismo email. La unicidad "una sola invitación pendiente y vigente por email" se garantiza a nivel de servicio, dentro de la transacción de `create_invitation()` (Decision 2/3).
- `users.onboarding_completed_at TIMESTAMPTZ` (nullable) **con backfill**: `UPDATE users SET onboarding_completed_at = now() WHERE onboarding_completed_at IS NULL` en la propia 007. Sin el backfill, TODOS los usuarios existentes en producción verían el wizard en su próximo login (columna nueva = NULL) — el onboarding es para usuarios *nuevos* invitados, no un anuncio de features a los existentes. Es la mitad "no molestar a los usuarios existentes" del requisito de no-regresión (Decision 10 cubre la otra mitad, el lockout).

**Alternatives considered**:
- (a) Token en claro en la base → descartado en el proposal (dump filtra links de alta con rol pre-asignado, incluso admin).
- (b) bcrypt para el token → descartado arriba (no indexable, costo sin beneficio para 256 bits de entropía).
- (c) Columna `status` enum → descartado (deriva de timestamps, evita desincronización).
- (d) JWT firmado como token de invitación (sin tabla) → descartado: sin estado en base no hay single-use, ni revocación, ni listado con estado — tres requirements explícitos del proposal.

**Rationale**: cada punto arriba. La migración es aditiva e idempotente (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`), mismo estilo que 006, con rollback documentado en el propio archivo (requisito del proposal).

### Decision 2: `InvitationService` nuevo para el CRUD admin; el CONSUMO vive en `AuthService`

**Choice**: split por dueño de la transacción:

- `src/services/invitation_service.py` — clase `InvitationService` nueva: `create_invitation()`, `list_invitations()`, `revoke_invitation()`, `resend_invitation()`, `validate_token()`, `mark_email_sent()`. Recibe el pool compartido por inyección (`pool: asyncpg.Pool`), el mismo mecanismo que `AuthService` ya soporta desde AOI-1 (`_owns_pool`); se instancia en `lifespan()` y se publica en `app.state.invitation_service` (mismo patrón que `auth_service` / `totp_login_attempt_limiter`).
- `AuthService` gana UN método privado: `_consume_pending_invitation(conn, email, token=None) -> Optional[asyncpg.Record]` — un único `UPDATE invitations SET accepted_at = now() WHERE ... AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() RETURNING id, email, role`, invocado DESDE ADENTRO de las transacciones ya existentes de `create_user()` y `resolve_or_create_google_user()`. El predicado SQL de "pendiente y vigente" se define como constante módulo-level `PENDING_PREDICATE_SQL` en `invitation_service.py` y `auth_service.py` la importa (sin ciclo: `invitation_service` solo importa modelos).

**Alternatives considered**:
- (a) Todo en `AuthService` — consistente con el patrón monolítico, pero el archivo ya supera las 900 líneas y el CRUD de invitaciones es un dominio coherente y separable (gestión admin) que no comparte transacciones con nada de auth.
- (b) Todo en `InvitationService`, incluida la creación del usuario invitado — rompe la frontera: la creación de usuarios (bootstrap, auto-link, hashing) es dominio de `AuthService`; duplicarla o moverla es peor que el split.
- (c) `InvitationService` expone `consume()` público y `AuthService` le pasa la `conn` activa — cruza la frontera de servicios con una conexión viva, exactamente el patrón que el design de google-oauth ya rechazó ("exponer una transacción genérica cruzando la frontera del servicio... YAGNI").

**Rationale**: la regla que decide es "quién es dueño de la transacción". El consumo DEBE ser atómico con el INSERT/UPDATE de `users` (Risk de doble uso del proposal: `UPDATE ... WHERE accepted_at IS NULL RETURNING` + creación de usuario en la misma transacción — dos accepts concurrentes serializan sobre la fila y solo uno obtiene el RETURNING). Esas transacciones ya existen y viven en `AuthService`; el consumo va donde está la transacción. El CRUD admin, en cambio, son operaciones autocontenidas → servicio propio, archivo nuevo, sin engordar más `auth_service.py`. La constante compartida elimina el riesgo de que los dos predicados de "pendiente" diverjan.

### Decision 3: Superficie de endpoints y códigos de error

**Choice** (firmas completas en Interfaces / Contracts):

| Endpoint | Auth | Éxito | Errores |
|----------|------|-------|---------|
| `POST /auth/invitations` | `require_min_role(ADMIN)` | 201 `{id, email, role, token, expires_at}` — token en claro, única vez | 401/403 (deps existentes); **403** si `role_level(invited) > role_level(inviter)`; **409** si el email ya tiene cuenta en `users`; **409** si ya existe invitación pendiente y vigente para ese email (mensaje: usar reenviar) |
| `GET /auth/invitations` | `require_min_role(ADMIN)` | 200 lista con `status` derivado + `email_sent_at` | 401/403 |
| `DELETE /auth/invitations/{id}` | `require_min_role(ADMIN)` | 204 (marca `revoked_at`) | 404 no existe; **409** si ya fue aceptada (revocar una invitación consumida no des-crea al usuario — rechazo explícito, no un no-op engañoso) |
| `POST /auth/invitations/{id}/resend` | `require_min_role(ADMIN)` | 200 `{id, email, role, token, expires_at}` — token NUEVO (regenera hash y expiración, invalida el link anterior; resetea `email_sent_at` a NULL) | 404; 409 si aceptada o revocada |
| `GET /auth/invitations/validate?token=` | público | 200 `{email, role, expires_at}` | **404** token desconocido; **410 Gone** conocida pero expirada/revocada/aceptada (la página de aceptación distingue "link inválido" de "link vencido — pedí un reenvío") |
| `POST /auth/invitations/{id}/mark-sent` | `require_min_role(ADMIN)` | 204 (setea `email_sent_at = now()`) | 404 |
| `POST /auth/register` (modificado) | público | 201 (igual que hoy) | **403** `{"error": "invitation required"}` sin token y tabla no vacía; **410** token inválido/expirado/revocado/consumido; **409** email duplicado (igual que hoy); **422** si el email del payload no coincide con el de la invitación |
| `POST /auth/me/onboarding-complete` | `get_current_user` | 204, idempotente (`SET onboarding_completed_at = now() WHERE ... IS NULL`) | 401 |

Reglas transversales:
- **Guard de escalación de privilegios**: nadie invita a un rol de nivel superior al propio (`role_level()` ya existente en `src/models/user.py`). Un admin puede invitar admin/moderador/viewer; solo un superadmin invita superadmin. Sin este guard, un admin se fabricaría un superadmin por interpósita invitación.
- `deps.py` **no cambia** (confirma la hipótesis del proposal): `require_min_role(UserRole.ADMIN)` cubre admin+ tal cual está.
- El shape de error sigue el patrón existente de `main.py`: `JSONResponse` con `{"error": "..."}` y `requests_total.labels(...)`.
- `validate` distingue 404/410 a propósito: el token tiene 256 bits — no hay riesgo de enumeración que justifique un 404 uniforme, y la UX de "vencido vs basura" lo vale.

**Alternatives considered**: (a) 404 uniforme en `validate` (descartado: sin riesgo de enumeración real, empeora UX); (b) `PATCH /auth/invitations/{id}` genérico en vez de `DELETE` + `/resend` (descartado: dos operaciones con semánticas y responses distintos — el resend devuelve un secreto — no un update genérico); (c) permitir a cualquier admin invitar superadmin (descartado por escalación).

### Decision 4: La API route de Next — autenticación por cookie JWT con `jose`, Resend server-only, y `email_sent_at` como confirmación de envío

**Choice**: `dashboard/app/api/invitations/send/route.ts` (runtime Node, no Edge — el SDK de Resend y el render de react-email son server Node):

1. Lee la cookie `session` (`cookies()` de `next/headers`) y la verifica con `jose.jwtVerify(token, AUTH_SECRET_KEY, HS256)` — **el mismo código y secreto que `dashboard/middleware.ts`** (se extrae un helper compartido `dashboard/lib/verify-session.ts` para no duplicar). Del payload verificado lee el claim `role` (el JWT ya lo trae — ver `create_access_token()`) y exige `role ∈ {admin, superadmin}`. Sin cookie/rol → **401/403 JSON**, nunca redirect. Cero round-trip al backend para autenticar: la firma HS256 compartida ES la verificación.
2. Body: `{invitationId, email, role, token, expiresAt}` (lo que devolvió el paso 1 del flujo). Arma el link `${INVITE_BASE_URL}/invite/${token}` — `INVITE_BASE_URL` env server-side en Vercel (`https://geospectrum.org`), con fallback al `origin` del request en dev.
3. Envía con `resend.emails.send({ from, to, subject, react: <InvitationEmail .../> })` — la prop `react:` del SDK renderiza el componente internamente; no hace falta invocar `@react-email/render` a mano. `RESEND_API_KEY` es env **server-side sin prefijo `NEXT_PUBLIC_`**, instanciada solo dentro de la route (jamás importar `resend` desde un client component — checklist para `sdd-tasks`).
4. Si Resend responde OK, la route llama `POST /auth/invitations/{id}/mark-sent` al backend **reenviando la cookie del request** (server-to-server con `Cookie: session=...`; el backend valida admin+ como siempre). Best-effort: si mark-sent falla, el email YA salió — se loguea y no se reporta error al admin.
5. Sin rate limiting dedicado (evaluado y descartado, YAGNI): la route exige JWT admin+, el flujo exige una invitación recién creada en el backend, el volumen es de decenas de emails, y Resend impone sus propios límites. Si mañana hay abuso, el punto de corte es esta route.

**`email_sent_at` — por qué así**: el proposal pide que la lista muestre si el email falló, pero el backend no envía emails y no puede saberlo solo. `email_sent_at IS NULL` en una invitación pendiente ⇒ badge "email sin confirmar" en la UI, con "Reenviar" como recuperación (regenera token + reintenta envío). La escritura viene de la route de Next con la cookie del admin — no es un reporte anónimo falsificable.

**react-email: setup manual, NO `npx create-email`**: `create-email` scaffoldea una app standalone con su propio `package.json` — innecesario. Se agregan `@react-email/components` y `resend` como dependencies de `dashboard/`, los templates viven como `.tsx` normales en `dashboard/emails/` (`InvitationEmail.tsx` + `components/EmailLayout.tsx` para reuso futuro — el Out of Scope del proposal anticipa más transaccionales). Para preview local: `npx react-email dev --dir emails` funciona contra ese directorio sin scaffold (script npm `email:dev`, devDependency `react-email`). react-email ≥ 3 y `@react-email/components` actuales soportan React 19 (verificar versión exacta en `sdd-tasks`, mismo criterio que Authlib en google-oauth).

**Alternatives considered**: (a) autenticar la route llamando a `GET /auth/me` del backend (descartado: round-trip extra por request cuando la verificación de firma local es equivalente en garantías — el middleware ya sienta ese precedente); (b) que la route orqueste TODO (crear en backend + enviar) (descartado: el proposal fija el flujo en dos pasos comandado por la UI; además dejaría al backend detrás de un proxy de Next para una operación que es suya); (c) columna `email_status` con estados failed/sent/pending (descartado: el único evento confiable es "Resend aceptó el envío" — un booleano temporal alcanza); (d) rate limiting con Redis en la route (descartado, YAGNI — documentado arriba).

### Decision 5: Aceptación — password consume por TOKEN; Google consume por EMAIL (el callback no necesita el token)

**Choice**: dos caminos de consumo sobre la misma primitiva `_consume_pending_invitation(conn, email, token=None)`:

- **Password** (`/invite/[token]` → `POST /auth/register` con `invitation_token`): el consumo matchea por `token_hash` Y valida que el `email` del payload sea el de la invitación (422 si no — el rol está atado al email invitado, no al portador del link).
- **Google**: `resolve_or_create_google_user()` — SOLO en la rama "usuario nuevo" (las ramas "ya vinculado" y "auto-link" quedan INTACTAS y se evalúan PRIMERO) — consume por match de `email` (case-insensitive, `lower()` en ambos lados): busca invitación pendiente y vigente `WHERE lower(email) = lower($google_email)`. Si existe: la consume (`accepted_at`, `accepted_by`) y usa **su rol** (no el bootstrap). Si no existe Y `_determine_bootstrap_role` no aplica (tabla no vacía): levanta `InvitationRequiredError` → el callback redirige `/login?error=google_no_invitation` (mismo patrón `_google_error_redirect()` existente).

**El callback de Google NO aprende el token, y no le hace falta.** La pregunta del task ("¿state param o server session?") se disuelve: la invitación está atada a un email, y Google entrega ese email verificado (`email_verified` ya validado en el callback). El botón "Continuar con Google" de `/invite/[token]` es un `window.location.href = ${API_URL}/auth/google/login` pelado, idéntico al del login. Consecuencia aceptada y correcta: si el invitado elige una cuenta de Google con OTRO email, no hay invitación para ese email → rechazo con mensaje claro; el link invita a una persona identificada por SU email, no a cualquier portador.

**Alternatives considered**:
- (a) Token en el `state` de OAuth — Authlib genera y valida el `state` internamente (CSRF); piggybackear datos propios ahí pelea contra la librería y mezcla dos responsabilidades (anti-CSRF + payload de negocio).
- (b) Guardar el token en `request.session` (la cookie `oauth_state` de SessionMiddleware ya instalada) antes del redirect, leerlo en el callback — funciona, pero es plumbing para transportar un dato que el callback puede derivar del email verificado. Además obliga a que el invitado inicie el flujo DESDE la página de invitación: con el consumo por email, un invitado que ignora el link y aprieta "Continuar con Google" directamente en `/login` TAMBIÉN entra — comportamiento estrictamente mejor.
- (c) Pre-validated server session en base — infraestructura nueva para el mismo resultado que (b).

**Post-registro con password — sin auto-cookie en `/auth/register`**: la página de aceptación, tras el 201, encadena `POST /auth/login` con las mismas credenciales (client-side, `dashboard/lib/auth.ts` ya tiene `login()`) y redirige a `/`. Cambiar `/auth/register` para emitir cookie alteraría un contrato existente y sus tests por pura conveniencia; dos requests encadenados dan el mismo UX (nota: si el invitado tuviera 2FA sería imposible en un registro nuevo — el caso no existe).

**Página `/invite/[token]`** (`dashboard/app/invite/[token]/page.tsx`, fuera de `(app)`, mismo criterio que `login/`): al montar llama `GET /auth/invitations/validate?token=...`; 404 → "invitación inválida"; 410 → "vencida/revocada — pedí un reenvío"; 200 → muestra email + rol invitado (read-only) y las dos opciones (form de password | botón Google). `dashboard/middleware.ts`: `PUBLIC_PATHS = [LOGIN_PATH, '/invite']` (el matcher por prefijo existente cubre `/invite/xyz`).

### Decision 6: Gate del onboarding — `onboarding_completed_at` viaja en `/auth/me` leído de la BASE, no del JWT

**Choice**: `GET /auth/me` deja de devolver `CurrentUser` pelado y pasa a un response model `MeResponse` = `CurrentUser` + `onboarding_completed_at: Optional[datetime]`, resuelto con un `SELECT onboarding_completed_at FROM users WHERE id = $1` (PK lookup, costo despreciable) vía un método nuevo `AuthService.get_onboarding_status()`. El JWT no se toca.

**Alternatives considered**: (a) claim en el JWT (descartado: el JWT vive `auth_token_expire_minutes` — tras completar el wizard, el claim quedaría stale y el wizard reaparecería hasta re-login; un dato mutable no va en un token inmutable); (b) endpoint aparte `GET /auth/me/onboarding` (descartado: segundo round-trip en cada carga del layout para un dato que viaja gratis en el `getMe()` que el frontend ya hace); (c) `localStorage` (descartado: el proposal exige persistencia server-side — cambiar de browser no debe resucitar el wizard).

**Rationale**: el frontend ya llama `getMe()` al montar (`dashboard/lib/auth.ts:95`); extender su response es el camino de menor fricción y cero requests extra. `main.py` ya tiene `auth_service` en `app.state` para el lookup.

### Decision 7: Tour — **driver.js**, no react-joyride ni casero

**Choice**: `driver.js` v1.x (`driver.js` en npm, MIT, ~5 kB gzip, cero dependencias).

**Alternatives considered**:
- (a) **react-joyride** — la opción "React nativa", pero es exactamente donde muerde la compatibilidad: depende de peer deps y de internals de React (portals/`react-floater`) con historial de roturas en cada major de React; su soporte de React 19 llegó tarde y el mantenimiento es a ritmo lento. Acoplar el tour al ciclo de releases de un wrapper React es riesgo puro con Next 15.5 + React 19.2.
- (b) **Casero** (overlay + `getBoundingClientRect` + popover) — control total, pero "calidad profesional" (requisito explícito) implica: recorte del highlight con animación, reposicionamiento en resize/scroll, focus trap, teclado, flechas del popover. Son ~500 líneas de UI sutil que driver.js ya resuelve y testea. Reinventarlo contradice el criterio del proyecto (ver Decision 2 de google-oauth: no reimplementar lo que la librería resuelve).
- (c) **driver.js** (elegido) — vanilla JS puro: manipula DOM directamente, sin peer dependency de React, inmune por construcción a los majors de React/Next. Se integra con un hook fino (`useTour()`) que instancia el driver en `useEffect` (client-only; con `"use client"` + efecto no hay problema de SSR). API declarativa de steps con selectores CSS.

**Anclas**: atributos **`data-tour-id="..."`** propios sobre los elementos reales (riesgo explícito del proposal: el dashboard se rediseñó hace días; clases de Tailwind y estructura DOM son volátiles, un atributo semántico propio no). Anclas previstas: `data-tour-id="map"` (contenedor del mapa en la home), `nav-globe`, `nav-areas`/`area-selector` (AreaSelector.tsx), `alerts-bell` (NotificationBell.tsx), agregadas en `AppSidebar.tsx`/`Header.tsx`/`AreaSelector.tsx`/`NotificationBell.tsx` y la page del dashboard.

**Estructura del wizard** (`dashboard/components/onboarding/`):

```
components/onboarding/
├── OnboardingGate.tsx      # "use client" — montado en app/(app)/layout.tsx; si
│                           #   me.onboarding_completed_at === null → renderiza el wizard
├── OnboardingWizard.tsx    # modal shadcn/Radix (patrón ui/ existente), pasos 1-2
├── useTour.ts              # hook que encapsula driver.js (import dinámico client-only)
└── tour-steps.ts           # definición declarativa de los pasos (data-tour-id + textos)
```

**Pasos**: (1) bienvenida + nombre — input que persiste vía el `PATCH` de perfil existente (`update_profile()`/`full_name`), prefill si ya hay valor; (2) área inicial — reusa `AreaSelector` (AOI-1) para elegir el área activa; (3) tour driver.js sobre la página actual (dashboard home): mapa → entrada Globo en el sidebar → selector de áreas → campana de alertas. **El tour NO navega entre páginas**: resalta las entradas de navegación en vez de visitar `/globe` etc. — un tour multi-página exige persistir estado entre navegaciones App Router y re-sincronizar con el mount de cada página; fragilidad sin beneficio proporcional.

**Skip/resume**: "Saltar" (visible en todo momento) y terminar el tour convergen en lo mismo: `POST /auth/me/onboarding-complete` → el wizard no vuelve nunca (requisito del proposal: completar O saltar persisten). Si el usuario cierra el browser a mitad de camino SIN saltar, `onboarding_completed_at` sigue NULL → el wizard reaparece desde el paso 1 en el próximo login; los pasos son idempotentes (nombre prefilled, área preseleccionada), así que "resume" = "restart barato". No se persiste el paso actual server-side (estado granular para un flujo de 3 pasos: YAGNI).

### Decision 8: Modelos Pydantic — `src/models/invitation.py`

**Choice**: archivo nuevo con `InvitationCreate` (email `EmailStr` + role `UserRole`), `InvitationPublic` (sin hash — id, email, role, status derivado, invited_by, created_at, expires_at, accepted_at, email_sent_at), `InvitationWithToken` (`InvitationPublic` + `token: str`, SOLO como response de create/resend), y `InvitationStatus` (str-Enum: pending/accepted/revoked/expired). `UserCreate` (en `user.py`) gana `invitation_token: Optional[str] = None`. Excepciones nuevas en los servicios, mismo patrón de clases plana existente: `InvitationRequiredError`, `InvalidInvitationError`, `InvitationAlreadyExistsError`, `InvitationAlreadyAcceptedError`, `CannotInviteHigherRoleError` — cada una traducida a su HTTP code (Decision 3) por el endpoint, nunca por el servicio.

**Rationale**: `token` separado en `InvitationWithToken` hace imposible por construcción de tipos que un endpoint de listado filtre el claro (misma técnica que `UserProfileUpdate` documenta en `update_profile()`: garantía de diseño de tipos, no chequeo runtime).

### Decision 9: Expiración — default 7 días, evaluada en lectura, sin worker

**Choice**: `invitation_expire_days: int = 7` nuevo en `Settings` (configurable por env, sin fail-fast — tiene default). La expiración se evalúa en cada `validate`/consumo/listado vía el predicado `expires_at > now()`; no hay job que "marque expiradas" (el estado es derivado, Decision 1 — no hay nada que marcar). Coincide con el Out of Scope del proposal (sin auto-expiración con scheduler).

### Decision 10: Orden de chequeos y rollout — ningún usuario existente queda afuera

**Choice — orden de chequeos en código** (la mitigación del riesgo High del proposal, fijada acá como contrato):

- `resolve_or_create_google_user()`: (1) `UPDATE ... WHERE google_id` → si matchea, login igual que hoy, **jamás toca invitations**; (2) auto-link por email → ídem; (3) recién en la rama "usuario nuevo": invitación por email o bootstrap (tabla vacía) o `InvitationRequiredError`. Existencia de cuenta PRIMERO, invitación después.
- `create_user()`: (1) `_determine_bootstrap_role()` — si tabla vacía, registra superadmin SIN token (excepción de bootstrap preservada, dev/staging/DR); (2) tabla no vacía → exige y consume token o falla ANTES del INSERT.
- El login por password (`POST /auth/login`) **no se toca en absoluto**.

**Orden de despliegue**:
1. **Migración 007** contra el TimescaleDB de prod (puerto 5433 en local — memoria del proyecto) ANTES del código: aditiva; el código viejo ignora `invitations` y `onboarding_completed_at`. El backfill de onboarding corre acá, cuando aún no hay código que lea la columna.
2. **Backend (Railway)**: en este instante el registro queda cerrado y Google-sin-cuenta queda bloqueado — es el comportamiento deseado, y ningún usuario existente se ve afectado por el orden de chequeos de arriba. Sin secretos nuevos en Railway.
3. **Dashboard (Vercel)**: página `/invite`, UI admin, route de envío, onboarding. Env nuevas en Vercel: `RESEND_API_KEY` (server-only), `INVITE_BASE_URL`. Desplegar el dashboard después del backend evita una ventana donde la UI admin llama endpoints que aún no existen (la inversa — backend primero — no rompe nada visible: el registro simplemente ya está cerrado).
4. **Verificación en prod** (checklist para `sdd-verify`): login password existente OK; login Google existente OK (incluido auto-link); Google sin cuenta ni invitación → error claro en `/login`; invitación end-to-end al propio email (si el dominio Resend sigue sin verificar, Resend permite enviar al email de la propia cuenta — Dependency del proposal).

**Rollback**: el del proposal aplica sin cambios; este design no agrega estado nuevo fuera de la tabla 007 y las dos env de Vercel.

## Data Flow

```
CREACIÓN + ENVÍO (dos pasos, orquestados por la UI admin)

Admin UI (app)/admin/invitations          Backend FastAPI                Next API route              Resend
  │                                          │                              │                          │
  │ 1. POST /auth/invitations {email, role}  │                              │                          │
  ├─────────────────────────────────────────>│ require_min_role(ADMIN)      │                          │
  │                                          │ guard rol <= rol inviter     │                          │
  │                                          │ 409 si email ya en users     │                          │
  │                                          │ 409 si pendiente vigente     │                          │
  │                                          │ token = token_urlsafe(32)    │                          │
  │                                          │ INSERT (sha256(token), ...)  │                          │
  │ 201 {id, email, role, token, expires_at} │                              │                          │
  │<─────────────────────────────────────────┤                              │                          │
  │ 2. POST /api/invitations/send            │                              │                          │
  │    {invitationId, email, role, token,    │                              │                          │
  │     expiresAt}  (cookie session viaja)   │                              │                          │
  ├─────────────────────────────────────────────────────────────────────────>│ jwtVerify(cookie) +     │
  │                                          │                              │  role ∈ admin+           │
  │                                          │                              │ render <InvitationEmail> │
  │                                          │                              ├─────────────────────────>│
  │                                          │                              │<─────────── ok ──────────┤
  │                                          │ 3. POST /auth/invitations/   │                          │
  │                                          │    {id}/mark-sent            │                          │
  │                                          │<─────────────────────────────┤ (cookie reenviada,       │
  │                                          │ email_sent_at = now()        │  best-effort)            │
  │ 200 {sent: true}                         │                              │                          │
  │<─────────────────────────────────────────────────────────────────────────┤                          │

ACEPTACIÓN

Invitado ── link email ──> /invite/[token] ── GET /auth/invitations/validate?token ──> 200 {email, role}
    │                                                          (404 inválida / 410 vencida-revocada-usada)
    ├── camino password: POST /auth/register {email, password, invitation_token}
    │       └─ AuthService.create_user(): transacción única
    │            bootstrap? ──no──> _consume_pending_invitation(conn, email, token)  ─┐
    │            (410/403 si no hay invitación válida)                                │ mismo
    │            INSERT users con role de la invitación  <────────────────────────────┘ conn.transaction()
    │       └─ página encadena POST /auth/login → cookie session → redirect /
    │
    └── camino Google: window.location = API/auth/google/login  (SIN token)
            └─ callback: email_verified → resolve_or_create_google_user()
                 rama 1 ya-vinculado / rama 2 auto-link: INTACTAS (no tocan invitations)
                 rama 3 nuevo: invitación pendiente por email → consume + usa su rol
                              sin invitación y sin bootstrap → InvitationRequiredError
                              → redirect /login?error=google_no_invitation

ONBOARDING (primer login)

(app)/layout ── getMe() ──> onboarding_completed_at === null?
    └─ sí → OnboardingWizard (nombre → área → tour driver.js sobre data-tour-id)
              └─ completar O saltar → POST /auth/me/onboarding-complete → nunca más
```

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `deploy/sql/migrations/007_invitations.sql` | Create | Tabla `invitations` + `users.onboarding_completed_at` + backfill. SQL exacto abajo. |
| `src/models/invitation.py` | Create | `InvitationCreate`, `InvitationPublic`, `InvitationWithToken`, `InvitationStatus` (Decision 8). |
| `src/models/user.py` | Modify | `UserCreate.invitation_token: Optional[str] = None`; response model `MeResponse` (o campo en `CurrentUser`-response, ver Decision 6). |
| `src/services/invitation_service.py` | Create | `InvitationService` (create/list/revoke/resend/validate/mark_email_sent) + `PENDING_PREDICATE_SQL` + excepciones. Pool inyectado. |
| `src/services/auth_service.py` | Modify | `_consume_pending_invitation(conn, email, token=None)`; precondición en `create_user()` y en la rama "nuevo" de `resolve_or_create_google_user()`; `get_onboarding_status()` y `complete_onboarding()`; `InvitationRequiredError`/`InvalidInvitationError`. Bootstrap y auto-link INTACTOS. |
| `src/main.py` | Modify | Endpoints `/auth/invitations*` (sección auth existente, mismo estilo métricas/errores), contrato nuevo de `POST /auth/register`, `GET /auth/me` extendido, `POST /auth/me/onboarding-complete`; `invitation_service` en `lifespan()`/`app.state` con el pool compartido; `_google_error_redirect("google_no_invitation")` en el callback. |
| `src/api/deps.py` | Unmodified | Confirmado (Decision 3): `require_min_role(ADMIN)` cubre todo. |
| `src/config/settings.py` | Modify | `invitation_expire_days: int = 7` (Decision 9). |
| `dashboard/middleware.ts` | Modify | `PUBLIC_PATHS = [LOGIN_PATH, '/invite']`; extraer verificación JWT a `lib/verify-session.ts` compartido con la API route. |
| `dashboard/lib/verify-session.ts` | Create | `jwtVerify` HS256 + `AUTH_SECRET_KEY`, retorna payload tipado `{sub, email, role, ...}` o null. Usado por middleware y route. |
| `dashboard/app/api/invitations/send/route.ts` | Create | Decision 4: auth admin+ vía cookie, Resend server-only, mark-sent best-effort. |
| `dashboard/emails/InvitationEmail.tsx` + `emails/components/EmailLayout.tsx` | Create | Template react-email (español, branding GeoSpectrum), layout reusable para transaccionales futuros. |
| `dashboard/app/invite/[token]/page.tsx` | Create | Página pública de aceptación (Decision 5): validate → password o Google. |
| `dashboard/app/(app)/admin/invitations/page.tsx` | Create | UI de gestión admin-only: form crear (email + selector de rol limitado al nivel propio), tabla con status + badge de email, revocar, reenviar. Se elige `(app)/admin/` (no `settings/`): settings es "mi cuenta", esto es administración de la plataforma; deja el namespace listo para la gestión de usuarios diferida. Gate client-side por `role` del `getMe()` (ocultar en sidebar + redirect si viewer/moderador entra por URL; el enforcement real es del backend). |
| `dashboard/components/AppSidebar.tsx` | Modify | Entrada "Invitaciones" visible solo para admin+; atributos `data-tour-id`. |
| `dashboard/components/onboarding/*` | Create | `OnboardingGate`, `OnboardingWizard`, `useTour`, `tour-steps` (Decision 7). |
| `dashboard/app/(app)/layout.tsx` | Modify | Monta `OnboardingGate`. |
| `dashboard/app/login/page.tsx` | Modify | Mensaje para `?error=google_no_invitation`; sin afordancia de registro abierto. |
| `dashboard/lib/auth.ts` | Modify | `getMe()` tipa `onboarding_completed_at`; helpers de invitaciones (create/list/revoke/resend/send). |
| `dashboard/package.json` | Modify | deps: `resend`, `@react-email/components`, `driver.js`; devDep: `react-email` (preview); script `email:dev`. |
| `tests/unit/test_invitation_service.py` | Create | CRUD, unicidad de pendiente vigente, guard de escalación, hashing. |
| `tests/unit/test_auth_service.py` | Modify | Consumo por token y por email, bootstrap sin token, doble uso concurrente CONTRA LA BASE REAL (lección documentada del proyecto: no mocks). |
| `tests/integration/test_auth_api.py` | Modify | Registro cerrado (403/410), bootstrap, Google con/sin invitación, no-regresión de usuarios existentes; los tests de registro abierto se ACTUALIZAN (rotura por diseño, prevista en el proposal). |
| `tests/integration/test_invitations_api.py` | Create | Superficie `/auth/invitations*` completa incl. 401/403 por rol. |

## Interfaces / Contracts

### Migración `007_invitations.sql`

```sql
-- Migration 007: registro invitation-only (email-invitations).
-- Convención del proyecto (ver 001-006): manual, sin Alembic, idempotente.

CREATE TABLE IF NOT EXISTS invitations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'moderador', 'viewer')),
    token_hash     TEXT NOT NULL UNIQUE,          -- sha256 hex; NUNCA el token en claro
    invited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    accepted_at    TIMESTAMPTZ,                   -- estado DERIVADO de timestamps, sin columna status
    revoked_at     TIMESTAMPTZ,
    email_sent_at  TIMESTAMPTZ                    -- confirmación de envío (mark-sent desde Next)
);

CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (lower(email));

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill: los usuarios EXISTENTES no deben ver el wizard de onboarding
-- (es para usuarios nuevos invitados). Corre una sola vez, antes del deploy
-- del código que lee la columna.
UPDATE users SET onboarding_completed_at = now() WHERE onboarding_completed_at IS NULL;

-- Rollback:
-- DROP TABLE IF EXISTS invitations;             -- sin FKs entrantes desde otras tablas
-- ALTER TABLE users DROP COLUMN IF EXISTS onboarding_completed_at;
-- (Los usuarios creados por invitación sobreviven como usuarios normales;
--  solo se pierde la trazabilidad de quién los invitó — aceptable en rollback.)
```

### `InvitationService` (métodos públicos)

```python
class InvitationService:
    def __init__(self, pool: asyncpg.Pool, expire_days: int) -> None: ...

    async def create_invitation(
        self, email: str, role: UserRole, invited_by: CurrentUser
    ) -> InvitationWithToken:
        """Guard de escalación (CannotInviteHigherRoleError si role_level(role)
        > role_level(invited_by.role)); 409 lógico si email ya en users
        (EmailAlreadyRegisteredError reutilizada) o si existe pendiente
        vigente (InvitationAlreadyExistsError). token_urlsafe(32); persiste
        sha256; retorna el claro UNA vez. Transaccional (chequeos + INSERT)."""

    async def list_invitations(self) -> list[InvitationPublic]: ...
    async def revoke_invitation(self, invitation_id: UUID) -> None: ...      # 409 si aceptada
    async def resend_invitation(self, invitation_id: UUID) -> InvitationWithToken:
        """Regenera token_hash y expires_at, resetea email_sent_at a NULL.
        409 si aceptada/revocada. El link anterior queda muerto (hash pisado)."""
    async def validate_token(self, token: str) -> InvitationPublic: ...      # excepciones -> 404/410
    async def mark_email_sent(self, invitation_id: UUID) -> None: ...

# Compartido con AuthService (misma definición de "pendiente y vigente"):
PENDING_PREDICATE_SQL = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()"
```

### `AuthService` — cambios

```python
@staticmethod
async def _consume_pending_invitation(
    conn: asyncpg.Connection, email: str, token: Optional[str] = None
) -> Optional[asyncpg.Record]:
    """UPDATE invitations SET accepted_at = now()
       WHERE {PENDING_PREDICATE_SQL}
         AND (token match por sha256(token) si token no es None,
              si no lower(email) = lower($email))
       RETURNING id, email, role
    Single-use atómico: DEBE invocarse dentro de la transacción del caller.
    None => no había invitación consumible."""

async def create_user(self, email, password, role, invitation_token=None) -> UserPublic:
    # dentro de la transacción existente:
    #   bootstrap (tabla vacía) -> igual que hoy, sin invitación
    #   si no: sin token -> InvitationRequiredError (403)
    #          consume por token -> None -> InvalidInvitationError (410)
    #          email payload != email invitación -> InvalidInvitationError (422 en endpoint)
    #          rol del INSERT = rol de la invitación

# resolve_or_create_google_user(): ramas 1 y 2 intactas; rama 3 (nuevo):
#   bootstrap OR consume por email OR raise InvitationRequiredError
#   (callback -> _google_error_redirect("google_no_invitation"))

async def get_onboarding_status(self, user_id: UUID) -> Optional[datetime]: ...
async def complete_onboarding(self, user_id: UUID) -> None:  # idempotente
```

### API route de Next — `app/api/invitations/send/route.ts`

```typescript
// runtime nodejs (Resend SDK + react-email). NUNCA importar desde client components.
export async function POST(req: Request) {
  const session = await verifySession(); // lib/verify-session.ts: jose + AUTH_SECRET_KEY
  if (!session) return json401();
  if (!['admin', 'superadmin'].includes(session.role)) return json403();

  const { invitationId, email, role, token, expiresAt } = await req.json();
  const inviteUrl = `${process.env.INVITE_BASE_URL}/invite/${token}`;

  const resend = new Resend(process.env.RESEND_API_KEY); // server-only, sin NEXT_PUBLIC
  const { error } = await resend.emails.send({
    from: 'GeoSpectrum <invitaciones@geospectrum.org>',
    to: email,
    subject: 'Te invitaron a GeoSpectrum',
    react: InvitationEmail({ email, role, inviteUrl, expiresAt }),
  });
  if (error) return NextResponse.json({ sent: false, error: ... }, { status: 502 });

  // best-effort: confirma el envío en el backend reenviando la cookie del admin
  await fetch(`${API_BASE_URL}/auth/invitations/${invitationId}/mark-sent`, {
    method: 'POST', headers: { cookie: req.headers.get('cookie') ?? '' },
  }).catch(logOnly);

  return NextResponse.json({ sent: true });
}
```

### `POST /auth/register` — contrato nuevo

```
Body: { email, password, invitation_token? }
201  igual que hoy (rol = invitación, o superadmin si bootstrap)
403  {"error": "invitation required"}   tabla no vacía y sin token
410  {"error": "invalid invitation"}    token desconocido/expirado/revocado/consumido
422  email del payload != email de la invitación
409  {"error": "email already registered"} (sin cambios)
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `InvitationService`: create (hash persistido != claro, guard de escalación, 409 por duplicado pendiente vigente, permitir re-crear si la anterior expiró), revoke (409 sobre aceptada), resend (hash nuevo, `email_sent_at` reseteado, link viejo muerto), validate (404/410/200), mark_email_sent | pytest + testcontainers Postgres — contra base real, mismo harness que `test_auth_service.py` |
| Unit | `AuthService`: registro con token válido usa el rol de la invitación; bootstrap sin token preservado; sin token → `InvitationRequiredError`; **doble accept concurrente: exactamente uno gana** (dos `create_user` en paralelo con el mismo token, `asyncio.gather`) — CONTRA LA BASE REAL, lección documentada del proyecto (los mocks son ciegos a esto) | pytest + testcontainers |
| Unit | `resolve_or_create_google_user()`: usuario ya vinculado y auto-link NO tocan `invitations` (regresión de lockout); nuevo con invitación → rol de la invitación + consumida; nuevo sin invitación → `InvitationRequiredError`; email match case-insensitive | pytest + testcontainers |
| Integration | Superficie `/auth/invitations*`: 401 sin sesión, 403 viewer/moderador, 200/201 admin y superadmin; admin no invita superadmin (403); `validate` público sin sesión | `TestClient`, patrón de `test_auth_api.py` |
| Integration | `/auth/register` cerrado: matriz 403/410/422/201; `/auth/me` incluye `onboarding_completed_at`; `onboarding-complete` idempotente; callback Google sin invitación → redirect `/login?error=google_no_invitation` (mock de Authlib como en tests existentes) | `TestClient` + testcontainers |
| Frontend | `verify-session.ts` (token válido/expirado/rol), render del template `InvitationEmail` (snapshot del link), página `/invite/[token]` (estados 200/404/410) | Vitest |
| E2E | Wizard de onboarding: aparece con `onboarding_completed_at` null, anclas `data-tour-id` presentes, saltar persiste y no reaparece (riesgo "tour acoplado a la UI" del proposal) | Playwright, mínimo indispensable |
| Manual (`sdd-verify`) | Email real vía Resend (al email de la cuenta si el dominio sigue sin verificar), flujo completo invitación→aceptación password y Google, no-regresión de login de usuarios existentes EN PRODUCCIÓN | Checklist de Decision 10 |

## Migration / Rollout

Ver Decision 10 — orden: (1) migración 007 con backfill, (2) backend Railway, (3) dashboard Vercel con `RESEND_API_KEY` + `INVITE_BASE_URL`, (4) checklist de verificación en prod. Rollback según proposal (código revertible, `DROP TABLE invitations` + `DROP COLUMN onboarding_completed_at` documentados en el SQL, el gate de onboarding desactivable solo-frontend).

## Open Questions

Ninguna bloqueante para `sdd-tasks`. A fijar durante tasks/apply:

- [ ] Versiones exactas de `resend`, `@react-email/components`, `react-email` (compat React 19 confirmada en npm al momento de instalar) y `driver.js` (1.3.x esperada).
- [ ] Remitente definitivo (`invitaciones@geospectrum.org` vs `no-reply@`) — depende de la verificación del dominio en Resend (prerequisito externo del usuario, no bloquea).
- [ ] Copy final de los pasos del wizard y del email (español, i18n fuera de scope).
