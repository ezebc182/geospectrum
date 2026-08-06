# Proposal: Registro por invitación con emails (Resend + react-email) y onboarding guiado

## Intent

Hoy cualquiera puede crear una cuenta en geospectrum.org: `POST /auth/register` está abierto (email/password) y `GET /auth/google/callback` crea cuenta nueva ante cualquier Google login con email verificado (ver `openspec/changes/google-oauth/`, implementado y en producción). El usuario pidió cerrar el registro y convertirlo en **invitation-only**: un superadmin/admin invita por email, asignando el rol al momento de invitar; el invitado acepta vía un link con token y expiración, crea su cuenta (con password o con Google) y aterriza en un onboarding de primera vez con un tour guiado profesional por las áreas clave del producto (mapa, globo, áreas de interés, alertas).

Decisiones ya tomadas por el usuario (no reabrir):

1. **Emails**: templates con `react-email` renderizados en el dashboard Next.js, enviados vía **Resend** desde una API route de Next. El dominio `geospectrum.org` lo verifica el usuario en Resend (prerequisito externo).
2. **Registro cerrado**: no queda ningún camino de alta abierta. El login con Google también debe verificar que exista una invitación pendiente **o** que la cuenta ya exista.
3. **Onboarding**: flujo de aceptación de invitación (cuenta con password o Google, rol pre-asignado desde la invitación) MÁS un wizard post-primer-login con tour interactivo guiado — calidad profesional, no un tooltip suelto.
4. **Gestión**: invitaciones creadas por superadmin/admin, con rol asignado al invitar, link con token y expiración, y capacidad de revocar/reenviar.

El problema de negocio: el producto pasa de "demo abierta" a plataforma con usuarios reales invitados (colaboradores de vulcanología/sismología), donde el control de quién entra y con qué rol es un requisito, no un nice-to-have.

## Scope

### In Scope

- **Migración `007_invitations.sql`** (manual, mismo formato que 001–006, aplicada a mano — NO hay Alembic): tabla `invitations` (id, email, role, token hasheado, invited_by FK a users, expires_at, estado accepted/revoked/pending derivable, timestamps) + columna `users.onboarding_completed_at` (nullable) para persistir si el usuario ya completó el wizard.
- **Endpoints FastAPI** en `src/main.py` (patrón monolítico existente):
  - `POST /auth/invitations` (admin+): crea invitación con email + rol, genera token, devuelve el token en claro UNA sola vez (para que el dashboard arme el link y dispare el email).
  - `GET /auth/invitations` (admin+): lista con estado (pendiente/aceptada/revocada/expirada).
  - `DELETE /auth/invitations/{id}` (admin+): revocación.
  - `POST /auth/invitations/{id}/resend` (admin+): regenera token y expiración (invalida el link anterior), para el flujo de reenvío.
  - `GET /auth/invitations/validate?token=...` (público): valida token para la página de aceptación (email + rol asociados, sin exponer nada más).
- **Cierre del registro abierto**: `POST /auth/register` pasa a exigir un token de invitación válido (consumo single-use, transaccional). **Excepción explícita preservada**: la regla de bootstrap "tabla `users` vacía → primer registro es superadmin" (`AuthService._determine_bootstrap_role`) sigue funcionando SIN invitación — es lo que evita el lockout total en un ambiente fresco (dev, staging, disaster recovery).
- **Enforcement en Google OAuth**: `resolve_or_create_google_user()` (en `src/services/auth_service.py`) solo crea cuenta nueva si existe invitación pendiente y no expirada para ese email (consumiéndola y usando su rol); si la cuenta ya existe (por password o por Google), el login sigue funcionando igual que hoy, incluido el auto-link por email ya implementado. Sin invitación y sin cuenta → rechazo con mensaje claro en `/login`.
- **UI de gestión de invitaciones** en el dashboard (admin-only, protegida por rol): crear invitación (email + selector de rol), listar con estado, revocar, reenviar. Ubicación candidata: sección nueva bajo `dashboard/app/(app)/settings/` o `dashboard/app/(app)/admin/` — a decidir en `sdd-design`.
- **Integración Resend + react-email en el dashboard**: dependencias `resend`, `react-email`/`@react-email/components`; templates en `dashboard/emails/` (invitación como mínimo); API route `dashboard/app/api/invitations/send/route.ts` que renderiza el template y envía vía Resend. La route MUST validar que quien la llama es admin+ (verificando la cookie de sesión JWT HS256 con `AUTH_SECRET_KEY`, que el dashboard ya comparte con el backend — mismo mecanismo que `dashboard/middleware.ts`).
- **Página de aceptación de invitación**: ruta pública `dashboard/app/invite/[token]/page.tsx` (fuera del grupo `(app)`, como `login/`), con allowlist en `dashboard/middleware.ts`. Muestra a qué fue invitado, y permite crear la cuenta con password **o** continuar con Google; el rol viene pre-asignado de la invitación, jamás del cliente.
- **Wizard de onboarding post-primer-login** con tour interactivo guiado (mapa, globo, áreas de interés, alertas): se dispara cuando `onboarding_completed_at IS NULL`, se puede saltar, y al completarse (o saltarse) persiste vía endpoint (ej. `POST /auth/me/onboarding-complete`). Calidad profesional: pasos con foco visual sobre la UI real, no un carrusel de screenshots. Librería de tour (driver.js, react-joyride, o casero) a evaluar en `sdd-design`.

### Out of Scope

- Emails transaccionales más allá de la invitación (alertas sísmicas por email, notificación de link de cuenta Google, reset de password) — el pipeline Resend + react-email que este change instala los habilita a futuro, pero no se implementan acá.
- Recuperación de password, verificación de email propia, cambios al modelo 2FA/TOTP existente.
- Invitaciones masivas (CSV/bulk) y auto-expiración con job programado — la expiración se evalúa al validar/consumir, no con un worker.
- Gestión general de usuarios (cambiar rol de un usuario existente, desactivar cuentas) — este change solo gestiona *invitaciones*; la administración de usuarios ya creados sigue diferida.
- i18n del wizard y de los emails (pedido aparte en el roadmap) — se escriben en español, como el resto de la UI.
- Migrar el envío de emails al backend Python — decisión explícita del usuario: Resend + react-email viven en el dashboard.

## Approach

La invitación vive en el **backend** (fuente de verdad: tabla `invitations`, validación, consumo transaccional, enforcement de roles); el **email** vive en el **dashboard** (react-email + Resend), porque los templates son React y Resend tiene SDK de primera clase en Node. El flujo de creación es en dos pasos orquestados por la UI de admin: (1) `POST /auth/invitations` al backend → devuelve token en claro una única vez; (2) la UI llama a `POST /api/invitations/send` (Next) con el link armado → render del template y envío vía Resend. El token se guarda **hasheado** en la base (mismo criterio que passwords: si se filtra un dump, los links no son utilizables); por eso el reenvío regenera token en vez de releer el existente.

El cierre del registro es aditivo sobre lo existente: `create_user()` y `resolve_or_create_google_user()` ganan una precondición (invitación válida) sin duplicar la regla de bootstrap ni el auto-link por email ya implementados — ambos caminos convergen en el mismo consumo transaccional de la invitación (marcar aceptada + crear usuario en la misma transacción, para que no haya doble uso con requests concurrentes).

El onboarding es frontend-first: un provider en el layout de `(app)` decide si mostrar el wizard según `onboarding_completed_at` del `GET /auth/me`, y un endpoint mínimo persiste la finalización. El tour resalta elementos reales de la UI en `live`, `globe`, `settings` (áreas) y alertas.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `deploy/sql/migrations/007_invitations.sql` | New | Tabla `invitations` + `users.onboarding_completed_at`. Manual, reversible (ver Rollback Plan), documentada en el propio archivo como 001–006. |
| `src/models/invitation.py` | New | Modelos Pydantic: `InvitationCreate`, `InvitationPublic`, estados. Rol restringido al enum `UserRole` existente. |
| `src/services/auth_service.py` (o `invitation_service.py` nuevo) | Modified/New | Crear/listar/revocar/reenviar/validar/consumir invitaciones; precondición de invitación en `create_user()` y `resolve_or_create_google_user()` SIN tocar bootstrap ni auto-link. Split en servicio propio a decidir en `sdd-design`. |
| `src/main.py` | Modified | Endpoints `/auth/invitations*` (admin+ vía deps de rol existentes), cambio de contrato de `POST /auth/register` (requiere `invitation_token` salvo bootstrap), endpoint de onboarding-complete. |
| `src/api/deps.py` | Unmodified (probable) | `require_min_role` ya cubre admin+; a confirmar en `sdd-design`. |
| `dashboard/app/invite/[token]/page.tsx` | New | Página pública de aceptación: password o Google, rol pre-asignado server-side. |
| `dashboard/middleware.ts` | Modified | Allowlist de `/invite/*` como ruta pública (hoy solo `/login` y estáticos). |
| `dashboard/app/(app)/settings/` o `(app)/admin/` | New | UI de gestión de invitaciones (admin-only; ocultar/403 según rol del JWT). |
| `dashboard/emails/` | New | Templates react-email (invitación). |
| `dashboard/app/api/invitations/send/route.ts` | New | Render + envío vía Resend; valida sesión admin+ con `AUTH_SECRET_KEY`. |
| `dashboard/components/onboarding/` + layout `(app)` | New/Modified | Wizard + tour guiado; gate por `onboarding_completed_at` de `/auth/me`. |
| `dashboard/package.json` | Modified | `resend`, `react-email`/`@react-email/components`, librería de tour. |
| `dashboard/app/login/page.tsx` | Modified | Quitar/ajustar cualquier afordancia de "crear cuenta" abierta; mensaje claro cuando Google rechaza por falta de invitación. |
| `src/config/settings.py` / env Vercel + Railway | Modified | `RESEND_API_KEY` y `NEXT_PUBLIC`/URL base del link de invitación en Vercel; sin secretos nuevos en Railway salvo que design lo requiera. |
| `tests/unit/` y `tests/integration/` | New/Modified | CRUD/consumo de invitaciones, registro cerrado, bootstrap preservado, Google con/sin invitación. Los tests existentes de `/auth/register` abierto DEBEN actualizarse (van a romper por diseño). |
| `openspec/specs/backend-api/spec.md`, `specs/dashboard-ui/spec.md` | Modified (al archivar) | Deltas de comportamiento: registro invitation-only, gestión de invitaciones, onboarding. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| **Lockout**: cerrar el registro no debe afectar a NINGÚN usuario existente (password o Google) ni romper el bootstrap de ambiente fresco. Si el enforcement de Google se implementa antes del chequeo "la cuenta ya existe", usuarios reales en producción quedan afuera. | High (impacto) / Low (si se especifica bien) | `sdd-spec` MUST escribir escenarios explícitos: (1) usuario existente password → login igual; (2) usuario existente Google → login igual, auto-link intacto; (3) tabla `users` vacía → registro sin invitación → superadmin; (4) Google sin cuenta y sin invitación → rechazo. Orden de chequeos: existencia de cuenta PRIMERO, invitación después. |
| **Doble uso del token** con requests concurrentes (dos accepts simultáneos, o password + Google en paralelo). | Medium | Consumo transaccional: `UPDATE invitations ... WHERE ... AND accepted_at IS NULL RETURNING` + creación de usuario en la misma transacción. Escenario dedicado en `sdd-spec`; verificar contra la base real, no con mocks (lección documentada del proyecto). |
| **Token en claro viaja por email**: si se guarda en claro en la base, un dump filtra links válidos de alta con rol pre-asignado (incluso admin). | Medium | Guardar solo hash (SHA-256 alcanza — token de alta entropía, no password humana); devolver el claro solo en la respuesta de creación/reenvío. Expiración corta (default 7 días, configurable) y single-use. |
| **La API route de Next que envía emails queda abierta**: sin validación de rol, cualquiera con sesión (o sin ella) usa a geospectrum como spam relay vía Resend. | Medium | La route MUST verificar cookie de sesión y rol admin+ con `AUTH_SECRET_KEY` (secreto ya compartido); MUST enviar solo a destinos con invitación recién creada (el flujo pasa por el backend primero). Rate limiting a evaluar en `sdd-design`. |
| **`RESEND_API_KEY` en Vercel**: secreto nuevo solo server-side. Si se expone como `NEXT_PUBLIC_*` o se importa el SDK en un client component, se filtra al bundle. | Medium | Env var server-only en Vercel; SDK de Resend solo en la API route (server). Checklist explícito en `sdd-tasks`. |
| **Deliverability**: sin dominio verificado en Resend (SPF/DKIM), las invitaciones caen en spam o Resend rechaza el envío. Prerequisito externo del usuario. | Medium | Ver Dependencies. Specs/design/tasks avanzan sin esto; `sdd-verify` end-to-end del email requiere el dominio verificado. Mientras tanto, Resend permite enviar al propio email de la cuenta para probar. |
| **Flujo en dos pasos (backend crea, Next envía)**: si el paso 2 falla (Resend caído, key inválida), queda una invitación creada sin email enviado — estado inconsistente de cara al admin. | Medium | La UI muestra el resultado de ambos pasos; "reenviar" es el mecanismo de recuperación (regenera token y reintenta email). La lista de invitaciones muestra si el email falló. Detalle fino en `sdd-design`. |
| **Enforcement de Google en el callback**: el rechazo por falta de invitación ocurre en un redirect flow, no en un fetch — el error debe volver como redirect a `/login?error=...`, no como JSON que el usuario nunca ve. | Low | Patrón ya existente en el callback actual para otros errores; escenario en `sdd-spec`. |
| **Tour acoplado a la UI real**: los selectores/anclas del tour se rompen silenciosamente cuando la UI cambia (el dashboard se rediseñó hace días). | Medium | Anclar por `data-tour-id` propios, no por clases/estructura; test E2E mínimo del wizard en Playwright. |
| Tests existentes de registro abierto rompen por diseño al cerrar `/auth/register`. | High (certeza) | No es un riesgo a evitar sino trabajo a planificar: `sdd-tasks` MUST incluir la actualización de esos tests como tarea de primera clase. |

## Rollback Plan

1. **Código**: revertir los commits del change. El registro vuelve a estar abierto y el flujo Google vuelve a crear cuentas sin invitación — el estado pre-change es el comportamiento actual en producción, conocido y funcional.
2. **Migración 007 — reversibilidad**: `DROP TABLE invitations` (sin FKs entrantes desde otras tablas) y `ALTER TABLE users DROP COLUMN onboarding_completed_at`. Sin condicionales del estilo de la 003: no hay filas de `users` que dependan estructuralmente de `invitations` (los usuarios creados por invitación son usuarios normales; a lo sumo se pierde la trazabilidad de quién los invitó, aceptable en rollback). El archivo SQL MUST documentar ambos pasos, mismo formato que 001–006.
3. **Emails**: desactivar es trivial — quitar `RESEND_API_KEY` de Vercel hace fallar el envío de forma contenida (la route devuelve error, el backend no se entera); no hay estado persistente en Resend que limpiar.
4. **Usuarios ya creados por invitación**: sobreviven al rollback como usuarios normales (login por password o Google intacto). No hay caso análogo al de "usuarios Google-only sin password" de la 003.
5. **Onboarding**: si el wizard resulta problemático, se puede desactivar solo el gate del frontend sin revertir la migración (la columna nullable es inerte).

## Dependencies

- **Cuenta Resend + verificación del dominio `geospectrum.org`** (DNS: SPF/DKIM): prerequisito externo que hace el **usuario** (el DNS ya está bajo su control, dominio comprado y apuntado a Vercel/Railway). Sin esto no hay envío real a terceros; el resto del change no se bloquea.
- **`RESEND_API_KEY`**: secreto a cargar por el usuario en Vercel (server-side only). No puede generarlo `sdd-apply`.
- **Dependencias npm nuevas** en `dashboard/`: `resend`, `react-email`/`@react-email/components`, y la librería de tour que elija `sdd-design`. Ninguna dependencia Python nueva prevista (token con `secrets`/`hashlib` de stdlib).
- Depende de `multi-user-auth` y `google-oauth` ya mergeados y en producción — este change es una extensión de ambos (roles, bootstrap, auto-link, cookie compartida con `AUTH_SECRET_KEY`).

## Success Criteria

- [ ] Un superadmin/admin puede crear una invitación (email + rol), verla listada con su estado, revocarla y reenviarla desde el dashboard; un viewer/moderador no puede (ni por UI ni por API directa).
- [ ] El invitado recibe un email (template react-email, enviado por Resend desde geospectrum.org) con un link que abre la página de aceptación, y puede crear su cuenta con password **o** con Google; el rol resultante es el de la invitación, jamás elegido por el cliente.
- [ ] `POST /auth/register` sin token de invitación válido es rechazado — salvo el caso bootstrap de tabla `users` vacía, que sigue produciendo el primer superadmin sin invitación.
- [ ] Un Google login de un email sin cuenta y sin invitación pendiente es rechazado con mensaje claro en `/login`; todos los usuarios existentes (password y Google, incluido el auto-link) siguen entrando exactamente igual que antes (no regresión, verificado en producción).
- [ ] Un token de invitación es single-use (verificado con intento concurrente contra la base real), expira, y no está almacenado en claro en la base.
- [ ] En el primer login de un usuario nuevo se dispara el wizard de onboarding con tour guiado (mapa, globo, áreas, alertas), se puede completar o saltar, y no vuelve a aparecer en logins siguientes (persistido server-side).
- [ ] La migración 007 es reversible y lo documenta en el propio archivo SQL.
- [ ] La API route de envío de emails rechaza llamadas sin sesión de admin+.
