# Design: Login/registro con Google (OAuth) como alternativa al email/password existente

## Technical Approach

Se agrega un cliente OAuth de **Authlib** (`authlib.integrations.starlette_client.OAuth`), registrado una sola vez a nivel de módulo en `src/main.py` (mismo patrón que `event_bus`/`column_writer` hoy: instancia module-level, conectada/verificada desde `lifespan()`). Authlib delega en Google el `authorize`/`token`/`userinfo` vía OpenID Connect Discovery (`server_metadata_url`), y devuelve el ID token ya parseado y sus claims (incluyendo `email`, `email_verified`, `sub`) — no se implementa el intercambio `code`↔`token` a mano.

La resolución de usuario (nuevo / auto-link / ya vinculado) vive en un método nuevo de `AuthService`, `resolve_or_create_google_user()`, que replica **exactamente** el patrón transaccional que ya usa `AuthService.create_user()` (`src/services/auth_service.py:82-120`): todo el SELECT-por-condición + INSERT/UPDATE corre dentro de un único `conn.transaction()` para que sea atómico bajo concurrencia, y la regla de bootstrap de superadmin (tabla vacía → superadmin) se **reutiliza sin duplicar lógica**, no se reimplementa en un branch paralelo.

El fail-fast de Google OAuth es **condicional, no total** (a diferencia de `AUTH_SECRET_KEY`): si `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` no están configuradas, el servidor arranca igual, el login por password sigue disponible, y los endpoints `/auth/google/*` responden `503` en vez de ejecutar el flujo — ver Decision 1 para el rationale completo.

El frontend no requiere ningún cambio de arquitectura: el botón dispara `window.location.href = '${API_URL}/auth/google/login'` (redirect completo de navegador, confirmado como el patrón correcto para Authorization Code — `dashboard/lib/auth.ts` y `use-auth.tsx` no necesitan tocarse porque `getMe()` ya es agnóstico del método de login, como anticipaba el proposal).

## Architecture Decisions

### Decision 1: Fail-fast condicional (no total) para credenciales de Google OAuth

**Choice**: El `lifespan()` de `main.py` NO aborta el arranque si `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` faltan. En su lugar:
- Si ambas están presentes: se registra el cliente OAuth de Authlib (`oauth.register("google", ...)`) y `app.state.google_oauth_enabled = True`.
- Si falta alguna: se loguea un `warning` (mismo nivel que el trato que hoy recibe Redis/TimescaleDB en `lifespan()`, líneas 109-134 de `main.py`) y `app.state.google_oauth_enabled = False`. El servidor sigue arrancando.
- Los endpoints `GET /auth/google/login` y `GET /auth/google/callback` **se registran siempre** (no se ocultan condicionalmente del router — evita lógica de registro dinámico de rutas, que no tiene precedente en este proyecto) pero ambos verifican `request.app.state.google_oauth_enabled` como primera línea y devuelven `503 Service Unavailable` si es `False`.

**Alternatives considered**:
- (a) Fail-fast total, mismo criterio que `AUTH_SECRET_KEY` (`raise RuntimeError` en `lifespan()` si faltan las credenciales).
- (b) Fail-fast condicional con endpoints que responden 503 (elegido).
- (c) No registrar las rutas `/auth/google/*` en absoluto si faltan las credenciales (import condicional / registro dinámico de rutas).

**Rationale**: La comparación correcta no es "¿es esto tan crítico como `AUTH_SECRET_KEY`?" sino "¿qué se rompe si esto falta?". `AUTH_SECRET_KEY` es la clave de firma de **todo** el sistema de sesiones (ver `settings.py:69-76` y el comentario del propio `lifespan()`, `main.py:136-153`): si falta o es predecible, **cualquier** JWT — password o Google — puede forjarse, incluyendo tokens con `role=superadmin`. Es una vulnerabilidad transversal a todo `AuthService`, no a una vía de login específica. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` en cambio solo habilitan **una vía adicional** de autenticación (confirmado en el proposal, Risk final: "a diferencia de `AUTH_SECRET_KEY`, que es transversal a *todo* el sistema de auth, Google OAuth es una vía adicional, no la única"); si faltan, el login por password (`/auth/login`, `/auth/register`) sigue funcionando exactamente igual, sin ningún grado de degradación de seguridad — no hay forma de "forjar" nada porque el flujo de Google simplemente no se ejecuta.

Se descarta (c) — registro dinámico de rutas — porque el proyecto no tiene precedente de ese patrón (todos los endpoints en `main.py` son decoradores estáticos sobre `app`, incluyendo los que dependen de un `column_writer` que puede ser `None` — ver `/spectrograms/{channel}/history`, que resuelve el caso "no configurado" devolviendo un error controlado en el propio handler, no ocultando la ruta). Se elige (b) porque es consistente con ese patrón ya existente: la ruta siempre existe, el handler decide en runtime si puede atenderla. Esto también hace que `sdd-verify`/tests puedan aserting sobre un 503 determinístico en vez de sobre un 404 que podría confundirse con "endpoint no implementado".

Se descarta (a) — fail-fast total — porque forzaría a **todo** desarrollador local, a cualquier ambiente de staging sin las credenciales de Google Cloud Console todavía provisionadas (ver proposal, Dependencies: son un prerequisito externo manual, no generable por `sdd-apply`), y a cualquier despliegue que deliberadamente no quiera ofrecer login por Google, a no poder levantar el servidor en absoluto — incluso para probar el login por password, que es una feature completamente independiente. Esto viola el criterio de Rollback Plan del proposal ("MUST seguir funcionando exactamente igual si OAuth se deshabilita").

**Nombre de env var de control explícito**: se agrega `GOOGLE_OAUTH_ENABLED` calculado, no configurado — es una `@property` en `Settings` (`google_oauth_configured: bool`, ver Decision 6), no una variable de entorno nueva a setear a mano. Evita que alguien deje `GOOGLE_OAUTH_ENABLED=true` con credenciales vacías y obtenga un estado inconsistente; el único source of truth es "¿están seteados `GOOGLE_CLIENT_ID` y `GOOGLE_CLIENT_SECRET`?".

### Decision 2: Authlib con Starlette `SessionMiddleware` para el `state`/CSRF — y por qué NO colisiona con la cookie `session` del JWT existente

**Choice**: Se usa `authlib.integrations.starlette_client.OAuth`, registrado con `server_metadata_url="https://accounts.google.com/.well-known/openid-configuration"` y `client_kwargs={"scope": "openid email profile"}`. Authlib **genera y valida el `state` automáticamente** (confirmado vía documentación oficial de Authlib para FastAPI/Starlette): `oauth.google.authorize_redirect(request, redirect_uri)` genera un `state` random, lo persiste, y `oauth.google.authorize_access_token(request)` en el callback lo compara contra el `state` recibido en el query string — si no coincide, Authlib levanta `MismatchingStateError` internamente, sin que el código de este proyecto tenga que implementar la comparación a mano.

El mecanismo de persistencia temporal que usa Authlib para el `state` (y el `nonce` de OIDC) es una **cookie de sesión de Starlette** (`starlette.middleware.sessions.SessionMiddleware`, firmada con `itsdangerous`, HMAC — no relacionada con JWT). Esto requiere agregar `SessionMiddleware` al `app` de `main.py`, algo que hoy **no existe** en el proyecto (`main.py` solo tiene `CORSMiddleware`, confirmado leyendo el archivo completo).

**Nombre de cookie — sin colisión**: `SessionMiddleware` de Starlette usa por defecto el nombre de cookie `session`, que **colisiona textualmente** con `SESSION_COOKIE_NAME = "session"` ya definido en `src/api/deps.py:30` para el JWT de `AuthService`. Se evita la colisión seteando explícitamente `session_cookie="oauth_state"` al registrar `SessionMiddleware` — dos cookies HTTP distintas y sin relación (`oauth_state` vive solo durante el flujo, unos segundos; `session` es la sesión de usuario de larga duración). Sin este parámetro explícito, el navegador tendría dos cookies compitiendo por el mismo nombre `session` en el mismo dominio, lo que rompería silenciosamente el login por password (`Set-Cookie: session=<jwt>` de `/auth/login` sería sobreescrita/leída incorrectamente cuando conviven con el mecanismo de Starlette).

**Alternatives considered**:
- (a) `SessionMiddleware` de Starlette con cookie `oauth_state` explícita (elegido).
- (b) Implementar el `state` a mano: generar un valor random (`secrets.token_urlsafe(32)`), guardarlo en una cookie firmada propia (no Starlette `SessionMiddleware`), compararlo manualmente en el callback.
- (c) Guardar el `state` en Redis (`event_bus`/`RedisPubSubBus` ya está conectado) con TTL corto, en vez de una cookie.

**Rationale**: Se prioriza (a) porque es el mecanismo que Authlib espera de forma nativa y documentada — no reimplementar lo que la librería ya resuelve correctamente (generación de valor con suficiente entropía, comparación en constant-time donde aplica, expiración implícita por la corta duración del flujo). (b) es viable pero exige mantener código de seguridad propio (comparación de `state`) para un caso que Authlib ya cubre — mayor superficie de bugs sin beneficio. (c) se descarta porque acopla el flujo de login (que MUST funcionar incluso si Google OAuth está mal configurado — ver Decision 1) a Redis, que el propio proyecto trata como best-effort/opcional en `lifespan()` (`main.py:114-122`): si Redis está caído, el login por Google se rompería por una dependencia que no tiene relación funcional con OAuth. La cookie de `SessionMiddleware` no depende de infraestructura externa.

### Decision 3: `resolve_or_create_google_user()` en `AuthService` — transacción atómica, reutiliza la regla de bootstrap

**Choice**: Nuevo método público en `AuthService`:

```python
async def resolve_or_create_google_user(
    self, google_id: str, email: str
) -> UserPublic:
    """Resuelve un usuario a partir de un login de Google, dentro de UNA
    transacción atómica (mismo patrón que create_user(), líneas 82-120):
      1. SELECT por google_id -> si existe, YA está vinculado: retornar.
      2. Si no existe por google_id, SELECT por email:
         a. Si existe una fila con password_hash IS NOT NULL y google_id
            IS NULL -> auto-link: UPDATE users SET google_id = $1
            WHERE email = $2, retornar esa fila (Risk #1 del proposal,
            RESUELTO: opción auto-link por email, ya con email_verified
            validado por el caller ANTES de invocar este método — ver
            endpoint /auth/google/callback).
         b. Si no existe ninguna fila con ese email -> crear usuario nuevo,
            reutilizando la MISMA regla de bootstrap que create_user():
            COUNT(*) FROM users dentro de la misma transacción decide
            superadmin (tabla vacía) o viewer (no vacía). password_hash
            se inserta NULL.
      Todo el bloque corre en un único conn.transaction() — el COUNT, el
      SELECT por google_id, el SELECT por email y el INSERT/UPDATE final
      ven el mismo snapshot transaccional, evitando el mismo race
      condition de "doble bootstrap de superadmin" que ya documenta
      create_user().
    """
```

Internamente reutiliza el mismo bloque `existing_count = await conn.fetchval("SELECT COUNT(*) FROM users")` + `actual_role = SUPERADMIN if existing_count == 0 else VIEWER` que ya existe en `create_user()` (`auth_service.py:104-105`) — **no se duplica la lógica de bootstrap en un `if/else` paralelo**, se extrae a un método privado `_determine_bootstrap_role(conn) -> UserRole` invocado desde ambos (`create_user()` se refactoriza para llamarlo también, sin cambiar su comportamiento observable — mismo resultado, una sola fuente de verdad).

**Alternatives considered**:
- (a) Un único método `resolve_or_create_google_user()` con toda la lógica (SELECT→SELECT→INSERT/UPDATE) en una transacción, reutilizando la regla de bootstrap vía método privado extraído (elegido).
- (b) Lógica repartida en el endpoint `/auth/google/callback` de `main.py`, con 2-3 llamadas separadas a `AuthService` (`get_user_by_google_id()`, `get_user_by_email()`, `create_user()`/`link_google_account()`), sin transacción explícita que las envuelva.
- (c) Lógica en el endpoint pero envuelta en una transacción manual expuesta por `AuthService` (ej. `async with auth_service.transaction(): ...`).

**Rationale**: Se descarta (b) porque múltiples queries separadas sin una transacción común permiten una ventana de carrera real: dos requests concurrentes de Google callback para el mismo email nuevo podrían ambos ver "no existe todavía" y ambos intentar `INSERT`, dependiendo solo del `UNIQUE` constraint de `email`/`google_id` para no duplicar — igual que documenta el propio `create_user()` existente sobre por qué el `COUNT`+`INSERT` deben ir juntos. Además, poner la orquestación en el endpoint de `main.py` viola el patrón ya establecido en el proyecto: `main.py` es una capa delgada que llama a un método de `AuthService` y traduce excepciones a HTTP (ver `register()`/`login()` actuales, `main.py:489-569`) — nunca orquesta múltiples queries directamente. Se descarta (c) — exponer una transacción genérica desde `AuthService` — porque agrega una superficie de API nueva (gestión de transacciones cruzando la frontera del servicio) sin un segundo caso de uso que la justifique hoy; YAGNI. Se elige (a) porque es la extensión mínima y consistente: mismo nivel de encapsulamiento que `create_user()`, mismo lugar (`AuthService`), mismo mecanismo (`conn.transaction()`), reutilización real (no copy-paste) de la regla de bootstrap.

**Excepciones nuevas** (mismo patrón que `EmailAlreadyRegisteredError`/`InvalidTokenError` ya en `auth_service.py`): no se necesita ninguna excepción nueva — los tres casos (ya vinculado, auto-link, usuario nuevo) son todos "éxito" desde la perspectiva del método; no hay un caso de error de negocio distinto de un fallo de conexión (que ya se propaga como excepción de `asyncpg` sin capturar, igual que hoy).

### Decision 4: Verificación de `email_verified` vive en el endpoint, no en `AuthService`

**Choice**: El endpoint `GET /auth/google/callback` en `main.py` es responsable de extraer `email_verified` del ID token parseado por Authlib (`token["userinfo"]["email_verified"]`) y de rechazar el auto-link/creación con un error explícito si es `False` — **antes** de invocar `resolve_or_create_google_user()`. `AuthService.resolve_or_create_google_user()` recibe únicamente `google_id` y `email` ya validados como parámetros; no conoce el concepto de `email_verified`.

**Alternatives considered**:
- (a) Validación de `email_verified` en el endpoint, antes de llamar a `AuthService` (elegido).
- (b) Pasar `email_verified: bool` como parámetro a `resolve_or_create_google_user()` y que el método decida internamente si aborta.

**Rationale**: `AuthService` es una capa de persistencia/dominio de usuarios — no conoce claims específicos de un proveedor OAuth externo (`email_verified` es un concepto de OpenID Connect/Google, no un concepto genérico de "usuario"). Mezclar esa validación ahí acoplaría `AuthService` a la forma del ID token de Google, dificultando un futuro segundo proveedor OAuth (fuera de scope de este change, pero el proposal lo menciona como posible extensión futura explícitamente excluida). Manteniendo la validación en el endpoint, `AuthService` sigue siendo agnóstico de proveedor — solo sabe "un `google_id` se vincula a un `email`", igual que hoy solo sabe "un `email` se vincula a un `password_hash`".

### Decision 5: `deps.py` no cambia

**Choice**: `get_current_user`, `require_role`, `require_min_role` en `src/api/deps.py` no requieren ninguna modificación.

**Rationale**: Confirmado por lectura completa de `deps.py` — toda la resolución de identidad pasa por `auth_service.decode_access_token(token)` sobre la cookie `SESSION_COOKIE_NAME` ("session"), que es exactamente la misma cookie que `/auth/google/callback` va a emitir vía `AuthService.create_access_token()` (reutilización estricta, confirmada en el proposal como no-negociable). El JWT resultante de un login por Google tiene el mismo shape (`sub`, `email`, `role`, `iat`, `exp`) que uno de login por password — `CurrentUser` no distingue el método de autenticación, ni tiene por qué (no hay ningún requirement en el proposal que pida diferenciar "logueado por Google" vs "logueado por password" en runtime). Esto confirma la hipótesis que el proposal dejaba "a confirmar en sdd-design" en la fila de `deps.py` de Affected Areas.

### Decision 6: Config nueva en `Settings` — `Optional[str]` + property calculada, sin fail-fast en el modelo

**Choice**: Se agregan a `src/config/settings.py`:

```python
# Google OAuth (opcional — ver openspec/changes/google-oauth/design.md
# Decision 1). A diferencia de auth_secret_key, la AUSENCIA de estas tres
# variables NO impide el arranque del servidor: solo deshabilita la vía
# de login por Google (endpoints /auth/google/* responden 503), el login
# por password sigue intacto. google_redirect_uri no se deriva de otra
# config existente (ej. cors_allowed_origins) porque el redirect_uri debe
# coincidir EXACTAMENTE, carácter a carácter, con el valor registrado en
# Google Cloud Console — derivarlo implícitamente de otra variable sería
# frágil ante un mismatch silencioso.
google_client_id: Optional[str] = None
google_client_secret: Optional[str] = None
google_redirect_uri: Optional[str] = None

@property
def google_oauth_configured(self) -> bool:
    """True si hay credenciales suficientes para habilitar /auth/google/*.

    Ver design.md Decision 1 — a diferencia de auth_secret_key (fail-fast
    total), esta es una condición de habilitación parcial, consultada por
    lifespan() y por los propios endpoints /auth/google/* en runtime.
    """
    return bool(self.google_client_id and self.google_client_secret and self.google_redirect_uri)
```

**Alternatives considered**:
- (a) Los 3 campos (`google_client_id`, `google_client_secret`, `google_redirect_uri`) explícitos + property `google_oauth_configured` (elegido).
- (b) Derivar `google_redirect_uri` de `api_host`/`api_port` en runtime (ej. `f"http://{settings.api_host}:{settings.api_port}/auth/google/callback"`).

**Rationale**: Se descarta (b) porque `api_host` en este proyecto es `"0.0.0.0"` por default (`settings.py:40`) — una dirección de bind, no una URL pública alcanzable por el navegador del usuario ni por Google. El `redirect_uri` real depende del dominio público del backend (que puede diferir entre dev/staging/prod, con o sin proxy/HTTPS), información que no existe hoy en `Settings`. Exigirlo explícito es más seguro (falla de forma obvia — `google_oauth_configured=False` — en vez de silenciosamente generar un `redirect_uri` incorrecto que Google rechazaría con un error de "redirect_uri_mismatch" difícil de diagnosticar).

## Sequence Diagram: Flujo completo Authorization Code (login/registro con Google)

```
Usuario          Dashboard              Backend FastAPI                  Authlib          Google
(browser)      (login/page.tsx)        (src/main.py)                  (OAuth client)    (accounts.google.com)
  │                   │                        │                           │                 │
  │ click "Iniciar    │                        │                           │                 │
  │ sesión c/ Google" │                        │                           │                 │
  ├──────────────────>│                        │                           │                 │
  │                   │ window.location.href = │                           │                 │
  │                   │ /auth/google/login      │                          │                 │
  │                   ├───────────────────────>│                           │                 │
  │                   │                        │ if not google_oauth_      │                 │
  │                   │                        │   configured: 503         │                 │
  │                   │                        │ [caso feliz: configurado] │                 │
  │                   │                        │                           │                 │
  │                   │                        │ oauth.google.             │                 │
  │                   │                        │  authorize_redirect(      │                 │
  │                   │                        │   request, redirect_uri) │                  │
  │                   │                        ├──────────────────────────>│                 │
  │                   │                        │                           │ genera state    │
  │                   │                        │                           │ random, lo guarda│
  │                   │                        │                           │ en cookie        │
  │                   │                        │                           │ "oauth_state"    │
  │                   │                        │<──────────────────────────┤ (Starlette       │
  │                   │                        │  302 -> Google authorize  │  SessionMiddleware)
  │                   │  302 redirect          │  URL (?state=...&scope=   │                 │
  │                   │<───────────────────────┤  openid+email+profile)   │                 │
  │  302 redirect     │                        │                           │                 │
  │<──────────────────┤                        │                           │                 │
  │                   │                        │                           │                 │
  │ GET authorize?state=...&client_id=...&redirect_uri=...                 │                 │
  ├─────────────────────────────────────────────────────────────────────────────────────────>│
  │                   │                        │                           │                 │
  │              pantalla de consentimiento de Google (elegir cuenta, aceptar scopes)         │
  │<─────────────────────────────────────────────────────────────────────────────────────────┤
  │                   │                        │                           │                 │
  │ usuario acepta    │                        │                           │                 │
  ├─────────────────────────────────────────────────────────────────────────────────────────>│
  │                   │                        │                           │                 │
  │  302 -> redirect_uri?code=...&state=...    │                           │                 │
  │<─────────────────────────────────────────────────────────────────────────────────────────┤
  │                   │                        │                           │                 │
  │ GET /auth/google/callback?code=...&state=...                          │                 │
  ├────────────────────────────────────────────>│                          │                 │
  │                   │                        │ if not google_oauth_      │                 │
  │                   │                        │   configured: 503         │                 │
  │                   │                        │ [caso feliz: configurado] │                 │
  │                   │                        │                           │                 │
  │                   │                        │ oauth.google.             │                 │
  │                   │                        │  authorize_access_token(  │                 │
  │                   │                        │   request)                │                 │
  │                   │                        ├──────────────────────────>│                 │
  │                   │                        │                           │ 1. lee cookie   │
  │                   │                        │                           │  "oauth_state",  │
  │                   │                        │                           │  compara vs      │
  │                   │                        │                           │  ?state= recibido│
  │                   │                        │                           │  -> MismatchingState│
  │                   │                        │                           │     Error si no  │
  │                   │                        │                           │     coincide (CSRF)│
  │                   │                        │                           │                 │
  │                   │                        │                           │ 2. POST token    │
  │                   │                        │                           │  endpoint (code  │
  │                   │                        │                           │  -> access_token │
  │                   │                        │                           │  + id_token)     │
  │                   │                        │                           ├────────────────>│
  │                   │                        │                           │<────────────────┤
  │                   │                        │                           │ 3. valida firma  │
  │                   │                        │                           │  del id_token    │
  │                   │                        │                           │  (JWKS de Google)│
  │                   │                        │                           │  y parsea claims │
  │                   │                        │<──────────────────────────┤ (sub, email,     │
  │                   │                        │  token dict con           │  email_verified) │
  │                   │                        │  token["userinfo"]        │                 │
  │                   │                        │                           │                 │
  │                   │                        │ if not userinfo[          │                 │
  │                   │                        │   "email_verified"]:      │                 │
  │                   │                        │   -> 401/redirect error   │                 │
  │                   │                        │ [caso feliz: verificado]  │                 │
  │                   │                        │                           │                 │
  │                   │                        │ auth_service.             │                 │
  │                   │                        │  resolve_or_create_       │                 │
  │                   │                        │  google_user(             │                 │
  │                   │                        │   google_id=userinfo[sub],│                 │
  │                   │                        │   email=userinfo[email])  │                 │
  │                   │                        │  ── conn.transaction():   │                 │
  │                   │                        │     SELECT por google_id  │                 │
  │                   │                        │     -> si no, SELECT por  │                 │
  │                   │                        │        email              │                 │
  │                   │                        │     -> auto-link UPDATE   │                 │
  │                   │                        │        o bootstrap+INSERT │                 │
  │                   │                        │  <- UserPublic            │                 │
  │                   │                        │                           │                 │
  │                   │                        │ auth_service.             │                 │
  │                   │                        │  create_access_token(     │                 │
  │                   │                        │   user)  # MISMO método   │                 │
  │                   │                        │   que usa /auth/login     │                 │
  │                   │                        │                           │                 │
  │                   │                        │ Set-Cookie: session=<jwt>;│                 │
  │                   │                        │  HttpOnly; Secure;        │                 │
  │                   │                        │  SameSite=Lax             │                 │
  │                   │                        │                           │                 │
  │                   │  302 -> dashboard       │                          │                 │
  │  (con cookie session ya seteada)            │                          │                 │
  │<────────────────────────────────────────────┤                          │                 │
  │                   │                        │                           │                 │
  │ GET /dashboard (cookie "session" ya presente, misma que emite /auth/login)                │
  ├──────────────────>│                        │                           │                 │
```

## File Changes

| File | Action | Description |
|------|--------|--------------|
| `deploy/sql/migrations/003_add_google_oauth.sql` | Create | Ver SQL completo abajo (Interfaces / Contracts). |
| `src/models/user.py` | Modify | `UserInDB.password_hash: str` → `Optional[str]`. Se agrega `google_id: Optional[str] = None` a `UserInDB` y a `UserPublic`. `verify_password()` (en `AuthService`) gana guard explícito: si `password_hash is None`, retorna `False` sin invocar `_pwd_context.verify` (evita pasarle `None` a passlib, que levantaría excepción no controlada). |
| `src/services/auth_service.py` | Modify | Nuevo método público `resolve_or_create_google_user(google_id: str, email: str) -> UserPublic`. Se extrae `_determine_bootstrap_role(conn) -> UserRole` desde la lógica ya existente en `create_user()` (líneas 104-105) para reutilizarla sin duplicar. `verify_password()` gana el guard de `password_hash is None` (ver fila anterior). |
| `src/api/deps.py` | Unmodified | Confirmado en Decision 5 — ningún cambio necesario. |
| `src/main.py` | Modify | (1) Import y registro module-level de `oauth = OAuth()` + `oauth.register("google", ...)` condicionado a `settings.google_oauth_configured`, ejecutado dentro de `lifespan()` (no fail-fast, ver Decision 1). (2) `app.add_middleware(SessionMiddleware, secret_key=settings.auth_secret_key, session_cookie="oauth_state")` — reutiliza `auth_secret_key` (ya fail-fast garantizado, ver Decision 2) en vez de introducir una key de firma nueva. (3) Nuevos endpoints `GET /auth/google/login`, `GET /auth/google/callback`, agregados en la sección `# Auth (multi-user-auth)` ya existente (líneas 475-590), mismo estilo de docstrings y `requests_total.labels(...)`. |
| `src/config/settings.py` | Modify | Nuevos campos `google_client_id`, `google_client_secret`, `google_redirect_uri` (todos `Optional[str] = None`) + property `google_oauth_configured` (ver Decision 6). |
| `requirements.txt` | Modify | Agrega `Authlib==1.3.2` (última versión estable con soporte OIDC discovery confirmado al momento de este design; `sdd-tasks`/`sdd-apply` deben verificar la versión disponible real al momento de instalar). |
| `dashboard/app/login/page.tsx` | Modify | Botón "Iniciar sesión con Google" — `<a href={`${API_URL}/auth/google/login`}>` o `onClick` con `window.location.href`, NO un `fetch` (confirmado en proposal — redirect completo de navegador es el patrón correcto para Authorization Code con cookies). |
| `dashboard/lib/auth.ts` / `dashboard/hooks/use-auth.tsx` | Unmodified | Confirmado — `getMe()` ya es agnóstico del método de login (Decision 5). |
| `deploy/docker/docker-compose.yml` | Modify | Agrega `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/`GOOGLE_REDIRECT_URI` comentados con placeholder, mismo estilo que `AUTH_SECRET_KEY`. |
| `tests/unit/test_auth_service.py` | Modify | Tests de `resolve_or_create_google_user()`: usuario nuevo (bootstrap superadmin si tabla vacía, viewer si no), auto-link por email existente, usuario ya vinculado (segundo login idempotente), y `verify_password()` con `password_hash=None` retorna `False` sin excepción. |
| `tests/integration/test_auth_api.py` | Modify | Tests de `/auth/google/login` (redirect 302 a Google si configurado, 503 si no) y `/auth/google/callback` (mockeando `oauth.google.authorize_access_token` — nunca llamando a Google real; casos: `email_verified=False` rechazado, `state` inválido manejado por Authlib, éxito emite cookie `session` con JWT válido). |

## Interfaces / Contracts

### Migración `003_add_google_oauth.sql`

```sql
-- Migration 003: agrega soporte de login/registro vía Google OAuth.
--
-- password_hash pasa de NOT NULL a nullable (un usuario que solo se
-- registró vía Google no tiene password) y se agrega google_id (nullable,
-- UNIQUE) para identificar la cuenta de Google vinculada. Ver
-- openspec/changes/google-oauth/design.md (Decision 3, Risk #1 del
-- proposal ya resuelto: auto-link por email verificado).
--
-- Convención de este proyecto (ver 001/002): archivos numerados en
-- deploy/sql/migrations/, aplicados manualmente contra el Postgres del
-- perfil `storage`. No se editan 001/002 (historia ya aplicada).

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id);

-- Rollback:
--
-- DROP INDEX IF EXISTS idx_users_google_id;
-- ALTER TABLE users DROP COLUMN IF EXISTS google_id;
--
-- ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
--
-- ADVERTENCIA: el SET NOT NULL de arriba FALLA si ya existen filas con
-- password_hash IS NULL (usuarios creados solo vía Google, sin password).
-- Antes de revertir, hay que decidir qué hacer con esas filas: (a)
-- eliminarlas (pierden la cuenta), o (b) forzarlas a setear un password
-- (fuera de alcance de este change — no existe endpoint de "setear
-- password" hoy) antes de poder aplicar el rollback completo. No es un
-- rollback libre de pérdida/reasignación de datos, mismo tipo de
-- advertencia condicional que ya documenta 002_add_role_hierarchy.sql.
```

### `Settings` — campos nuevos (`src/config/settings.py`)

```python
google_client_id: Optional[str] = None
google_client_secret: Optional[str] = None
google_redirect_uri: Optional[str] = None

@property
def google_oauth_configured(self) -> bool:
    return bool(self.google_client_id and self.google_client_secret and self.google_redirect_uri)
```

### `AuthService.resolve_or_create_google_user` — firma

```python
async def resolve_or_create_google_user(self, google_id: str, email: str) -> UserPublic:
    """Ver Decision 3 — transacción única: ya vinculado / auto-link / nuevo
    (con bootstrap de superadmin reutilizado de create_user()).
    Precondición: el caller (endpoint) YA validó email_verified=true del
    ID token de Google antes de invocar este método (Decision 4).
    """
```

### `AuthService.verify_password` — guard nuevo

```python
def verify_password(self, password: str, password_hash: Optional[str]) -> bool:
    if password_hash is None:
        return False  # usuario Google-only, no tiene password que verificar
    return _pwd_context.verify(password, password_hash)
```

### Endpoints nuevos (`src/main.py`)

```
GET /auth/google/login
  503 si not settings.google_oauth_configured (o app.state.google_oauth_enabled)
  302 -> Google authorize URL (via oauth.google.authorize_redirect)

GET /auth/google/callback?code=...&state=...
  503 si not app.state.google_oauth_enabled
  400/401 si Authlib levanta MismatchingStateError (state inválido/CSRF)
  401 si userinfo["email_verified"] is not True
  200/302 -> Set-Cookie: session=<jwt>; HttpOnly; Secure; SameSite=Lax
             (mismo formato que /auth/login) + redirect al dashboard
```

### `Settings` / `lifespan()` — registro condicional de Authlib

```python
# main.py, module-level (junto a event_bus/column_writer)
from authlib.integrations.starlette_client import OAuth

oauth = OAuth()

# dentro de lifespan():
if settings.google_oauth_configured:
    oauth.register(
        "google",
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        client_kwargs={"scope": "openid email profile"},
    )
    app.state.google_oauth_enabled = True
    logger.info("Google OAuth habilitado")
else:
    app.state.google_oauth_enabled = False
    logger.warning(
        "GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI no configurados — "
        "/auth/google/* responderá 503, login por password no afectado"
    )
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit | `AuthService.resolve_or_create_google_user()`: usuario nuevo con tabla vacía → superadmin; usuario nuevo con tabla no vacía → viewer; auto-link de email existente con `password_hash` no nulo; segundo login del mismo `google_id` → retorna la misma fila sin duplicar | `pytest` + `testcontainers` (Postgres efímero), mismo harness que `tests/unit/test_auth_service.py` existente |
| Unit | `AuthService.verify_password(password, None)` retorna `False` sin excepción | `pytest` puro |
| Unit | `Settings.google_oauth_configured`: `True` solo si las 3 vars están seteadas, `False` si falta cualquiera | `pytest` puro, mockeando env vars |
| Integration | `GET /auth/google/login` con `google_oauth_configured=False` → `503`; con `True` → `302` a URL de Google con `state` en el query | `TestClient` de FastAPI, mockeando `settings` |
| Integration | `GET /auth/google/callback`: mock de `oauth.google.authorize_access_token` (nunca llamar a Google real) devolviendo `token["userinfo"]` con `email_verified=False` → rechazo explícito (401 o redirect a página de error, a definir en `sdd-tasks`); con `email_verified=True` y email nuevo → 302 + cookie `session` con JWT decodificable; con email ya registrado con password → auto-link, cookie emitida, fila `users` actualizada con `google_id` no nulo | `TestClient` + monkeypatch de Authlib, `testcontainers` Postgres |
| Integration | Regresión: `/auth/register` y `/auth/login` (password) siguen funcionando exactamente igual con la migración 003 aplicada (columnas nuevas no rompen el flujo existente) | Extiende `tests/integration/test_auth_api.py` |
| Manual/E2E | Flujo real contra Google Cloud Console (requiere credenciales reales del usuario — ver proposal Dependencies): click en dashboard → consentimiento real → callback → sesión activa en dashboard | Verificación manual en `sdd-verify`, no automatizable en CI sin credenciales de service account de Google (fuera de alcance) |

## Migration / Rollout

1. **Migración SQL**: se aplica `003_add_google_oauth.sql` manualmente contra el Postgres del perfil `storage`, mismo mecanismo que 001/002 (no hay Alembic ni tool de migraciones). Es aditiva y no bloqueante: `password_hash` nullable no rompe ninguna fila existente (todas ya tienen `password_hash` no nulo), `google_id` nuevo nace `NULL` en todas las filas existentes.
2. **Rollout de código**: sin flag de feature explícito más allá de `google_oauth_configured` (calculado, no una env var a togglear manualmente) — si las credenciales de Google no están provisionadas todavía en un ambiente, el deploy es transparente: los endpoints `/auth/google/*` existen pero responden `503`, cero impacto en el resto del sistema.
3. **Orden de despliegue recomendado**: aplicar la migración 003 ANTES de desplegar el código nuevo (agregar una columna nullable es seguro incluso con el código viejo corriendo — el código viejo simplemente no la usa); desplegar el código nuevo; recién entonces, cuando el usuario complete el prerequisito externo (Google Cloud Console, ver proposal Dependencies), setear `GOOGLE_CLIENT_ID`/`SECRET`/`REDIRECT_URI` y reiniciar el proceso para que `lifespan()` los recoja (no hay hot-reload de config en este proyecto).
4. **Rollback**: revertir el/los commits. Si la migración 003 ya fue aplicada y existen usuarios creados solo vía Google (`password_hash IS NULL`), el rollback de la migración (`SET NOT NULL`) requiere primero resolver esas filas — ver advertencia condicional documentada en el propio archivo SQL arriba. El login por password no se ve afectado en ningún punto de este rollback (Decision 1 y Decision 2 garantizan que la vía Google es aislable sin tocar la vía password).

## Open Questions

Ninguna bloqueante para pasar a `sdd-tasks`. Un punto de bajo riesgo a verificar en `sdd-tasks`/`sdd-apply`:

- [ ] Confirmar la versión exacta de `Authlib` disponible/compatible con el resto de `requirements.txt` (`fastapi`, `starlette`) al momento de instalar — se referencia `1.3.2` como versión estable conocida al momento de este design, pero `sdd-tasks` debe fijar la versión real usada.
- [ ] Definir en `sdd-tasks` el destino exacto del redirect tras un callback exitoso/fallido (¿`dashboard/` a secas, o una ruta con query param de error para que el frontend muestre un mensaje si `email_verified=False`?) — es un detalle de UX, no una decisión de arquitectura, se deja para specs/tasks.
