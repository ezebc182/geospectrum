# Delta for Dashboard UI (user-management)

Delta sobre la UI existente del dashboard (Next.js 15 / React 19, next-intl,
componentes `ui/` de shadcn). La sección de administración de accesos ya existe como
página con pestañas (`dashboard/app/(app)/admin/access/page.tsx`, pestañas
`waitlist` e `invitations`, estado en `?tab=`).

## ADDED Requirements

### Requirement: Pestaña "Usuarios" en la administración de accesos

El dashboard MUST exponer la gestión de usuarios como TERCERA pestaña de
`/admin/access` (`?tab=users`), junto a "Lista de espera" e "Invitaciones", NO como
página nueva en el sidebar. La pestaña activa MUST seguir viviendo en la URL (deep-link
y back del navegador funcionando, patrón existente). El acceso MUST estar gateado
client-side por rol admin+ (con el mismo mensaje de "forbidden" ya existente en la
página), entendiendo que la autoridad real de permisos es el backend.

#### Scenario: Un admin abre la pestaña de usuarios

- GIVEN un usuario con rol `admin` o `superadmin` autenticado
- WHEN navega a `/admin/access?tab=users`
- THEN ve la lista de usuarios con email, rol, origen (Google / password) y estado
  (activa / desactivada)
- AND las tres pestañas siguen visibles y navegables

#### Scenario: Un viewer no ve la sección

- GIVEN un usuario con rol `viewer` o `moderador`
- WHEN navega a `/admin/access` (con cualquier `?tab=`)
- THEN ve el mensaje de sección solo para administradores, sin lista de usuarios

#### Scenario: Deep-link a una pestaña desconocida

- GIVEN una URL `/admin/access?tab=cualquier-cosa`
- WHEN se renderiza la página
- THEN cae a la pestaña por defecto existente ("Lista de espera"), sin romper

### Requirement: Desactivar una cuenta requiere confirmación explícita

La UI MUST pedir confirmación (diálogo modal, patrón `AlertDialog` ya usado para
revocar invitaciones) antes de desactivar una cuenta, indicando a QUÉ email afecta y
que la acción bloquea el acceso de esa persona. Cancelar MUST NOT disparar ninguna
llamada a la API. La UI MUST reflejar el nuevo estado tras el éxito sin requerir un
reload manual.

#### Scenario: Confirmar la desactivación

- GIVEN un admin viendo la lista con un usuario activo
- WHEN presiona "Desactivar" y confirma en el diálogo
- THEN se llama a `POST /auth/users/{id}/deactivate`
- AND al responder 204 la fila pasa a mostrarse como desactivada, con el botón
  "Reactivar" en lugar de "Desactivar"

#### Scenario: Cancelar la desactivación

- GIVEN el diálogo de confirmación abierto
- WHEN el admin cancela
- THEN no se hace ninguna llamada a la API y la fila no cambia

#### Scenario: Reactivar no requiere confirmación

- GIVEN un usuario desactivado en la lista
- WHEN el admin presiona "Reactivar"
- THEN se llama directamente a `POST /auth/users/{id}/reactivate` (acción no
  destructiva: restaurar acceso no necesita fricción)
- AND al responder 204 la fila vuelve al estado activo

### Requirement: La UI refleja los guards de jerarquía

La UI MUST deshabilitar (no ocultar) la acción de desactivar sobre: el propio usuario
autenticado, y cualquier usuario de rol de nivel igual o superior al propio
(`ROLE_LEVEL` de `dashboard/lib/types.ts`, ya existente para el selector de roles de
invitaciones). Un botón deshabilitado MUST explicar por qué (título/texto accesible).
Esto es UX, NO seguridad: el backend rechaza igual.

#### Scenario: El propio usuario no puede desactivarse desde la UI

- GIVEN un admin viendo la lista donde aparece su propia cuenta
- WHEN observa su fila
- THEN la acción de desactivar está deshabilitada con la explicación de que no puede
  desactivar su propia cuenta

#### Scenario: Un admin ve deshabilitada la acción sobre otro admin

- GIVEN un `admin` autenticado
- WHEN ve la fila de otro `admin` o de un `superadmin`
- THEN la acción de desactivar está deshabilitada con la explicación de jerarquía

#### Scenario: Un error del backend se muestra sin romper la lista

- GIVEN una acción que el backend rechaza (403/409/404)
- WHEN la UI recibe el error
- THEN muestra un mensaje legible y traducido, y la lista sigue utilizable (sin
  pantalla en blanco)

### Requirement: Mensaje de cuenta desactivada en el login

La pantalla `/login` MUST mostrar copy claro y traducido cuando el backend redirige con
`?error=account_deactivated` (login por Google) y cuando `POST /auth/login` responde
403 por cuenta desactivada (login por password). El mensaje MUST indicar que la cuenta
fue desactivada y que hay que contactar a un administrador, sin exponer detalles
internos.

#### Scenario: Redirect de Google con cuenta desactivada

- GIVEN el backend redirige a `/login?error=account_deactivated`
- WHEN se renderiza la página de login
- THEN se muestra el mensaje de cuenta desactivada en el idioma activo (no el mensaje
  genérico de "no se pudo completar el inicio de sesión")

#### Scenario: Login por password con cuenta desactivada

- GIVEN un usuario desactivado que envía credenciales correctas en el form
- WHEN el backend responde 403
- THEN el form muestra el mismo mensaje de cuenta desactivada, distinto del de
  credenciales inválidas

### Requirement: Paridad de claves ES/EN para la gestión de usuarios

Toda clave i18n nueva de este change MUST existir en `dashboard/messages/es.json` Y en
`dashboard/messages/en.json`, con valores no vacíos, verificado por el test de paridad
existente (`dashboard/messages/parity.test.ts`). Ningún texto visible MUST quedar
hardcodeado en los componentes (los labels de rol/estado se resuelven vía diccionario,
igual que en `InvitationsPanel`).

#### Scenario: El test de paridad pasa con las claves nuevas

- GIVEN las claves `admin.users.*`, `admin.access.tabs.users` y
  `auth.oauthErrors.accountDeactivated` agregadas
- WHEN corre `vitest` sobre `messages/parity.test.ts`
- THEN pasa en ambas direcciones (toda clave de ES en EN y viceversa) y sin valores
  vacíos

#### Scenario: Cambio de idioma en caliente re-traduce la pestaña

- GIVEN la pestaña de usuarios renderizada en español, con un error visible de una
  acción fallida
- WHEN el usuario cambia el idioma a inglés
- THEN los labels, estados y el mensaje de error se muestran en inglés sin recargar la
  página (el estado guarda el outcome, no el texto resuelto — patrón existente de
  `InvitationsPanel`)
