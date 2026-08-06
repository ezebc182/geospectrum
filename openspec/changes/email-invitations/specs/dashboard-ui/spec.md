# Delta for Dashboard UI — Gestión de invitaciones, aceptación, email y onboarding

## Contexto

Este delta EXTIENDE `openspec/specs/dashboard-ui/spec.md` (spec principal del dashboard, vigente) — no modifica ni remueve ninguno de sus requirements. Agrega cuatro piezas de frontend: (1) la UI de gestión de invitaciones para admin+, (2) la página pública de aceptación de invitación, (3) la API route de Next que renderiza el email con `react-email` y lo envía vía Resend, y (4) el wizard de onboarding con tour guiado para el primer login. La fuente de verdad de las invitaciones es el backend FastAPI (ver `openspec/changes/email-invitations/specs/auth/spec.md`); el dashboard orquesta y presenta.

Convención de este delta: "sesión admin+" significa cookie `session` con JWT HS256 verificable con `AUTH_SECRET_KEY` (el secreto ya compartido entre backend y dashboard, mismo mecanismo que `dashboard/middleware.ts`) cuyo claim `role` es `admin` o `superadmin`.

## ADDED Requirements

### Requirement: Página pública de aceptación de invitación

El dashboard MUST exponer la ruta pública `/invite/[token]` (fuera del grupo autenticado `(app)`, como `/login`), y `dashboard/middleware.ts` MUST incluirla en la allowlist de rutas públicas: un visitante sin sesión MUST poder abrirla sin ser redirigido a `/login`. La página MUST validar el token contra `GET /auth/invitations/validate` y, si es válido, mostrar a qué email y rol corresponde la invitación y ofrecer dos caminos de alta: crear cuenta con password (formulario que llama a `POST /auth/register` con el `invitation_token`) o continuar con Google (`GET /auth/google/login`). El rol NUNCA es elegible en la UI — viene de la invitación, server-side. Si el token no es válido, la página MUST mostrar un mensaje de error claro y MUST NOT renderizar ningún formulario de alta.

#### Scenario: Visitante sin sesión abre un link de invitación válido

- GIVEN una invitación pendiente vigente con token `T` para `email="invitada@example.com"` con `role="moderador"`, y un navegador sin cookie `session`
- WHEN se navega a `/invite/T`
- THEN NO hay redirect a `/login` (la ruta está en la allowlist del middleware)
- AND la página muestra que la invitación es para `invitada@example.com` con rol `moderador`
- AND ofrece crear cuenta con password Y continuar con Google
- AND no existe ningún control para elegir o cambiar el rol

#### Scenario: Aceptación con password crea la cuenta y entra al dashboard

- GIVEN la página `/invite/T` con token válido para `invitada@example.com`
- WHEN el visitante completa el formulario de password y lo envía
- THEN el dashboard llama a `POST /auth/register` incluyendo `invitation_token=T`
- AND ante la respuesta exitosa el usuario queda autenticado (login inmediato o redirect al flujo de login) y aterriza en el dashboard
- AND su primer `GET /auth/me` devuelve el rol de la invitación y `onboarding_completed_at: null`

#### Scenario: Link con token inválido o expirado muestra error sin formulario

- GIVEN un token `X` inexistente, expirado, revocado o ya consumido
- WHEN se navega a `/invite/X`
- THEN la página muestra un mensaje de error claro (invitación no válida o vencida, contactar a quien la envió)
- AND NO se renderiza formulario de password ni botón de Google
- AND la página no distingue cuál de las causas aplica (mismo mensaje para todas)

### Requirement: API route de envío de email de invitación protegida por rol

El dashboard MUST exponer `POST /api/invitations/send` (route handler de Next, server-side) que renderiza el template de invitación con `react-email` y lo envía vía Resend. La route MUST rechazar con 401 toda request sin cookie `session` con JWT válido, y con 403 toda sesión cuyo rol no sea admin+ — la verificación se hace en la route con `AUTH_SECRET_KEY`, antes de tocar Resend. La route MUST usar `RESEND_API_KEY` exclusivamente server-side: la clave MUST NOT exponerse con prefijo `NEXT_PUBLIC_` ni el SDK de Resend importarse en ningún client component. El email enviado MUST contener el link de aceptación (`/invite/{token}` sobre la URL base pública del dashboard) y la información de expiración.

#### Scenario: Sin sesión el envío se rechaza sin tocar Resend

- GIVEN una request `POST /api/invitations/send` sin cookie `session` (o con un JWT de firma inválida)
- WHEN la route la procesa
- THEN la respuesta es 401
- AND no se realiza ninguna llamada a la API de Resend

#### Scenario: Un viewer con sesión válida no puede enviar emails

- GIVEN una cookie `session` válida cuyo claim `role` es `viewer` (o `moderador`)
- WHEN se hace `POST /api/invitations/send` con un payload válido
- THEN la respuesta es 403
- AND no se realiza ninguna llamada a la API de Resend

#### Scenario: Un admin envía la invitación y el email contiene el link correcto

- GIVEN una cookie `session` de un `admin` y una invitación recién creada con token en claro `T`
- WHEN se hace `POST /api/invitations/send` con los datos de la invitación y el link armado
- THEN la route renderiza el template `react-email` de invitación y lo envía vía Resend al email invitado
- AND el cuerpo del email incluye un link a `/invite/T` sobre la URL base pública del dashboard y la fecha/plazo de expiración
- AND la respuesta a la UI indica éxito del envío

#### Scenario: Falla de Resend devuelve error contenido sin romper la invitación

- GIVEN una sesión admin+ y `RESEND_API_KEY` inválida o el servicio de Resend caído
- WHEN se hace `POST /api/invitations/send`
- THEN la route responde un error controlado (no un 500 sin cuerpo) que la UI puede mostrar
- AND la invitación creada en el backend permanece intacta y pendiente — el camino de recuperación es "reenviar" desde la UI de gestión

### Requirement: UI de gestión de invitaciones para admin+

El dashboard MUST ofrecer una sección de gestión de invitaciones visible y accesible ÚNICAMENTE para sesiones admin+ (para `viewer`/`moderador` la sección MUST estar oculta en la navegación Y su ruta MUST responder con denegación, no solo ocultarse). La sección MUST permitir: crear una invitación (email + selector de rol, restringido a los roles que el creador puede otorgar), listar las invitaciones con su estado (`pending`/`accepted`/`revoked`/`expired`), revocar y reenviar. La creación MUST orquestar el flujo en dos pasos — (1) `POST /auth/invitations` al backend, (2) `POST /api/invitations/send` con el link armado — y MUST mostrar el resultado de AMBOS pasos por separado: una invitación creada cuyo email falló debe quedar visible como tal, con "reenviar" como acción de recuperación.

#### Scenario: Un admin crea una invitación y ve el resultado de los dos pasos

- GIVEN una sesión de `admin` en la sección de invitaciones
- WHEN completa email y rol y confirma la creación
- THEN la UI llama primero al backend (`POST /auth/invitations`) y con el token recibido llama a `POST /api/invitations/send`
- AND al terminar muestra que la invitación fue creada Y que el email fue enviado
- AND la invitación aparece en el listado con estado `pending`

#### Scenario: El email falla pero la invitación queda creada y recuperable

- GIVEN una sesión de `admin` y el envío de email fallando (Resend caído)
- WHEN crea una invitación
- THEN la UI muestra que la invitación se creó pero el email NO se envió, con la distinción explícita entre ambos pasos
- AND la invitación aparece en el listado como `pending` con la acción "reenviar" disponible
- AND al usar "reenviar" se regenera el token en el backend y se reintenta el email con el link nuevo

#### Scenario: Revocar y reenviar desde el listado

- GIVEN el listado con una invitación `pending`
- WHEN el admin usa la acción "revocar" sobre una y "reenviar" sobre otra
- THEN la revocada pasa a mostrarse como `revoked` y sus acciones de reenvío desaparecen
- AND la reenviada dispara la regeneración de token y un nuevo email con el link nuevo

#### Scenario: Un viewer no ve ni alcanza la sección

- GIVEN una sesión de `viewer`
- WHEN navega el dashboard y además intenta abrir la URL de la sección de invitaciones directamente
- THEN la sección no aparece en la navegación
- AND el acceso directo por URL es denegado (redirect o pantalla de acceso denegado), sin renderizar datos de invitaciones

### Requirement: Login sin alta abierta y con error claro de invitación

La página `/login` MUST NOT ofrecer ninguna afordancia de creación de cuenta abierta (sin link/formulario de "crear cuenta" que llame a `POST /auth/register` sin invitación). Cuando el backend rechaza un login de Google por falta de invitación (redirect a `/login` con el parámetro de error correspondiente), la página MUST mostrar un mensaje claro y en español indicando que el acceso es solo por invitación.

#### Scenario: Rechazo de Google por falta de invitación se muestra en /login

- GIVEN un usuario sin cuenta y sin invitación que intentó "Continuar con Google"
- WHEN el backend lo redirige a `/login` con el parámetro de error de invitación faltante
- THEN la página muestra un mensaje claro del estilo "esta plataforma es solo por invitación; pedile una invitación a un administrador"
- AND el botón de Google y el formulario de login siguen disponibles para usuarios existentes

#### Scenario: /login no ofrece registro abierto

- GIVEN cualquier visitante en `/login`
- WHEN inspecciona la página
- THEN no existe ningún link ni formulario de "crear cuenta" / "registrarse" sin invitación
- AND el único camino de alta visible en el producto es el link de invitación recibido por email

### Requirement: Wizard de onboarding con tour guiado en el primer login

El dashboard MUST mostrar un wizard de onboarding con tour interactivo guiado cuando el usuario autenticado tiene `onboarding_completed_at: null` en `GET /auth/me`, y MUST NOT mostrarlo cuando ese campo es no nulo. El tour MUST incluir, como mínimo, pasos sobre las cuatro áreas clave: mapa, globo 3D, áreas de interés y alertas, con foco visual sobre elementos reales de la UI (no un carrusel de imágenes estáticas). Los pasos MUST anclarse por atributos propios `data-tour-id`, no por clases CSS ni estructura del DOM. El wizard MUST ser salteable en cualquier paso; tanto completar como saltar MUST persistir vía `POST /auth/me/onboarding-complete`. Si el usuario abandona el tour sin completarlo ni saltarlo (cierra la pestaña, expira la sesión), el wizard MUST volver a ofrecerse en el siguiente login (nada se persistió).

#### Scenario: Primer login dispara el tour

- GIVEN un usuario recién creado por invitación que hace su primer login
- WHEN aterriza en el dashboard y `GET /auth/me` devuelve `onboarding_completed_at: null`
- THEN el wizard de onboarding se muestra automáticamente
- AND el tour recorre al menos: mapa, globo 3D, áreas de interés y alertas, resaltando el elemento real de la UI en cada paso (ancla `data-tour-id`)

#### Scenario: Completar el tour lo apaga para siempre

- GIVEN el wizard visible en el primer login
- WHEN el usuario avanza todos los pasos hasta el final
- THEN el dashboard llama a `POST /auth/me/onboarding-complete`
- AND en el siguiente login, con `onboarding_completed_at` no nulo, el wizard NO se muestra

#### Scenario: Saltar el tour también persiste

- GIVEN el wizard visible en cualquier paso intermedio
- WHEN el usuario elige "saltar"
- THEN el wizard se cierra inmediatamente y se llama a `POST /auth/me/onboarding-complete`
- AND el wizard no vuelve a aparecer en logins siguientes

#### Scenario: Abandono sin completar ni saltar — el tour vuelve a ofrecerse

- GIVEN el wizard visible en un paso intermedio
- WHEN el usuario cierra la pestaña sin completar ni saltar
- THEN no se llamó a `POST /auth/me/onboarding-complete` y `onboarding_completed_at` sigue nulo
- AND en el siguiente login el wizard vuelve a mostrarse desde el inicio

#### Scenario: La falla del endpoint de persistencia no bloquea al usuario

- GIVEN el usuario completando o saltando el wizard con el backend momentáneamente inaccesible
- WHEN `POST /auth/me/onboarding-complete` falla
- THEN el wizard se cierra igual y el usuario puede usar el dashboard con normalidad en esta sesión
- AND (a lo sumo) el wizard vuelve a ofrecerse en el próximo login porque la persistencia no ocurrió — nunca un estado bloqueante
