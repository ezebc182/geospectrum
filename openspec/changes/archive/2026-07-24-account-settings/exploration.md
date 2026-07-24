## Exploration: Menú de configuración de cuenta (perfil opcional, 2FA TOTP, exportar datos, borrar cuenta)

### Current State

El sistema de auth (`multi-user-auth` + `google-oauth`, ambos archivados) ya cubre:

- **Tabla `users`** (Postgres/TimescaleDB, perfil `storage`, puerto host 5433, DB `seismic`), construida en 4 migraciones aplicadas manualmente (no hay Alembic ni migrador automático — convención confirmada: archivos `NNN_description.sql` en `deploy/sql/migrations/`, nunca se editan migraciones ya aplicadas):
  - `001_create_users_table.sql`: `id UUID PK`, `email TEXT UNIQUE NOT NULL`, `password_hash TEXT NOT NULL`, `role TEXT CHECK(...)`, `created_at`, `updated_at`.
  - `002_add_role_hierarchy.sql`: amplía el CHECK de `role` a `superadmin/admin/moderador/viewer` (jerarquía estricta descendente, `ROLE_LEVEL` en `src/models/user.py`).
  - `003_add_google_oauth.sql`: `password_hash` pasa a nullable + `google_id TEXT UNIQUE` nullable (usuario 100% Google no tiene password).
  - `004_add_google_profile_fields.sql`: `name TEXT` y `avatar_url TEXT`, nullable, poblados SOLO desde claims OIDC de Google (`name`/`picture`); un usuario de password puro los tiene en `NULL` a propósito.
  - **No hay ninguna foreign key de otra tabla apuntando a `users`** (`grep -rn "REFERENCES users"` sobre `deploy/sql/migrations/` no devolvió resultados) — un borrado de cuenta no tiene cascada que resolver a nivel de esquema hoy.

- **`src/services/auth_service.py`** (`AuthService`): SQL parametrizado puro vía `asyncpg` (sin ORM), pool propio (`connect()`/`close()` idempotentes), transacciones explícitas con `conn.transaction()`. Métodos: `hash_password`/`verify_password` (bcrypt vía passlib, con guard explícito para `password_hash=None`), `create_user()`, `get_user_by_email()`, `resolve_or_create_google_user()` (maneja auto-link por email verificado), `create_access_token()`/`decode_access_token()` (JWT HS256 vía python-jose, claims incluyen `name`/`avatar_url` para evitar round-trip extra).

- **`src/models/user.py`**: `UserRole` (enum jerárquico `str, Enum`, NO `IntEnum` — el valor ya es contrato de API/JWT/DB), `ROLE_LEVEL`/`role_level()`, `UserCreate`, `UserPublic` (sin hash), `UserInDB` (con hash), `CurrentUser` (resuelto del JWT).

- **`src/api/deps.py`**: `get_current_user` (cookie `session`, JWT HS256), `require_role()` (igualdad exacta), `require_min_role()` (jerárquico). Resolución de `AuthService` vía `request.app.state.auth_service` (seteado en `lifespan()` de `main.py`). Son `Depends()` reusables, NO middleware global — protección endpoint por endpoint.

- **`src/main.py`**: endpoints `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `GET /auth/google/login`, `GET /auth/google/callback`. `SessionMiddleware` de Starlette registrado con `session_cookie="oauth_state"` explícito (evita colisión textual con `SESSION_COOKIE_NAME = "session"` del JWT — son dos cookies HTTP completamente distintas, `oauth_state` es transitoria del handshake OAuth).

- **Patrón de config sensible, confirmado en `src/main.py` líneas 148-204 de `lifespan()`** — dos modelos ya establecidos y documentados en comentarios extensos:
  1. **Fail-fast TOTAL** (`AUTH_SECRET_KEY`, líneas 159-164): si falta, `raise RuntimeError(...)` dentro de `lifespan()`, el proceso NO arranca. Justificación explícita: una clave de firma ausente/predecible permite forjar tokens válidos (incluso de rol admin) — vulnerabilidad crítica, no degradación aceptable.
  2. **Condicional/opcional** (`GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI`, líneas 188-204): si faltan, el servidor arranca igual; solo `/auth/google/*` responde 503 (`app.state.google_oauth_enabled = False`), login por password sigue intacto.
  - No existe un tercer patrón (ej. "advertencia silenciosa sin deshabilitar nada") para secrets de auth — cualquier secret nuevo debe encajar en uno de estos dos, con justificación explícita si se elige uno u otro.

- **Frontend**: `dashboard/hooks/use-auth.tsx` (`AuthProvider`/`useAuth()`, hidrata `getMe()` una vez al montar, expone `user`/`loading`/`login`/`logout`), `dashboard/lib/auth.ts` (`login`/`logout`/`getMe`, todas con `credentials: 'include'` porque la cookie `session` es cross-origin dashboard:3008 ↔ API:8000), `dashboard/lib/types.ts` (`UserPublic` interface espejo exacto del backend, `ROLE_LEVEL` duplicado para UI condicional), `dashboard/components/UserMenu.tsx` (dropdown en header: avatar con fallback de iniciales, nombre/email, rol, toggle de tema, logout — recién creado, patrón de referencia para cualquier UI nueva de cuenta). shadcn/ui ya usado extensamente (`dashboard/components/ui/`, incluye `dropdown-menu`).

- **Confirmado: no existe ningún sistema de 2FA** (`grep -rniE "pyotp|totp|2fa|two.?factor"` sobre `src/`, `dashboard/`, `requirements.txt` → sin resultados) **ni ninguna librería en `requirements.txt`** (`pyotp` no está instalado; sí están `passlib[bcrypt]`, `python-jose[cryptography]`, `Authlib`, `itsdangerous` para lo ya existente).

- **Confirmado: no existe ningún servicio de envío de emails** (`grep -rniE "smtp|sendgrid|resend|nodemailer|email.?service|ses\b|mailgun"` sobre todo el árbol relevante → sin resultados, salvo el paquete `email-validator` que es solo validación de formato de Pydantic `EmailStr`, no envío). Esto es una restricción real de este change, no un detalle menor.

### Affected Areas

- `deploy/sql/migrations/005_*.sql` (nueva) — columnas de perfil (domicilio/teléfono si se decide guardarlos normalizados) + columnas de 2FA (`totp_secret`, `totp_enabled`, `backup_codes_hash` o tabla separada) + soft-delete si se elige esa vía (`deleted_at`).
- `src/models/user.py` — extender `UserInDB`/`UserPublic`/`CurrentUser` con los nuevos campos opcionales; posible modelo nuevo `UserProfileUpdate` (todos los campos `Optional`, sin bootstrap-role ni nada crítico de seguridad involucrado, a diferencia de `UserCreate`).
- `src/services/auth_service.py` — nuevos métodos: `update_profile()`, `enable_totp()`/`verify_totp()`/`disable_totp()`, `generate_backup_codes()`/`consume_backup_code()`, `export_user_data()`, `delete_account()`. Mismo patrón: SQL parametrizado, transacciones explícitas donde haya invariantes multi-paso (ej. generar backup codes y marcar `totp_enabled=true` debe ser atómico).
- `src/api/deps.py` — sin cambios obligatorios de contrato (los nuevos endpoints reutilizan `get_current_user`), pero si 2FA se vuelve un segundo factor de sesión (no solo de setup), podría necesitar un nuevo `Depends` intermedio (ej. sesión "pendiente de 2FA" vs sesión completa) — pregunta de diseño abierta, no resuelta acá.
- `src/main.py` — nuevos endpoints bajo probablemente `/account/*` (perfil, export, delete) y `/auth/2fa/*` (setup/verify/disable, en línea con el prefijo `/auth/*` ya usado para todo lo de autenticación). Requiere registrar `requirements.txt` (agregar `pyotp` o equivalente) y decidir si el secret de firma de backup codes reutiliza `AUTH_SECRET_KEY` o introduce uno nuevo.
- `requirements.txt` — agregar librería TOTP (ninguna presente hoy).
- `dashboard/lib/types.ts` — extender `UserPublic` (o crear un tipo separado `UserProfile` si se decide no mezclar el shape "identidad ligera para JWT/header" con "perfil completo de settings", dado que hoy `UserPublic` ya viaja en el JWT y se mantiene deliberadamente liviano).
- `dashboard/lib/auth.ts` — nuevas funciones cliente (`updateProfile`, `setupTotp`, `verifyTotp`, `exportData`, `deleteAccount`), todas con el mismo patrón `credentials: 'include'`.
- `dashboard/hooks/use-auth.tsx` — posible extensión si `deleteAccount()` debe limpiar el estado `user` local igual que `logout()`.
- Nueva ruta de frontend (ej. `dashboard/app/settings/` o similar) + componentes shadcn/ui nuevos (formularios, diálogo de confirmación destructivo para borrado, imagen QR para TOTP).
- `openspec/specs/` — no hay un dominio `account-settings` o `auth` en `openspec/specs/` todavía visible en este exploration (no se leyó ese directorio en detalle porque el proposal/specs es la fase siguiente, no esta) — a confirmar en `/sdd-spec`.

### Approaches

**1. 2FA — con librería (`pyotp`) vs implementación manual de TOTP (RFC 6238)**

1. **`pyotp`** — librería madura, implementa RFC 6238 (TOTP) y RFC 4226 (HOTP) directamente, genera el URI `otpauth://` para el QR sin reinventar el cálculo de HMAC-SHA1/ventanas de tiempo.
   - Pros: código mínimo, batalla-probado, maneja "ventanas de tolerancia" (clock drift) correctamente, se integra con cualquier libería de generación de QR (ej. `qrcode` + Pillow, que YA está instalado como dependencia de `obspy`/procesamiento sísmico — a confirmar si es reutilizable o si hace falta agregar `qrcode` explícito).
   - Cons: una dependencia nueva más en `requirements.txt` (ya extenso).
   - Effort: Low.
2. **Implementación manual de TOTP** — usar `hmac`/`hashlib` de la stdlib para replicar RFC 6238 a mano.
   - Pros: cero dependencias nuevas.
   - Cons: reinventar criptografía de seguridad es exactamente el tipo de atajo que este proyecto ya rechazó implícitamente (ver el comentario extenso sobre por qué SQL parametrizado y nunca f-strings, por qué bcrypt vía passlib y no un hash casero) — alto riesgo de bugs sutiles (off-by-one en ventanas de tiempo, comparación no constante-time de códigos) que en 2FA es directamente una vulnerabilidad de bypass.
   - Effort: Medium-High (y con riesgo de seguridad que no se justifica solo para ahorrar una dependencia).

   **Recomendación de esta pieza: `pyotp`.** Es exactamente el mismo criterio ya aplicado a bcrypt/JWT en este proyecto: no reinventar primitivas de seguridad.

**2. Borrado de cuenta — hard-delete vs soft-delete**

1. **Hard-delete** (`DELETE FROM users WHERE id = $1`) — elimina la fila físicamente.
   - Pros: simple, coherente con "el usuario puede eliminar sus datos" (alineado con el espíritu de exportar+borrar tipo GDPR), no dejar rastro de PII después del borrado.
   - Cons: sin soft-delete, un `email` liberado puede ser re-registrado por otra persona inmediatamente (¿es deseable o un riesgo?, especialmente si hay auditoría externa que referencia ese `id` por texto en logs/alertas ya emitidas). También irreversible ante errores de UI o clicks accidentales sin ventana de gracia.
   - Effort: Low (no requiere migración de esquema más allá de quizás un log de auditoría separado).
2. **Soft-delete** (`deleted_at TIMESTAMPTZ`, filtrar en `get_user_by_email`/login) — no borra la fila, la marca.
   - Pros: reversible dentro de una ventana, más fácil de auditar, evita el problema de reuso inmediato de email.
   - Cons: contradice parcialmente el pedido explícito de "el usuario puede eliminar su cuenta" si el dato de PII (nombre, domicilio, teléfono) sigue en la base — para cumplir intención real de "borrado" habría que anonymizar esos campos igual (poner NULL) aunque se conserve la fila con `deleted_at`, lo que es más complejo que un DELETE simple. También hay que tocar TODOS los queries que hacen `SELECT ... FROM users` (`get_user_by_email`, `resolve_or_create_google_user`, login) para excluir soft-deleted, con riesgo de un query olvidado que permita loguearse con una cuenta "borrada".
   - Effort: Medium (más superficie de cambio, más riesgo de un olvido en algún SELECT existente).

   **Recomendación de esta pieza: hard-delete + anonymización de logs si aplica**, dado que no hay ninguna FK dependiente (confirmado por el grep) y el pedido explícito del usuario es "eliminar cuenta", no "desactivar cuenta". Si en el proposal se decide preservar auditoría, evaluar una tabla de auditoría separada (solo metadata: "user X eliminado en fecha Y") en vez de soft-delete de la fila completa — pregunta a resolver en `/sdd-propose` o `/sdd-design`, no acá.

**3. Exportación de datos — síncrona (JSON inmediato en el response) vs asíncrona (job + descarga posterior)**

1. **Síncrona** — endpoint `GET /account/export` arma el JSON en el mismo request/response (todo lo que hoy vive en `users` es una sola fila, sin joins costosos, sin otras tablas de dominio del usuario que exportar hoy).
   - Pros: trivial de implementar, no requiere infraestructura de jobs/colas (que este proyecto no tiene — no hay worker de tareas asíncronas de larga duración fuera de los workers de scraping/SeedLink, que son de otro dominio), no requiere notificación por email (que TAMPOCO existe) para avisar "tu export está listo".
   - Cons: si en el futuro el perfil de usuario crece a incluir datos de otras tablas (ej. historial de alertas configuradas, regiones favoritas), un export síncrono podría volverse lento — pero eso es especulativo, no aplica al alcance actual.
   - Effort: Low.
2. **Asíncrona** (job + storage + link de descarga, típicamente con notificación por email cuando está listo).
   - Pros: escala mejor a futuro, patrón más "enterprise-grade" de exportación de datos (GDPR-style).
   - Cons: requiere infraestructura que HOY no existe (cola de jobs, storage de archivos temporales, Y CRÍTICAMENTE un sistema de email para avisar — que no existe en este proyecto). Introducir las 3 piezas solo para exportar una fila de `users` es sobre-ingeniería clara para el alcance pedido.
   - Effort: High (y desproporcionado al problema real).

   **Recomendación de esta pieza: síncrona, JSON directo en el response.** El volumen de datos por usuario hoy es una fila de `users` — no hay justificación para async.

### Recommendation

Alcance técnicamente viable en un solo change (`account-settings`), pero con 4 sub-features de complejidad y riesgo bien distintos que conviene tratar como specs/tareas separadas dentro del MISMO change (no cambios separados, tal como pidió el usuario):

1. Perfil opcional (domicilio/teléfono/nombre) — la pieza más simple, extiende el patrón ya usado (`UserProfileUpdate` con todos los campos `Optional`, sin tocar `role`/bootstrap).
2. 2FA TOTP + backup codes — usar `pyotp`, seguir el patrón fail-fast/opcional YA establecido para decidir si un usuario con `password_hash IS NULL` puede o no habilitar TOTP propio (pregunta abierta, ver Risks).
3. Exportar datos — síncrono, JSON, sin infraestructura nueva.
4. Borrar cuenta — hard-delete (sin FKs que resolver), con manejo explícito del caso "último superadmin" (mismo patrón de `_determine_bootstrap_role` ya usado para evitar race conditions, pero para el caso inverso: evitar dejar el sistema sin ningún superadmin).

### Risks

- **2FA sobre cuenta 100% Google (`password_hash IS NULL`)**: pregunta de diseño real, no resuelta acá. Dos posturas razonables: (a) permitir TOTP igual, como capa adicional independiente del mecanismo de login primario — más flexible, pero duplica "quién puede desloguearte" (Google + TOTP local); (b) restringir 2FA propio solo a usuararios con password, delegando la seguridad de cuentas 100% Google a la propia seguridad de Google (que YA tiene su 2FA nativo) — más simple y evita la pregunta "¿qué pasa si el usuario pierde el TOTP Y el acceso a Google simultáneamente?". Debe resolverse en el proposal, con la decisión documentada como Decision explícita (mismo estilo que design.md de los changes anteriores).
- **Entrega de backup codes sin sistema de email**: hoy no hay forma de enviar los backup codes por email como respaldo fuera de banda. La única vía disponible es mostrarlos UNA VEZ en el response del endpoint de setup (patrón estándar de la industria: "guardalos ahora, no se muestran de nuevo") — hay que documentar esto explícitamente como decisión de diseño, no como omisión.
- **Alertas de seguridad sin email** (ej. "se deshabilitó 2FA en tu cuenta", "tu cuenta fue eliminada"): sin sistema de notificaciones, estas alertas simplemente no existen en esta iteración. Riesgo aceptado explícito a documentar en el proposal, no a resolver silenciosamente.
- **Último superadmin borra su propia cuenta**: mismo tipo de edge case que `multi-user-auth` ya resolvió para el bootstrap (ver `_determine_bootstrap_role`, transacción atómica sobre `COUNT(*)`). Acá el caso es inverso: antes de un hard-delete, `delete_account()` debería verificar (dentro de la misma transacción) si el usuario es `superadmin` Y es el único con `COUNT(*) WHERE role='superadmin') = 1` — y si es así, rechazar el borrado (o exigir transferencia de rol primero). Sin este chequeo, el sistema queda sin ningún usuario capaz de gestionar roles, un estado irrecuperable sin acceso directo a la base.
- **Secret de firma para backup codes**: si se decide hashear/firmar backup codes con un secret dedicado (en vez de solo hashear con bcrypt como un password), hay que decidir explícitamente si ese secret es fail-fast total (como `AUTH_SECRET_KEY`) o reutiliza el mismo `AUTH_SECRET_KEY` ya fail-fast garantizado — introducir un tercer patrón de config sin justificación repetiría el mismo error que este proyecto ya evitó conscientemente en `google-oauth`.
- **Mezcla de shape `UserPublic` (liviano, va en el JWT) con "perfil completo de settings"**: si domicilio/teléfono se agregan directamente a `UserPublic`, ese shape empieza a viajar en cada respuesta de `/auth/me` y potencialmente en el JWT (`create_access_token` ya incluye `name`/`avatar_url` en claims) — inflar el JWT con domicilio/teléfono es un antipatrón (tamaño de cookie, exposición innecesaria de PII en un JWT no cifrado, solo firmado). Recomendación a validar en proposal/design: separar un `UserProfile` (fetch bajo demanda en la pantalla de settings) del `UserPublic`/`CurrentUser` que ya viaja en el JWT.
- **Ninguna FK hacia `users` hoy** (confirmado): esto es una buena noticia para el borrado (sin cascada que resolver), pero también significa que si a futuro se agregan tablas de dominio de usuario (preferencias, alertas configuradas, etc.) ANTES de que este change se implemente, el diseño de `delete_account()` tendría que revisarse — no es un riesgo de este change puntual, pero vale la pena que quede memoria de por qué hoy es simple.

### Ready for Proposal

**Sí**, con las siguientes preguntas abiertas que el proposal debe resolver explícitamente (no dejarlas implícitas):
1. ¿TOTP aplica a usuarios 100% Google (`password_hash IS NULL`) o solo a usuarios con password?
2. ¿Cómo se comunican los backup codes al usuario (solo mostrar una vez en UI, sin persistencia en claro) y qué pasa si los pierde sin acceso a su método de login primario?
3. ¿El endpoint de borrado de cuenta valida "no sos el último superadmin" antes de proceder, y qué responde si lo es (403 con mensaje explícito, o exige transferir el rol primero)?
4. ¿El perfil extendido (domicilio, teléfono, nombre editable) vive en `UserPublic`/JWT o en un tipo separado `UserProfile` fetched aparte, para no inflar el JWT con PII?
5. ¿Dónde vive el secret usado para firmar/hashear backup codes — reutiliza `AUTH_SECRET_KEY` (fail-fast ya garantizado) o introduce uno nuevo, y con qué justificación?

Recomendación al orquestador: proceder a `/sdd-propose` (o `/sdd-ff` si el usuario quiere avanzar todo de una), asegurándose de que el proposal capture estas 5 preguntas como decisiones explícitas — no delegarlas silenciosamente a la fase de design.
