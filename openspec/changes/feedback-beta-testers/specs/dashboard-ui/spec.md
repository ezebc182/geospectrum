# Delta for Dashboard UI — Widget de feedback y tablero Kanban

> **Versión 2026-09-03.** Reemplaza íntegramente la delta del 2026-09-01 (vista
> admin `/admin/feedback` con filtros y "marcar resuelto", entrada en
> `adminRoutes`). Ese alcance quedó retirado por el proposal enmendado el
> 2026-09-03: el tablero es de TODOS los usuarios autenticados y lo que cambia
> por rol es la interactividad, no la visibilidad.

Delta sobre `openspec/specs/dashboard-ui/spec.md`. Ese documento cubre el
rediseño visual del Dashboard, el mapa y el detalle de estación; no toca ningún
mecanismo de feedback (verificado con `rg` el 2026-09-03), por lo que todo lo
de acá es **ADDED**. El comportamiento de los endpoints que este UI consume
está especificado en el spec del dominio `feedback` de este mismo change
(`specs/feedback/spec.md`) — incluidos los identificadores de estado de la API
(`new`, `in_analysis`, `in_progress`, `done`, `discarded`) y el payload del
tablero; acá se especifica solo la superficie de UI.

Nota de verificación: los escenarios de posicionamiento visual ("no tapa
controles") y la distinción visual `Descartado`/`Hecho` se verifican con QA
visual del usuario — convención ya establecida en el repo (canvas + MCP rotos
para screenshots automatizados). El resto de los escenarios son
automatizables con Vitest/Testing Library.

## Decisiones tomadas en esta spec (el proposal las dejó abiertas)

| Tema | Decisión | Por qué |
|------|----------|---------|
| **Una página o dos** | **Una sola** página `/feedback` (`dashboard/app/(app)/feedback/page.tsx`) para todos los roles, con un componente Kanban que recibe `canManage`; NO existe `/admin/feedback` | Una sola fuente de verdad visual: admin y testers miran exactamente el mismo tablero, así lo que el admin ve es lo que el tester ve. Es la opción que el propio proposal recomienda; duplicar la página duplica strings, tests y estados |
| **Etiquetas de estado** | Las etiquetas visibles son claves i18n (`es`: Nuevo, En análisis, En progreso, Hecho, Descartado; `en`: New, In analysis, In progress, Done, Discarded). El valor del enum de la API MUST NOT mostrarse crudo al usuario | Separación API/UI; la paridad es/en ya tiene test |
| **Orden dentro de una columna** | Por `created_at` descendente (lo más nuevo arriba), fijo, sin reordenamiento manual | El proposal excluye el orden manual; mismo orden que devuelve la API, sin lógica extra |
| **Drop en la misma columna** | No emite ninguna petición al backend (no-op local) | Aunque el backend lo aceptaría como 200 idempotente, no hay motivo para gastar un round-trip |
| **Aviso de transparencia** | El dialog del widget MUST decir, antes de enviar, que el reporte será visible para los demás testers (con el email del autor) | Mitigación explícita del riesgo "expone email y texto a todos" del proposal; el tester debe saberlo ANTES de enviar |
| **Contenido del menú "Mover a…"** (reconciliado 2026-09-03 con el design, que decía "los otros cuatro") | El menú lista los **cinco** estados con sus etiquetas i18n; el estado ACTUAL de la tarjeta aparece marcado y deshabilitado (`aria-disabled`), así que elegirlo es imposible y no emite petición | Mostrar los cinco da contexto de dónde está la tarjeta y mantiene `Descartado` siempre visible y distinguible de `Hecho`; deshabilitar el actual respeta "drop en la misma columna no emite petición" |

> **Reconciliación specs ↔ design (2026-09-03)**: los shapes que este UI consume
> son los del design — `PUT /feedback/{id}/status` `{"status"}`,
> `PUT /feedback/{id}/comment` `{"comment": texto | null}`, `GET /feedback` ⇒
> `{"reports": [...]}`, ack del `POST` `{id, created_at}` — y el item del
> tablero trae `admin_comment_updated_at` (nullable) y `status_changed_at`
> **nullable** (`null` hasta el primer movimiento: el detalle lo muestra solo
> cuando existe).

## ADDED Requirements

### Requirement: Widget flotante global de feedback

El dashboard autenticado MUST montar un widget de feedback en el layout del
grupo `(app)` (`dashboard/app/(app)/layout.tsx`, junto a `OnboardingGate` y
`NotificationBell`): un botón flotante visible en TODAS las vistas del grupo
`(app)`, sin integración página por página. El flujo completo (abrir → elegir
tipo falla/sugerencia → escribir → enviar → confirmación) MUST resolverse en
un dialog sobre la página actual, sin navegar: el tester MUST permanecer en la
vista en la que estaba, con su estado intacto, después de enviar.

El dialog MUST mostrar, visible antes de enviar, que el reporte será visible
para los demás beta testers junto con el email de quien lo envía (decidido en
spec; ver tabla).

#### Scenario: El botón está presente en cualquier vista del grupo (app)

- GIVEN una sesión válida de un beta tester
- WHEN navega a distintas vistas del dashboard autenticado (por ejemplo
  `/live`, una vista de wall, una vista de análisis y el propio `/feedback`)
- THEN el botón flotante de feedback está presente y operable en todas ellas
- AND no hace falta que ninguna página lo monte individualmente (viene del
  layout)

#### Scenario: Enviar no saca al tester de la página

- GIVEN un tester mirando una vista de análisis con una ventana temporal
  seleccionada
- WHEN abre el widget, escribe un reporte y lo envía con éxito
- THEN el dialog muestra la confirmación y se cierra
- AND el tester sigue en la misma URL, con la vista y su estado sin recargar

#### Scenario: El widget avisa que el reporte será visible para los demás

- GIVEN el dialog del widget abierto
- WHEN el tester mira el formulario antes de enviar
- THEN hay un texto visible que indica que el reporte, con su email, será
  visible para los demás testers en el tablero

### Requirement: El widget no tapa controles críticos

El botón flotante MUST posicionarse fijo en una esquina, con `z-index`
coordinado con los overlays existentes, de modo de no obstruir controles
operables de las vistas densas (walls, globe, live, mapas). El dialog abierto
MAY cubrir contenido (es modal por diseño), pero el botón en reposo MUST NOT
dejar ningún control existente inoperable.

#### Scenario: Controles de vistas densas siguen operables (QA visual del usuario)

- GIVEN las vistas densas del dashboard (walls, globe, live) en desktop
- WHEN el usuario recorre cada una con el widget montado y en reposo
- THEN todos los controles preexistentes de cada vista siguen visibles y
  clickeables
- AND el botón flotante permanece visible sin superponerse a ningún control
  interactivo
- AND esta verificación queda registrada como **QA visual manual del
  usuario** (criterio de éxito explícito del proposal; no se automatiza)

### Requirement: Captura automática de contexto en el cliente

Al enviar, el widget MUST adjuntar automáticamente al body del `POST /feedback`
la ruta actual (`usePathname()`), la URL completa (`window.location.href` —
que en las vistas de análisis ya codifica canal y ventana en sus query
params) y el `navigator.userAgent`, sin que el tester teclee ni vea campos
para nada de eso. Antes de enviar, el widget MUST truncar los tres campos de
contexto a los límites del backend — `route` a 300 caracteres, `url` a 2000 y
`user_agent` a 400 —: el contexto es metadata defensiva, no contenido del
tester, y es preferible un user agent truncado a un 422 que se come el
reporte (el backend igual rechaza con 422 lo que exceda esos límites —
defensa en profundidad, spec del dominio `feedback`). El `body` MUST NOT
truncarse jamás en silencio: su tope de 2000 caracteres se aplica visible en
la entrada (requirement "Validación en el widget antes de enviar"). El widget
MUST NOT enviar timestamp de creación (lo pone el servidor de base). La UI del
widget MUST informar de forma visible que el contexto de la página actual se
adjunta automáticamente, para que el tester sepa qué viaja con su reporte
(honestidad sobre lo capturado: URL + ruta + user agent, no estado interno de
la app).

#### Scenario: La URL con query params viaja completa

- GIVEN un tester en una vista de análisis cuya URL codifica canal y ventana
  (por ejemplo `?channel=AK.FIRE..BHZ&start=...&end=...`)
- WHEN envía un reporte desde el widget
- THEN el body del `POST /feedback` incluye `route` con el pathname actual y
  `url` con la URL completa incluyendo esos query params
- AND incluye `user_agent` con el valor de `navigator.userAgent`
- AND el tester no tecleó ninguno de esos tres valores

#### Scenario: Un contexto que excede los límites viaja truncado, no revienta

- GIVEN un tester en una vista cuya URL supera los 2000 caracteres (o cuyo
  `navigator.userAgent` supera los 400)
- WHEN envía un reporte desde el widget
- THEN el body del `POST /feedback` lleva `url` truncada a exactamente 2000
  caracteres, `route` a lo sumo de 300 y `user_agent` a lo sumo de 400
- AND el envío responde 201 (el contexto truncado nunca provoca un 422 que
  pierda el reporte)
- AND el `body` del tester viaja completo, sin truncar

#### Scenario: El widget avisa qué contexto adjunta

- GIVEN el dialog del widget abierto
- WHEN el tester mira el formulario antes de enviar
- THEN hay un texto visible indicando que el contexto de la página actual
  (URL/ruta y navegador) se adjunta automáticamente al reporte

### Requirement: Estados honestos del envío

El widget MUST reflejar honestamente los tres estados del envío:

- **Enviando**: mientras el `POST /feedback` está en vuelo, el control de
  envío MUST deshabilitarse (imposibilitando el doble envío del mismo texto)
  y la UI MUST indicar que el envío está en curso.
- **Éxito**: ante 201, el widget MUST mostrar una confirmación visible y
  limpiar el formulario (el próximo reporte arranca vacío).
- **Error**: ante fallo de red o respuesta no exitosa, el widget MUST mostrar
  un mensaje de error visible, MUST conservar el texto escrito (el reporte
  del tester no se pierde) y MUST permitir reintentar. El widget MUST NOT
  mostrar confirmación de éxito si el servidor no confirmó la creación.

#### Scenario: Doble click no duplica el reporte

- GIVEN un tester con un reporte escrito y un backend que tarda en responder
- WHEN hace click en enviar y vuelve a hacer click mientras el request sigue
  en vuelo
- THEN se emite un único `POST /feedback`
- AND el control de envío está deshabilitado durante el vuelo con indicación
  visible de envío en curso

#### Scenario: El error conserva el texto y permite reintentar

- GIVEN un tester con un reporte escrito y el backend caído (el `POST`
  falla)
- WHEN envía el reporte
- THEN aparece un mensaje de error visible y ninguna confirmación de éxito
- AND el texto escrito sigue intacto en el formulario
- AND un reintento posterior con el backend recuperado responde 201 y recién
  entonces se muestra la confirmación

#### Scenario: El éxito confirma y limpia

- GIVEN un envío que el backend responde con 201
- WHEN el widget recibe la respuesta
- THEN muestra la confirmación de envío
- AND al volver a abrir el widget el formulario está vacío (tipo y texto
  reseteados)

### Requirement: Validación en el widget antes de enviar

El widget MUST impedir el envío de un reporte sin texto (vacío o solo
espacios) y MUST acotar la entrada a 2000 caracteres, espejando los límites
del backend para que el caso común nunca llegue a un 422. Esta validación de
cliente es conveniencia de UX: la autoridad de validación es el backend
(spec del dominio `feedback`), y el widget MUST tratar un 422 inesperado como
el estado de error del requirement anterior.

#### Scenario: Sin texto no se puede enviar

- GIVEN el dialog del widget abierto con el textarea vacío o con solo
  espacios
- WHEN el tester intenta enviar
- THEN el envío no se emite (control deshabilitado o rechazo local visible)
- AND no sale ningún `POST /feedback`

#### Scenario: El texto se acota a 2000 caracteres

- GIVEN un tester escribiendo un reporte largo
- WHEN el texto alcanza los 2000 caracteres
- THEN el widget no permite exceder ese límite (tope de entrada o bloqueo del
  envío con indicación visible del límite)

### Requirement: Tablero Kanban `/feedback` visible para todo usuario autenticado

La página `dashboard/app/(app)/feedback/page.tsx` MUST consumir `GET /feedback`
y renderizar un tablero con **cinco columnas**, una por estado de la API, en
este orden de flujo: `new → in_analysis → in_progress → done`, y la columna
`discarded` **visual y semánticamente separada** del flujo (posición aparte,
estilo propio, etiqueta i18n propia y `aria-label` propio): `Descartado` MUST
NOT poder confundirse con "otro Hecho". Cada tarjeta MUST ubicarse en la
columna de su `status` y, dentro de la columna, ordenarse por `created_at`
descendente.

Cada tarjeta MUST mostrar: tipo (falla/sugerencia), un resumen del `body`,
`author_email`, fecha de creación y el `admin_comment` cuando no es `null`,
diferenciado visualmente del texto del tester. Desde la tarjeta MUST poder
abrirse un detalle con el `body` completo y el contexto técnico (`route`,
`url`, `user_agent`).

El sidebar (`dashboard/components/AppSidebar.tsx`) MUST agregar la entrada de
navegación al tablero **fuera de `adminRoutes`**, visible para TODO usuario
autenticado, cualquiera sea su rol.

Los datos MUST cargarse al entrar a la página y refrescarse al recargar o
mediante una acción explícita de refresco; el tablero MUST NOT abrir ningún
canal en tiempo real (WebSocket/SSE). Un tablero vacío MUST mostrar las cinco
columnas vacías con un mensaje de estado vacío, no un error.

El texto libre (`body` del tester y `admin_comment`) MUST renderizarse como
texto plano (escape por defecto de React); la página MUST NOT usar
`dangerouslySetInnerHTML` sobre ningún campo provisto por usuarios —
mitigación explícita de XSS almacenado del proposal.

#### Scenario: Un viewer ve el tablero completo con las cinco columnas

- GIVEN una sesión de rol `viewer` y un `GET /feedback` que devuelve tarjetas
  en los cinco estados, de varios autores, una con `admin_comment`
- WHEN entra a `/feedback`
- THEN ve cinco columnas: cuatro en el orden Nuevo, En análisis, En progreso,
  Hecho, y una columna Descartado separada del flujo
- AND cada tarjeta aparece en la columna de su `status`, con tipo, resumen,
  `author_email` y fecha
- AND la tarjeta con `admin_comment` lo muestra diferenciado del texto del
  tester
- AND la entrada "Feedback" del sidebar es visible para ese viewer

#### Scenario: Descartado no es Hecho (QA visual del usuario + test de estructura)

- GIVEN un tablero con una tarjeta en `done` y otra en `discarded`
- WHEN se renderiza la página
- THEN la columna de `discarded` tiene un `aria-label` y una etiqueta i18n
  distintos de los de `done` (automatizable)
- AND está ubicada fuera de la secuencia de las cuatro columnas del flujo,
  con estilo distinto (verificación **QA visual manual del usuario**)

#### Scenario: El detalle muestra el contexto técnico

- GIVEN una tarjeta cuyo `url` codifica `?channel=AK.FIRE..BHZ&start=...`
- WHEN el usuario abre el detalle desde la tarjeta
- THEN ve el `body` completo, `route`, `url` con sus query params y
  `user_agent` tal como los devolvió la API

#### Scenario: Orden dentro de una columna

- GIVEN tres tarjetas en `new` con `created_at` T1 < T2 < T3
- WHEN se renderiza la columna Nuevo
- THEN el orden de arriba a abajo es T3, T2, T1
- AND no existe ningún control para reordenarlas a mano

#### Scenario: Un body malicioso se muestra inerte

- GIVEN un reporte cuyo `body` contiene `<script>alert(1)</script>` y un
  `admin_comment` con `<img onerror=...>`
- WHEN cualquier usuario abre el tablero
- THEN ambos textos se muestran literales como texto plano, sin ejecutarse
- AND ningún campo se renderiza vía `dangerouslySetInnerHTML`

#### Scenario: Tablero vacío

- GIVEN un `GET /feedback` que devuelve una lista vacía
- WHEN se renderiza `/feedback`
- THEN aparecen las cinco columnas vacías con un mensaje de estado vacío
- AND no se muestra ningún mensaje de error

### Requirement: Modo lectura sin controles de gestión

Cuando el rol del usuario de sesión NO está en `ADMIN_ROLES` (`admin`,
`superadmin` — mismo mecanismo que `AppSidebar.tsx`), el componente Kanban
MUST renderizarse con `canManage = false`: MUST NOT montar sensores de drag &
drop, MUST NOT renderizar ningún botón ni menú "Mover a…", y MUST NOT
renderizar el editor del comentario del admin. Intentar arrastrar una tarjeta
MUST NOT producir ningún cambio visual ni ninguna petición al backend.

`ADMIN_ROLES` en el cliente es un gate VISUAL: la autorización real vive en el
backend (`require_min_role(ADMIN)`). Un cliente manipulado que fuerce
`canManage` recibe 403 y cae en el requirement de reversión.

#### Scenario: Un viewer no encuentra controles de gestión

- GIVEN una sesión de rol `viewer` (o `moderador`) y un tablero con tarjetas
- WHEN se renderiza `/feedback`
- THEN no existe ningún control de "Mover a…" ni editor de comentario en
  ninguna tarjeta
- AND al intentar arrastrar una tarjeta a otra columna, la tarjeta permanece
  en su columna y no se emite ninguna petición de movimiento

### Requirement: Modo gestión — drag & drop más fallback accesible "Mover a…"

Cuando el rol está en `ADMIN_ROLES`, el componente Kanban MUST renderizarse
con `canManage = true` y ofrecer **dos** mecanismos equivalentes para mover
una tarjeta, ambos obligatorios:

1. **Drag & drop** entre columnas con `@dnd-kit` (ya instalado para los
   walls; cero dependencias nuevas), incluyendo `KeyboardSensor`.
2. **Menú "Mover a…"** en cada tarjeta, operable por teclado y lector de
   pantalla, que lista los cinco estados con sus etiquetas i18n, con el
   estado actual marcado y deshabilitado (decidido en spec, ver tabla). Este
   fallback MUST existir siempre en modo gestión (teclado, lectores de
   pantalla y pantallas táctiles no pueden depender del arrastre).

Ambos mecanismos MUST invocar el endpoint de mover con el `status` destino del
enum de la API (nunca la etiqueta traducida). Un drop en la **misma** columna
de origen MUST NOT emitir ninguna petición (decidido en spec).

Además, en modo gestión cada tarjeta (o su detalle) MUST ofrecer un **editor
del comentario del admin**: un solo campo de texto, precargado con el
`admin_comment` actual, con tope visible de 2000 caracteres, y acciones de
guardar y vaciar. Guardar MUST invocar el endpoint de comentario con el texto;
vaciar MUST invocarlo con `null` (o cadena vacía). No existe UI de historial ni
de múltiples comentarios.

#### Scenario: Mover por drag & drop persiste y se refleja

- GIVEN una sesión de rol `admin` y una tarjeta en la columna Nuevo
- WHEN la arrastra a la columna En progreso y la suelta
- THEN se emite una única petición de movimiento con `status = "in_progress"`
- AND tras la respuesta 200 la tarjeta queda en En progreso
- AND al recargar la página la tarjeta sigue en En progreso (dato del backend)

#### Scenario: Mover por el menú "Mover a…" con teclado

- GIVEN una sesión de rol `admin` y una tarjeta en Nuevo
- WHEN, usando solo el teclado, enfoca la tarjeta, abre "Mover a…" y elige
  "Hecho"
- THEN se emite una petición de movimiento con `status = "done"`
- AND la tarjeta queda en la columna Hecho
- AND el menú lista los cinco estados con sus etiquetas i18n (incluido
  Descartado, distinguible de Hecho)

#### Scenario: Soltar en la misma columna no hace nada

- GIVEN una sesión de rol `admin` y una tarjeta en En análisis
- WHEN la arrastra y la suelta en la misma columna En análisis
- THEN no se emite ninguna petición al backend
- AND la tarjeta sigue en En análisis

#### Scenario: El admin escribe, edita y vacía el comentario

- GIVEN una sesión de rol `admin` y una tarjeta sin comentario
- WHEN escribe "Reproducido" y guarda
- THEN se emite la petición de comentario con ese texto y la tarjeta muestra
  "Reproducido"
- AND al editar a "Reproducido, fix en curso" y guardar, la tarjeta muestra
  solo el texto nuevo (sin rastro del anterior)
- AND al accionar "vaciar", se emite la petición con `null` y la tarjeta deja
  de mostrar comentario

### Requirement: Un movimiento rechazado revierte la tarjeta

Si el backend rechaza un movimiento — 403 (rol degradado en caliente), 422,
404, 5xx o fallo de red — la tarjeta MUST volver a su columna de origen y la
UI MUST mostrar un aviso de error visible. El tablero MUST NOT quedar
mostrando un estado que el backend no confirmó. Mientras la petición está en
vuelo, la tarjeta MAY mostrarse en la columna destino de forma optimista, pero
solo la respuesta 200 la consolida. Lo mismo aplica al comentario: si el
backend rechaza, el comentario mostrado MUST volver al valor anterior con
aviso.

#### Scenario: Un 403 revierte la tarjeta

- GIVEN una sesión que el cliente cree `admin` pero cuyo rol fue degradado en
  la base (el backend responde 403 al mover)
- WHEN el usuario arrastra una tarjeta de Nuevo a Hecho
- THEN la tarjeta vuelve a la columna Nuevo
- AND aparece un aviso de error visible
- AND al recargar la página la tarjeta sigue en Nuevo

#### Scenario: Un fallo de red revierte la tarjeta

- GIVEN una sesión de rol `admin` y el backend inalcanzable
- WHEN mueve una tarjeta con el menú "Mover a…"
- THEN la tarjeta vuelve a su columna original con aviso de error
- AND no queda ninguna tarjeta en una columna que el backend no confirmó

#### Scenario: Un comentario rechazado vuelve al valor anterior

- GIVEN una tarjeta con `admin_comment = "v1"` y un backend que responde 422
  al guardar
- WHEN el admin intenta guardar un texto nuevo
- THEN la tarjeta sigue mostrando "v1" y aparece un aviso de error

### Requirement: Strings i18n del widget y del tablero

Todos los strings visibles del widget flotante y del tablero — incluidas las
**cinco etiquetas de estado**, el aviso de transparencia, los textos del menú
"Mover a…", del editor de comentario y los mensajes de error/reversión — MUST
proveerse en español e inglés vía el mecanismo `useTranslations` (next-intl)
existente, en `dashboard/messages/{es,en}.json`, sin literales hardcodeados en
los componentes. Las claves nuevas MUST pasar el test de paridad es/en ya
existente (`messages/parity.test.ts`). El valor crudo del enum de la API
(`in_analysis`, etc.) MUST NOT aparecer nunca como texto visible.

#### Scenario: El tablero y el widget cambian de idioma con el resto del dashboard

- GIVEN el dashboard configurado en inglés
- WHEN el tester abre el widget de feedback y luego `/feedback`
- THEN todos los textos de ambas superficies (labels, tipos, las cinco
  columnas, confirmaciones, avisos y errores) se muestran en inglés
- AND al cambiar el dashboard a español, se muestran en español sin strings
  faltantes (sin claves crudas visibles) y sin valores del enum de la API a
  la vista

#### Scenario: Paridad de claves es/en

- GIVEN las claves i18n agregadas por este change en `es.json` y `en.json`
- WHEN corre `messages/parity.test.ts`
- THEN pasa: cada clave nueva existe en ambos idiomas
