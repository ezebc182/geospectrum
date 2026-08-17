# Delta for Dashboard UI (role-management)

Delta sobre la UI existente del dashboard (Next.js 15 / React 19, next-intl, componentes
`ui/` de shadcn). La pestaña "Usuarios" de `/admin/access?tab=users` ya existe
(`user-management`), con listado, acciones de desactivar/reactivar, `AlertDialog` de
confirmación, deshabilitado con explicación accesible y outcome de error traducido en
caliente. Este delta le agrega la columna de rol y alinea el selector de invitaciones.

Regla que atraviesa todo este delta: **la UI no es el enforcement.** El backend rechaza
igual. Lo que la UI debe garantizar es no OFRECER lo imposible y explicar por qué algo
está vedado.

## ADDED Requirements

### Requirement: Selector de rol por fila en la pestaña de usuarios

La pestaña de usuarios MUST permitir cambiar el rol de un usuario desde su fila, mediante
un control de selección que muestre el rol actual y ofrezca los roles otorgables. Las
etiquetas de rol MUST resolverse por diccionario i18n (las cuatro ya existen bajo
`admin.roles.*`), nunca hardcodeadas.

El control MUST ser un `<select>` NATIVO y NO un `DropdownMenu` de Radix: no existe
componente `Select` en `dashboard/components/ui/` y el proyecto ya resolvió este mismo
problema en el panel de invitaciones, donde el typeahead de Radix se come las teclas.

Tras un cambio exitoso la lista MUST reflejar el rol nuevo sin reload manual (refetch del
listado). Mientras una acción está en vuelo, MUST deshabilitarse SOLO la fila afectada, no
el listado entero (patrón `busyId` existente).

#### Scenario: Un admin promueve a un viewer desde la lista

- GIVEN un `admin` viendo la pestaña de usuarios con un usuario `viewer`
- WHEN selecciona `moderador` en el control de esa fila y confirma
- THEN se llama al endpoint de cambio de rol para ese usuario
- AND al responder 204 la fila muestra `moderador` tras el refetch

#### Scenario: Solo se bloquea la fila en vuelo

- GIVEN un cambio de rol en curso sobre la fila A
- WHEN el admin mira la fila B
- THEN los controles de B siguen habilitados

#### Scenario: Las etiquetas de rol están traducidas

- GIVEN la pestaña renderizada en inglés
- WHEN se listan las opciones de rol
- THEN se muestran las etiquetas del diccionario en inglés, sin strings hardcodeados en
  el componente

### Requirement: El selector solo ofrece roles de nivel estrictamente menor

Las opciones ofrecidas MUST filtrarse con jerarquía ESTRICTA respecto del rol del usuario
autenticado: solo roles con `ROLE_LEVEL` ESTRICTAMENTE MENOR al propio. Un `admin` MUST
ver únicamente `moderador` y `viewer`; MUST NOT ver `admin` ni `superadmin`. `superadmin`
MUST NOT aparecer como opción para NINGÚN actor.

Este filtro MUST NOT copiarse verbatim del panel de invitaciones, cuyo memo usa `<=` (nivel
menor o IGUAL). Copiarlo tal cual viola la regla en la UI de forma silenciosa y sin romper
ningún test visible.

#### Scenario: Un admin no ve "admin" entre las opciones

- GIVEN un `admin` autenticado viendo la fila de un `viewer`
- WHEN abre el selector de rol
- THEN las opciones son exactamente `moderador` y `viewer`
- AND `admin` y `superadmin` NO están entre ellas

#### Scenario: Un superadmin no ve "superadmin" entre las opciones

- GIVEN un `superadmin` autenticado viendo la fila de un `viewer`
- WHEN abre el selector de rol
- THEN las opciones son `admin`, `moderador` y `viewer`
- AND `superadmin` NO está entre ellas

#### Scenario: El rol actual del usuario se muestra aunque no sea otorgable

- GIVEN un `superadmin` viendo la fila de un usuario `admin`
- WHEN observa la fila
- THEN el rol actual (`admin`) se muestra legible, aunque el conjunto de opciones
  otorgables sea distinto del conjunto de roles existentes

### Requirement: Todo cambio de rol pasa por confirmación

La UI MUST pedir confirmación en un `AlertDialog` ante CUALQUIER cambio de rol, sea
promoción o degradación. El diálogo MUST indicar a qué email afecta, el rol actual y el rol
destino. Cancelar MUST NOT disparar ninguna llamada a la API y MUST dejar el control en el
rol actual (sin quedar mostrando el valor elegido y no aplicado).

Es una acción sobre permisos: un click errado no debe cambiar quién administra el sistema.
Esta requirement es deliberadamente MÁS estricta que la de desactivar/reactivar (donde
reactivar no pide confirmación por ser no destructivo).

#### Scenario: Confirmar una promoción

- GIVEN un admin que eligió `moderador` para un usuario `viewer`
- WHEN se abre el diálogo y confirma
- THEN se llama al endpoint y la fila refleja el rol nuevo

#### Scenario: Confirmar una degradación

- GIVEN un `superadmin` que eligió `viewer` para un usuario `admin`
- WHEN se abre el diálogo y confirma
- THEN se llama al endpoint (la degradación NO tiene un camino distinto ni más corto que
  la promoción)

#### Scenario: Cancelar no llama a la API ni deja el control desincronizado

- GIVEN el diálogo de confirmación abierto tras elegir `moderador` para un `viewer`
- WHEN el admin cancela
- THEN no se hace ninguna llamada a la API
- AND el control vuelve a mostrar `viewer` (el rol real), no `moderador`

#### Scenario: El diálogo dice qué va a pasar y a quién

- GIVEN el diálogo abierto para el usuario `ana@example.com`, de `viewer` a `moderador`
- WHEN se renderiza
- THEN el texto incluye el email afectado y ambos roles, traducidos

### Requirement: La UI refleja los guards de jerarquía y de auto-gestión

El control de cambio de rol MUST estar DESHABILITADO (no oculto) para: la fila del propio
usuario autenticado, y la de cualquier usuario de rol de nivel igual o superior al propio
(lo que incluye a todo `superadmin` visto por cualquier actor). Un control deshabilitado
MUST explicar por qué mediante el contrato de accesibilidad ya establecido en el panel
(texto accesible asociado al control, no solo un atributo visual).

Reutilizar la función existente que ya calcula la razón del deshabilitado (`self` /
`hierarchy`) es lo esperable: el guard de "a quién puedo tocar" es EL MISMO que el de
desactivar. Lo que NO es lo mismo es el filtro de opciones, que es un guard adicional
sobre "en qué lo puedo convertir".

#### Scenario: El propio usuario no puede cambiarse el rol desde la UI

- GIVEN un admin viendo la lista donde aparece su propia cuenta
- WHEN observa su fila
- THEN el control de rol está deshabilitado con la explicación de que no puede cambiar su
  propio rol

#### Scenario: Un admin ve deshabilitado el control sobre otro admin

- GIVEN un `admin` autenticado
- WHEN ve la fila de otro `admin`
- THEN el control de rol está deshabilitado con la explicación de jerarquía

#### Scenario: Nadie puede tocar el rol de un superadmin desde la UI

- GIVEN un `superadmin` autenticado
- WHEN ve la fila de otro `superadmin`
- THEN el control de rol está deshabilitado

#### Scenario: La explicación es accesible, no solo visual

- GIVEN un control deshabilitado por jerarquía
- WHEN se inspecciona con tecnología asistiva
- THEN la razón está expuesta como texto accesible asociado al control (patrón
  `title` + `sr-only` + `aria-describedby` ya usado en el panel)

### Requirement: Errores del cambio de rol traducidos y sin romper la lista

Cada status de error del endpoint MUST mapearse a un mensaje legible y traducido: 403 →
jerarquía/permisos, 404 → usuario inexistente, 409 → conflicto, y un fallback genérico para
lo demás. La lista MUST seguir utilizable tras un error (sin pantalla en blanco).

El estado de error MUST guardarse como `kind` + datos crudos y NUNCA como texto ya
resuelto, para que el cambio de idioma en caliente re-traduzca lo ya mostrado (patrón
existente del panel).

El 409 nuevo (asignar el rol que el usuario ya tiene) MUST llegar a su propia clave de
mensaje y MUST NOT confundirse con el 409 de auto-gestión, que hoy se discrimina por el
TEXTO del mensaje del backend. Este acoplamiento por string es preexistente y frágil: el
change MUST cubrir con un test que el 409 nuevo aterriza en la clave correcta.

#### Scenario: 403 por jerarquía se muestra traducido

- GIVEN un cambio de rol que el backend rechaza con 403
- WHEN la UI recibe el error
- THEN muestra el mensaje de permisos/jerarquía en el idioma activo y la lista sigue
  utilizable

#### Scenario: El 409 de "ya tiene ese rol" no se confunde con el de auto-gestión

- GIVEN un cambio de rol que el backend rechaza con 409 por no-op
- WHEN la UI mapea el error
- THEN resuelve la clave de conflicto de rol, NO la de "no podés gestionar tu propia
  cuenta"

#### Scenario: Cambio de idioma en caliente re-traduce el error visible

- GIVEN la pestaña en español con un error de cambio de rol visible
- WHEN el usuario cambia el idioma a inglés
- THEN el mensaje se muestra en inglés sin recargar la página

#### Scenario: Un 401/403 del LISTADO sigue tratándose como sesión perdida

- GIVEN el listado que falla con 401 o 403
- WHEN se renderiza el panel
- THEN se muestra el mensaje de sesión existente, sin regresión respecto de
  user-management

### Requirement: Paridad de claves ES/EN para el cambio de rol

Toda clave i18n nueva de este change MUST existir en `dashboard/messages/es.json` Y en
`dashboard/messages/en.json`, con valores no vacíos, verificado por el test de paridad
existente. Las etiquetas de rol MUST reutilizar `admin.roles.*` (ya completo en ambos
idiomas) en lugar de duplicarse.

#### Scenario: El test de paridad pasa con las claves nuevas

- GIVEN las claves nuevas bajo `admin.users.*` (label del selector, textos del diálogo de
  confirmación, razones de deshabilitado y errores del cambio de rol)
- WHEN corre el test de paridad
- THEN pasa en ambas direcciones y sin valores vacíos

#### Scenario: Las etiquetas de rol no se duplican

- GIVEN el selector de rol renderizado
- WHEN resuelve las etiquetas
- THEN usa el diccionario `admin.roles.*` existente, sin claves nuevas por rol

## MODIFIED Requirements

### Requirement: Selector de rol al crear una invitación

El selector de rol del panel de invitaciones MUST ofrecer únicamente roles de nivel
ESTRICTAMENTE MENOR al del usuario autenticado, alineándose con el guard endurecido del
backend (ver el delta de invitations). Un `admin` MUST ver solo `moderador` y `viewer`;
`superadmin` MUST NOT aparecer como opción para NINGÚN actor, incluido un superadmin.

(Previously: el memo `grantableRoles` filtraba con `ROLE_LEVEL[r] <= ROLE_LEVEL[user.role]`
— nivel menor o IGUAL — de modo que un admin veía `admin` entre las opciones y un
superadmin veía `superadmin`.)

Si tras el filtro un actor no tuviera ningún rol otorgable, la UI MUST NOT romper: el
formulario queda sin opciones válidas y sin permitir el submit. (No es un caso alcanzable
hoy — el rol mínimo para invitar es `admin`, que siempre conserva `moderador` y `viewer`
— pero el componente no debe depender de esa coincidencia.)

#### Scenario: Un admin ya no ve "admin" al invitar

- GIVEN un `admin` autenticado en el panel de invitaciones
- WHEN abre el selector de rol
- THEN las opciones son exactamente `moderador` y `viewer`

#### Scenario: Un superadmin ya no ve "superadmin" al invitar

- GIVEN un `superadmin` autenticado en el panel de invitaciones
- WHEN abre el selector de rol
- THEN las opciones son `admin`, `moderador` y `viewer`

#### Scenario: El default del formulario sigue siendo válido

- GIVEN el panel de invitaciones recién montado para cualquier actor
- WHEN se renderiza el selector
- THEN el rol preseleccionado pertenece al conjunto de opciones otorgables (no queda un
  valor por defecto que el backend vaya a rechazar con 403)
