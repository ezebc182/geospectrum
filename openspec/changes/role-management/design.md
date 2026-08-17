# Design: Cambio de rol de usuarios desde la UI de administración

## Technical Approach

Dos piezas que sólo sirven juntas, y una tercera que es la cara visible:

1. **El escritor** — `AuthService.change_user_role()`, clon estructural de
   `deactivate_user()` (`src/services/auth_service.py:1291`): `acquire` → `transaction` →
   `_load_manageable_target()` (1251, que trae la fila con `FOR UPDATE` en 1280) → guards
   propios → `UPDATE users SET role = $2 WHERE id = $1`. El endpoint
   `POST /auth/users/{user_id}/role` es un clon estructural de
   `POST /auth/users/{user_id}/deactivate` (`src/main.py:1448`): 204, `response_model=None`,
   un `except` por excepción de dominio, métricas con label literal.

2. **El lector** — el rol deja de ser un claim en el que se confía. Un método ADITIVO en
   `AuthService` devuelve estado + rol en UNA query; `get_current_user()`
   (`src/api/deps.py:40`) lo usa y devuelve un `CurrentUser` cuyo `role` viene de la BASE,
   no del JWT. `require_min_role()` (`deps.py:195`) queda correcto por construcción y NO se
   toca.

3. **La UI** — una columna más en `UsersPanel.tsx`: `<select>` nativo con los roles
   otorgables (filtro `<` ESTRICTO) + `AlertDialog` en TODO cambio, sobre los patrones ya
   establecidos del panel (outcome como `kind`+datos, `busyId`, `disabledReasonFor()`,
   a11y `title` + `sr-only` + `aria-describedby`).

**Sin migración**: `users.role` existe desde la 001 y el `CHECK` de
`deploy/sql/migrations/002_add_role_hierarchy.sql:17-18` ya cubre los cuatro valores.

## El hallazgo que condiciona el change

El proyecto ya escribió la regla y nunca la implementó. `ROLE_LEVEL`
(`src/models/user.py:38-41`) dice textualmente: *"un usuario de nivel N solo puede
gestionar (crear/**asignar rol a**) usuarios de nivel ESTRICTAMENTE menor que N"*. Existen
dos enforcements parciales de esa frase — `CannotInviteHigherRoleError`
(`invitation_service.py:115`, y encima con `>` en vez de `>=`, línea 251) y
`CannotManageHigherOrEqualRoleError` (`auth_service.py:142`) — y cero para "asignar rol a".

El agravante que lo vuelve un problema de control de acceso y no de pantalla:
`decode_access_token()` (`auth_service.py:805`) arma el `CurrentUser` 100% de los claims
(`role=UserRole(payload["role"])`, línea 825). Con `auth_token_expire_minutes = 1440`
(`src/config/settings.py:98`), degradar a un admin no le saca NADA por hasta 24 horas.

La buena noticia es que `user-management` ya pagó la mitad del costo: `get_current_user()`
ya hace un round-trip por request (`await auth_service.is_user_active()`, `deps.py:109`) y
su docstring (60-78) ya argumenta ese round-trip con exactamente el mismo razonamiento.
Este change agrega **una columna al SELECT**, no una query.

## Architecture Decisions

### Decision 1: Método aditivo `get_user_auth_state()`, e `is_user_active()` reimplementado encima

**Choice**: se agrega un método nuevo al lado de `is_user_active()`
(`auth_service.py:1191`) que devuelve estado + rol en UNA query, y `is_user_active()`
sobrevive con su firma intacta, reimplementado sobre el nuevo:

```python
@dataclass(frozen=True)
class UserAuthState:
    """Estado de autorización de una cuenta, leído de la base en el camino caliente."""
    is_active: bool
    role: Optional[UserRole]   # None si y sólo si la fila no existe

async def get_user_auth_state(self, user_id: UUID) -> UserAuthState: ...

async def is_user_active(self, user_id: UUID) -> bool:   # firma INTACTA
    return (await self.get_user_auth_state(user_id)).is_active
```

**Alternatives considered**:
- (a) Cambiar la firma de `is_user_active()` a `-> tuple[bool, Optional[UserRole]]`.
- (b) Un método `get_user_role(user_id)` separado, y `get_current_user()` llamando a los
  dos.
- (c) Usar `get_user_by_id()` (`auth_service.py:506`) en `get_current_user()`.
- (d) Devolver una `tuple[bool, Optional[UserRole]]` en vez de un dataclass.

**Rationale**: (a) es la decisión 7 del usuario en negativo y es un suicidio verificado —
hay al menos tres fakes que DEFINEN el método: `tests/unit/test_deps.py:75`
(`async def is_user_active(self, user_id) -> bool`), `tests/integration/test_auth_api.py:63`
y `tests/integration/test_invitations_api.py:207` (los dos con
`AsyncMock(return_value=True)`). Cambiarle la firma rompe los tres a la vez, y el
precedente del proyecto es feo: en `user-management` los `MagicMock` truthy rompieron 65
tests.

(b) duplica el round-trip: dos queries por request en el camino más caliente de la app, por
nada. La decisión 3 del usuario y el proposal son explícitos en que el costo tiene que
seguir siendo el mismo (misma query, una columna más).

(c) está descartado en la evidencia: `get_user_by_id()` es un `SELECT` gordo con todas las
columnas de la fila (incluidos `password_hash` y `totp_secret`). Traer secretos a memoria en
CADA request autenticado para leer un enum es exactamente lo contrario de lo que hace
`list_users()` (1221-1224), que deriva `has_google`/`has_password` en la query justamente
para que los secretos ni salgan de la base.

(d) una tupla se desestructura mal y se lee peor: `state.role` es autoexplicativo,
`state[1]` no. Y `frozen=True` hace inexpresable que alguien la mute en el camino caliente.

**La query** (una sola, PK, misma forma que la actual con una columna más):

```sql
SELECT role, deactivated_at FROM users WHERE id = $1
```

**Contrato de `role` cuando la fila no existe**: `None`, no un default. Un `UserRole.VIEWER`
de relleno sería un rol REAL inventado por el lector para una cuenta que no existe. Es
inalcanzable en la práctica (`is_active=False` produce 401 antes de que nadie mire el rol),
pero el tipo tiene que ser incapaz de mentir. `Optional[UserRole]` obliga a `get_current_user()`
a manejar el caso explícitamente en vez de propagar un rol fantasma.

**Los fakes existentes NO se tocan**: siguen definiendo `is_user_active` y siguen
funcionando, porque nadie les llama `get_user_auth_state()`. El único fake que hay que
extender es el de `tests/unit/test_deps.py:75`, y **porque el test lo pide**, no porque la
firma cambió — ver Testing Strategy.

### Decision 2: `get_current_user()` SOBRESCRIBE el rol; no lo compara

**Choice**: `get_current_user()` reemplaza la llamada a `is_user_active()` por
`get_user_auth_state()` y devuelve un `CurrentUser` **reconstruido** con el rol de la base:

```python
    state = await auth_service.get_user_auth_state(current_user.id)
    if not state.is_active or state.role is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
        )

    # SOBRESCRITURA, no comparación: require_min_role() autoriza leyendo
    # CurrentUser.role, así que si acá se devolviera el objeto armado desde el
    # JWT el rol stale seguiría mandando y todos los tests pasarían igual.
    return current_user.model_copy(update={"role": state.role})
```

**Alternatives considered**:
- (a) `if state.role != current_user.role: raise HTTPException(401)` y `return current_user`.
- (b) Sobrescribir en `require_min_role()` en vez de en `get_current_user()`.
- (c) Bajar `auth_token_expire_minutes` para achicar la ventana.
- (d) Sacar el claim `role` del JWT entero.

**Rationale**: (a) es EL agujero silencioso de este change y por eso el usuario lo cerró
como decisión 3. El detalle fino: **pasa todos los tests que a uno se le ocurriría escribir**
y deja el sistema idéntico de roto. Un test de "degradar y verificar 401" pasa (la
comparación falla y tira 401). Un test de "el rol se lee de la base" pasa (se lee). Y sin
embargo, en el caso que importa — el usuario promovido, o cualquier ventana donde la
comparación no dispare — `require_min_role()` (`deps.py:217`) sigue leyendo
`current_user.role`, que es el del token. Peor todavía: (a) convierte una PROMOCIÓN en un
401 (el token dice viewer, la base dice moderador, no coinciden, afuera), o sea que el
usuario promovido queda deslogueado hasta que vuelva a entrar. La sobrescritura promueve en
caliente sin re-login, que es el criterio de éxito del proposal.

Por eso el criterio de aceptación se escribe sobre **comportamiento observable** ("token
viejo con rol admin + degradación en la base ⇒ 403 en el request siguiente") y nunca sobre
"se chequea el rol". Un chequeo-sin-sobrescritura no puede pasar ese test: devolvería 401,
no 403, y la promoción en caliente le rompe en la cara.

(b) reparte la verdad en dos lugares. `require_min_role()` no es el único lector de
`.role`: `src/main.py` lo lee en 981, 1142, 1236, 1310 y 1710, y todos esos vienen del
`CurrentUser`. Sobrescribir en `get_current_user()` los arregla a los cinco
transitivamente; sobrescribir en `require_min_role()` arreglaría uno y dejaría los otros
cinco stale. **Es el punto de choque único** — verificado: NO hay ningún endpoint que
decodifique el JWT por fuera de esta dependencia.

(c) mitiga sin resolver; ya rechazado con el mismo argumento en `user-management` design.md
Decision 4.

(d) rompe compatibilidad con los tokens ya emitidos en producción y con
`decode_access_token()` (805), que exige el shape completo. El claim se queda; simplemente
deja de ser autoridad.

**`model_copy(update=...)` y no mutación in-place**: `CurrentUser` es un `BaseModel` de
Pydantic y el objeto que devuelve `decode_access_token()` es de esta misma request, así que
mutarlo sería seguro — pero devolver un objeto nuevo deja el "acá cambia la autoridad del
rol" explícito en el diff, en una línea que un revisor no puede pasar por alto. Es la misma
razón por la que el proyecto rechaza no-ops silenciosos.

**`get_current_user_optional()` (`deps.py:118`) NO SE TOCA.** Hereda la sobrescritura por
delegación (línea 158), igual que heredó el bloqueo de desactivadas. Y NO se le agrega un
`Depends(_get_auth_service)` propio: ese es el bug documentado en 133-141 y 147-151 que
convirtió `/report` en un 500 (un `Depends` se resuelve ANTES del cuerpo y su
`AttributeError` escapa del try).

### Decision 3: Guard explícito de superadmin, ANTES del guard general de jerarquía

**Choice**: `CannotChangeSuperadminRoleError`, guard dedicado con excepción propia, evaluado
**antes** del guard general, y NO como consecuencia emergente de
`role_level(target) >= role_level(actor)`.

**Alternatives considered**:
- (a) Dejarlo emergente: hoy `_load_manageable_target()` ya rechaza a un superadmin para
  cualquier actor, porque no hay nivel mayor a 3. Cero código nuevo.
- (b) Un `CHECK`/trigger en la base.

**Rationale**: (a) es correcto HOY y sólo por aritmética. `role_level(SUPERADMIN) = 3` es el
máximo del diccionario, así que `>=` siempre se cumple. La regla "nadie le cambia el rol a
un superadmin" no está escrita en ningún lado: es un teorema que depende de que nadie agregue
nunca un `OWNER: 4` a `ROLE_LEVEL` (`user.py:42`). El día que alguien lo agregue — que es
exactamente el tipo de refactor que se hace sin pensar, agregando una línea a un dict — un
`OWNER` podría degradar superadmins y **ningún test fallaría**, porque no hay ningún test
que exprese la regla; los que hay expresan la aritmética.

Es la razón textual del usuario (decisión 2) y es la correcta: una invariante de seguridad
que sólo se sostiene por una propiedad numérica accidental de una tabla de constantes es
una invariante que ya se perdió, sólo que todavía no se enteró. El guard dedicado la
convierte en código que se puede leer, testear y romper ruidosamente.

Va **antes** del guard general porque el mensaje de error tiene que decir la verdad: si un
superadmin intenta cambiarle el rol a otro superadmin, la causa real no es "tu jerarquía no
alcanza" (le alcanza todo lo que existe) sino "a un superadmin no se le cambia el rol,
punto". Es el mismo criterio con el que `_load_manageable_target()` pone el guard de self
antes del 404 (1263-1268): el guard más específico primero, para que el error nombre la
causa real.

Nota de cobertura: `tests/unit/test_user_management.py:239`
(`test_a_superadmin_is_unreachable_by_every_actor`) ya barre esto para desactivar. El test
gemelo de este change tiene que exigir además **cuál** excepción sale.

(b) descartado: el proyecto no tiene triggers y la regla depende del ACTOR, que la base no
conoce.

### Decision 4: Orden exacto de los guards de `change_user_role()`

**Choice**: seis guards, en este orden, y NO reordenables:

| # | Guard | Excepción | HTTP | Dónde vive |
|---|-------|-----------|------|------------|
| 1 | `target_id == actor.id` | `CannotDeactivateSelfError` | **409** | `_load_manageable_target()` (1276) |
| 2 | fila inexistente | `UserNotFoundError` | **404** | `_load_manageable_target()` (1283) |
| 3 | `role_level(target.role) >= role_level(actor.role)` | `CannotManageHigherOrEqualRoleError` | **403** | `_load_manageable_target()` (1286) |
| 4 | `target.role == SUPERADMIN` | `CannotChangeSuperadminRoleError` | **403** | `change_user_role()` |
| 5 | `role_level(new_role) >= role_level(actor.role)` | `CannotAssignHigherOrEqualRoleError` | **403** | `change_user_role()` |
| 6 | `target.role == new_role` | `UserAlreadyHasRoleError` | **409** | `change_user_role()` |

**Alternatives considered**: validar el rol solicitado (5) ANTES de cargar el target — es
gratis, no necesita la base y evita un round-trip cuando el request es inválido.

**Rationale**: los guards 1-3 vienen de `_load_manageable_target()` y su orden está
congelado por el docstring de 1263-1274 (*"NO reordenar"*): se reutiliza tal cual, sin
tocarlo. Eso ya fija que el self (409) va antes del 404, con el argumento de que un actor
autenticado siempre existe.

La tentación de subir el guard 5 al principio es real pero está mal: cambiaría la respuesta
para un target INEXISTENTE de 404 a 403, filtrando información. Un actor que pide "asignale
admin al usuario `<uuid random>`" recibiría 403 sin que el sistema sepa siquiera si ese
usuario existe — y con suficientes intentos, la diferencia entre 403 y 404 se vuelve un
oráculo de existencia. El orden elegido resuelve primero TODO lo que depende del target
(existe, quién es, si es alcanzable) y recién después lo que depende del rol pedido.

El guard 4 va antes del 5 por lo argumentado en la Decision 3 (el más específico primero).

El guard 6 (no-op) va ÚLTIMO por la misma razón que `deactivate_user()` chequea
`deactivated_at` después de `_load_manageable_target()` (1304): es un chequeo de ESTADO, y
sólo tiene sentido preguntarse "¿ya está así?" sobre un target que ya se confirmó
gestionable. Si fuera primero, un actor sin jerarquía podría distinguir "ese usuario ya es
moderador" de "no lo es" comparando 409 contra 403 — otra vez, un oráculo.

**Por qué 409 y no 204 para el no-op**: precedente directo de `UserAlreadyDeactivatedError`
(`auth_service.py:153`, *"Rechazo explícito y no un no-op silencioso"*). Además acá hay un
argumento propio: el `AlertDialog` de la decisión 6 le dice al admin "vas a cambiar el rol
de X de viewer a moderador". Si entre que abrió el diálogo y confirmó otro admin ya lo hizo,
un 204 le confirmaría una acción que no ocurrió. El 409 es la verdad: el estado cambió abajo
tuyo.

**Concurrencia**: el `FOR UPDATE` de 1280 hace que dos cambios simultáneos se serialicen. El
segundo lee el rol que escribió el primero, así que si ambos pedían lo mismo el segundo sale
por el guard 6 (409) y si pedían distinto el último gana de forma determinística. Es el
mismo mecanismo que verifica
`test_two_concurrent_deactivations_leave_exactly_one_winner`
(`tests/unit/test_user_management.py:294`).

### Decision 5: Pregunta A — `CannotDeactivateSelfError` se RENOMBRA a `CannotManageSelfError`

**Choice**: renombrar. Un solo símbolo, tres callers, y `sd` sobre el repo.

**Alternatives considered**:
- (a) Dejarlo como está y que `change_user_role()` levante `CannotDeactivateSelfError` — un
  tercer caller con el nombre mintiendo.
- (b) Agregar una excepción hermana `CannotChangeOwnRoleError` y que
  `_load_manageable_target()` reciba cuál levantar (parámetro o subclase).
- (c) Sacar el guard de self de `_load_manageable_target()` y duplicarlo en cada caller.

**Rationale**: el nombre ya está mintiendo HOY, con dos callers. `reactivate_user()` (1315)
la levanta y su docstring tiene que gastar cuatro líneas (1322-1325) explicando por qué una
reactivación levanta un error que dice "deactivate". Con un tercer caller que ni desactiva
ni reactiva, la mentira deja de ser una molestia de lectura y pasa a ser un obstáculo:
`change_user_role()` levantando `CannotDeactivateSelfError` obliga a leer
`_load_manageable_target()` para entender que no hay ninguna desactivación involucrada. El
nombre `CannotManageSelfError` es literalmente el que ya usa el docstring del guard
(*"te estás gestionando a vos mismo"*, 1267-1268) y el que ya usa la excepción hermana
(`CannotManageHigherOrEqualRoleError`, 142). O sea: el resto del módulo ya adoptó el
vocabulario "manage" y esta clase quedó atrás.

(b) es la opción que parece más segura y es la peor: duplica el concepto. Dos excepciones
para "no te gestionás a vos mismo" significa que cada endpoint nuevo tiene que capturar las
dos o elegir mal, y que el guard compartido necesita saber quién lo llamó — acoplamiento al
revés. El proyecto ya tiene UNA excepción para esta regla y la regla no se bifurcó.

(c) tira a la basura la razón de existir de `_load_manageable_target()`.

**Costo real, medido**: es un rename mecánico. Los callers son
`auth_service.py:1277` (el `raise`), `src/main.py:1477` y `src/main.py:1532` (los `except`
de deactivate/reactivate) más el import del bloque de `main.py`, y los tests que la
importen. `sd 'CannotDeactivateSelfError' 'CannotManageSelfError'` sobre `src/` y `tests/`,
más el docstring de la clase (132-139) que pasa a hablar de "gestionarse" en vez de
"desactivarse". **Ningún contrato público cambia**: el nombre de la excepción no sale en
ninguna respuesta HTTP — el body es `{"error": "cannot deactivate your own account"}` (1483)
y los strings de los bodies **no se tocan** (ver Decision 6: el frontend depende de ellos
hoy). Los status tampoco. El frontend no se entera.

Se hace en un commit propio, primero, separado de la funcionalidad: un rename mecánico
mezclado con lógica nueva es un diff que nadie revisa bien.

**Docstring nuevo**, que absorbe la aclaración que hoy vive en `reactivate_user()`:

```python
class CannotManageSelfError(Exception):
    """Un actor intentó gestionarse a sí mismo (desactivar / reactivar /
    cambiar de rol) — 409, no 403.

    409 y no 403 a propósito: no es una falta de permisos. Un superadmin tiene
    TODO el permiso del mundo y aun así no puede — es un conflicto con el
    estado (te estarías dejando afuera del sistema, o cambiándote tus propios
    permisos), no una autorización faltante.

    [role-management] Renombrada desde `CannotDeactivateSelfError`: con un
    tercer caller que ni desactiva ni reactiva, el nombre viejo obligaba a
    leer `_load_manageable_target()` para entender que no había ninguna
    desactivación involucrada.
    """
```

### Decision 6: Pregunta B — se SIGUE con el sniffing de texto, con el string extraído a constante

**Choice**: NO se cambia el contrato de la API. El body de error sigue siendo
`{"error": "<texto>"}` y `actionErrorKey()` sigue discriminando los 409 por el mensaje —
pero el string discriminante se extrae a una constante compartida en el frontend y los
bodies del backend nuevo se eligen para caer del lado correcto del match existente.

**Alternatives considered**:
- (a) Agregar `code` al body: `{"error": "...", "code": "cannot_manage_self"}` en TODOS los
  endpoints de error, y que `actionErrorKey()` lea `code`.
- (b) Agregar `code` SÓLO en el endpoint nuevo, dejando los dos viejos con sniffing.
- (c) Distinguir los 409 por otra cosa (un header, el status 422 para el no-op).

**Rationale**: primero lo verificado. El match actual es
`err.message.includes('own account')` (`UsersPanel.tsx:86`), y `err.message` sale de
`readErrorMessage()` (`auth.ts:48`), que lee el campo `error` del body. Los tres bodies que
van a existir en el endpoint nuevo son:

| Excepción | Status | Body `error` | `includes('own account')` | Clave i18n |
|---|---|---|---|---|
| `CannotManageSelfError` | 409 | `cannot change your own role` | **true** | `self` |
| `UserAlreadyHasRoleError` | 409 | `user already has that role` | false | `conflict` |

O sea que el mapeo existente **ya clasifica bien los dos 409 nuevos sin tocar una línea de
`actionErrorKey()`**, siempre que el body del self diga "own account" (que es la frase
natural: es la que ya usan los otros dos endpoints, 1483). El 409 nuevo no vuelve el
sniffing más frágil de lo que ya es: cae en el `else` que ya existe.

(a) es lo correcto en abstracto y es un cambio de contrato de API. Significa tocar los
bodies de los 6 endpoints de invitaciones y los 3 de usuarios para ser consistente (dejar la
mitad con `code` y la mitad sin es peor que no tenerlo), actualizar `readErrorMessage()`,
`ApiStatusError` (que hoy sólo lleva `status` y `message`, `auth.ts:36`), y todos los tests
de integración que assertean sobre el body. Es un refactor transversal de la superficie de
errores del backend disparado por un `includes()` en un componente de admin. Ese refactor
merece existir — y merece su propio change, con su propio proposal, exactamente como el
proposal ya decidió para el `>` de invitaciones. **Este change no es el vehículo.**

(b) es lo peor de los dos mundos: introduce el concepto sin adoptarlo. Un lector que abra
`actionErrorKey()` y vea `if (err.code) ... else if (err.message.includes(...))` no sabe
cuál es el camino bueno y cuál el legado, y el legado nunca se migra.

(c) es peor que el sniffing: un 422 para "ya tiene ese rol" miente sobre la semántica (el
payload es válido), y un header custom es un contrato igual de implícito que el texto, pero
además invisible en la respuesta.

**Mitigaciones concretas** (el acoplamiento se acota, aunque no se elimine):

1. El string discriminante deja de estar inline y pasa a constante de módulo en
   `UsersPanel.tsx`, con el comentario que nombra el acoplamiento:

```ts
/** El backend distingue sus dos 409 sólo por el TEXTO del body ({"error": ...});
 *  no hay código de error estable en el contrato. Ver design.md Decision 6:
 *  introducirlo es un refactor transversal de la superficie de errores y tiene
 *  que ser su propio change. Mientras tanto, el acoplamiento vive en UN lugar. */
const SELF_CONFLICT_MARKER = 'own account';
```

2. Test de integración que assertea el BODY LITERAL de los tres 409, no sólo el status —
   así, si alguien reescribe el mensaje en `main.py`, revienta un test del backend antes de
   romper silenciosamente una traducción del frontend.
3. Test de frontend que fabrica un `ApiStatusError(409, 'user already has that role')` y
   exige que llegue a la clave `conflict`, y otro con `'cannot change your own role'` que
   exija `self`.

Se registra en Open Questions como deuda técnica nombrada, no como descuido.

### Decision 7: Pregunta C — `sessionLost` se DISCRIMINA en dos claves: 401 y 403

**Choice**: se separan los dos casos que hoy comparten copy en `UsersPanel.tsx:137-138`:

```ts
// 401 = no hay sesión válida (expiró, la cookie se borró, la cuenta se
// desactivó). 403 = la sesión ES válida pero ya no alcanza: te degradaron
// mientras tenías la pestaña abierta. Con la revalidación de rol por request
// (design.md Decision 2) el 403 dejó de ser hipotético y "sesión expirada"
// sería mentira: la sesión está perfecta, lo que cambió sos vos.
const sessionExpired = error instanceof ApiStatusError && error.status === 401;
const accessRevoked = error instanceof ApiStatusError && error.status === 403;
```

y en el render, `sessionExpired ? t('sessionLost') : accessRevoked ? t('accessRevoked') : t('loadError')`.
Clave nueva: `admin.users.accessRevoked` (ES/EN, paridad obligatoria).

**Alternatives considered**:
- (a) Dejar `sessionLost` tal cual.
- (b) Reescribir `sessionLost` con un copy genérico que cubra los dos ("ya no podés ver esta
  lista; volvé a iniciar sesión").
- (c) Redirigir en caliente al login / a `/dashboard` ante 403.

**Rationale**: (a) queda directamente mal. El comentario del código (135-136) ya anticipa
*"un 403 acá también puede significar que TE desactivaron"* — pero antes de este change eso
era casi inalcanzable, porque una cuenta desactivada produce **401**, no 403 (`deps.py:109`
tira 401). El 403 en el listado hoy sólo puede venir de un rol insuficiente, que con el rol
en el JWT no cambiaba en caliente. Con la Decision 2, ese 403 pasa a ser el caso NORMAL de un
admin degradado con la pestaña abierta: la sesión está perfectamente viva y le decimos
"expiró". Es un mensaje que manda a la persona a re-loguearse, cosa que va a funcionar y no va
a arreglar nada — vuelve a entrar y sigue sin ver la pestaña. Diagnóstico falso que produce
una acción inútil.

(b) evita la mentira pero pierde la única información accionable que hay. Los dos casos
piden cosas OPUESTAS al usuario: ante 401 la acción correcta es "volvé a iniciar sesión"
(y funciona); ante 403 es "tu rol cambió, hablá con un administrador" (y re-loguearse es
inútil). Un copy que cubra los dos no puede recomendar ninguna, y termina siendo
"algo pasó".

(c) está fuera de alcance por decisión del proposal (el redirect en caliente es una
limitación preexistente del middleware, que sólo corre en navegación). Y es más grande de lo
que parece: un redirect automático ante cualquier 403 en cualquier panel es una política
global de la app, no una decisión de `UsersPanel`.

Costo: dos líneas de lógica y una clave i18n por idioma. Es el arreglo más barato de los tres
y el único que no miente.

**Copy propuesto** (`admin.users.accessRevoked`):
- ES: *"Tu rol cambió y ya no tenés permisos para ver esta lista. Si creés que es un error,
  contactá a un administrador."*
- EN: *"Your role changed and you no longer have permission to view this list. If you think
  this is a mistake, contact an administrator."*

Sin "volvé a iniciar sesión": sería el consejo equivocado y ya lo da `sessionLost`.

### Decision 8: El selector de rol es un `<select>` NATIVO, y el filtro es `<` ESTRICTO

**Choice**: `<select>` nativo (no Radix), poblado con `grantableRoles`, y el `onChange` NO
aplica el cambio: abre el `AlertDialog`.

**Alternatives considered**:
- (a) `@radix-ui/react-select` (agregar la dependencia y un `components/ui/select.tsx`).
- (b) `DropdownMenu` de Radix, que sí existe en `dashboard/components/ui/`.
- (c) Botones de acción por rol (un botón "Promover a moderador", otro "Degradar a viewer").

**Rationale**: verificado — NO hay componente `Select` en `dashboard/components/ui/`
(hay alert-dialog, badge, button, card, dialog, dropdown-menu, input, separator, sheet,
sidebar, skeleton, tooltip) y `@radix-ui/react-select` sólo figura como dependencia
transitiva. El proyecto ya resolvió exactamente este problema en `InvitationsPanel.tsx`
(~306-318), con un `<select>` nativo y un comentario que explica el porqué. (b) está
descartado por evidencia propia del proyecto: el `DropdownMenu` de Radix pelea con inputs
porque su typeahead se come las teclas (memoria del proyecto: "Un input dentro de un
DropdownMenu de Radix no deja escribir"). (a) es sumar una dependencia y un componente
nuevo para replicar lo que el `<select>` nativo ya hace, con mejor accesibilidad y soporte
móvil gratis. (c) explota: con 4 roles son hasta 3 botones por fila en una tabla que ya
tiene email, rol, badges de origen, fecha, estado y el botón de desactivar.

**El filtro — LA trampa del change.** `grantableRoles` en `InvitationsPanel.tsx:145` usa:

```ts
ROLE_LEVEL[r] <= ROLE_LEVEL[user.role]   // ← invitaciones (hoy, con <=)
```

Copiar ese memo verbatim es la falla más probable de este change: viola la decisión 1 en
silencio, no rompe ningún test existente, y un admin vería "admin" entre las opciones. Acá
es **estrictamente menor**:

```ts
/** Roles asignables por el actor: ESTRICTAMENTE menores al suyo (decisión 1,
 *  y la regla que ROLE_LEVEL documenta en src/models/user.py desde
 *  multi-user-auth). OJO: NO es el mismo filtro que grantableRoles de
 *  InvitationsPanel (línea 145), que usa `<=` — invitar y asignar tienen hoy
 *  reglas distintas. Ver design.md Decision 10. */
const assignableRoles = React.useMemo(
  () => ROLE_ORDER.filter((r) => ROLE_LEVEL[r] < ROLE_LEVEL[actorRole]),
  [actorRole],
);
```

Con un test que lo clave: *un admin NO ve "admin" ni "superadmin" entre las opciones*. Y se
dice en voz alta lo que ya dice el proposal: **la UI no es el enforcement**. El backend
rechaza igual con 403 (guard 5); no ofrecer lo imposible es UX.

**Filas sin selector**: una fila cuyo `disabledReasonFor()` devuelve `'self'` o
`'hierarchy'` no muestra `<select>` habilitado — se renderiza deshabilitado con el mismo
contrato de a11y que ya usa el botón de desactivar (`title` + `sr-only` +
`aria-describedby`, 289-294 y 340-344). Reusa `disabledReasonFor()` (98) tal cual, sin
tocarla: la regla de "a quién puedo gestionar" es la misma; lo que este change agrega es
"qué le puedo asignar", que es el otro eje.

### Decision 9: Confirmación SIEMPRE, con el `<select>` como estado controlado que revierte al cancelar

**Choice**: el `<select>` es controlado y su valor es SIEMPRE `user.role` (el dato del
servidor). El `onChange` no muta nada: guarda el rol pedido en un estado
`pendingChange: { userId, from, to } | null` que abre el `AlertDialog`. Cancelar limpia el
estado y el `<select>` vuelve solo a mostrar `user.role`, porque nunca dejó de mostrarlo.

**Alternatives considered**:
- (a) `<select>` no controlado (`defaultValue`) y revertir el DOM a mano al cancelar.
- (b) Confirmar sólo al degradar (la recomendación clásica).
- (c) Estado local del valor del select + `useEffect` que lo sincroniza con `data`.

**Rationale**: (b) está cerrado por la decisión 6 del usuario y la razón es buena: es una
acción sobre PERMISOS y un click errado no debe cambiar quién administra el sistema.
Agrego una razón técnica: con un `<select>`, "degradar" y "promover" son el MISMO gesto (un
click y una tecla), así que una confirmación condicional le enseña al usuario que el gesto a
veces confirma y a veces no. La fricción inconsistente es peor que la fricción.

(a) y (c) son la misma trampa con dos caras: cualquier diseño donde el `<select>` tenga
estado propio necesita re-sincronizarse contra el servidor después del `mutate()` de SWR, y
esa sincronización es exactamente el bug clásico (el select se queda mostrando el rol nuevo
cuando el backend rechazó con 409, o parpadea al revés). Manteniéndolo controlado sobre
`user.role`, el select **no puede** desincronizarse: es una función pura del dato del
servidor. El único estado nuevo es `pendingChange`, que es del diálogo, no del select.

El `AlertDialog` nombra los dos extremos, no sólo el destino: *"Vas a cambiar el rol de
`<email>` de **viewer** a **moderador**"*, con `t.rich` y el `email` en `font-mono`, igual
que `deactivateDialogDescription` (385-388). El "de X" es el que permite cancelar cuando uno
se equivocó de FILA, no de rol.

Al confirmar: `setBusyId(target.id)`, `changeUserRole()`, `mutate()`, y el mismo `finally`
que las otras dos acciones (152-154). El fallo va al `outcome` existente con
`actionErrorKey(err, 'roleGeneric')` — clave de fallback nueva, mismo mecanismo.

### Decision 10: Alinear invitaciones a `>=` (decisión 8 del usuario) en un commit propio y aislado

**Choice**: `src/services/invitation_service.py:251` pasa de
`if role_level(role) > role_level(invited_by.role)` a
`if role_level(role) >= role_level(invited_by.role)`. Es un cambio de comportamiento en
producción, consciente y aprobado por el usuario.

**Alternatives considered**: dejarlo fuera de alcance (lo que decía el proposal antes de la
decisión 8 del usuario); alinear al revés, bajando la asignación a `>`.

**Rationale**: alinear al revés está descartado — sería debilitar el control nuevo para
igualar al viejo, y la regla que `ROLE_LEVEL` documenta desde `multi-user-auth`
(`user.py:38-41`) es la ESTRICTA. El `>` de invitaciones es el que está mal respecto de su
propia documentación, no al revés.

Dejar la asimetría era defendible mientras "asignar rol" no existía. Con este change existe,
y la incoherencia se vuelve absurda y explotable como bypass de intención: un admin no
podría ASIGNARLE admin a un usuario existente (403 por el guard 5) pero SÍ podría invitar a
esa misma persona con rol admin a un email nuevo. Mismo resultado, distinta puerta. Un
control que se rodea cambiando de endpoint no es un control.

**Impacto real, acotado**: el único comportamiento que se pierde es "un admin invita a otro
admin". Superadmin invitando admin sigue funcionando (3 > 2). Admin invitando
moderador/viewer sigue funcionando. Las invitaciones YA EMITIDAS no se tocan: el guard está
en la creación, no en el canje, así que una invitación admin-a-admin pendiente se sigue
aceptando. Sin migración, sin backfill.

**Cómo se despliega** (esto es lo que lo hace seguro):
1. Commit propio, aislado, con el mensaje diciendo que es un cambio de comportamiento en
   producción.
2. Antes de mergear, verificar contra la base de producción cuántos admins hay y si alguno
   depende de este flujo. Query de una línea, `psql` contra el `timescaledb` (**puerto
   5433**, en 5432 hay un Postgres nativo de macOS que no es el del proyecto).
3. `CannotInviteHigherRoleError` (115) **conserva el nombre y el mensaje**: sólo cambia el
   operador. Cambiar el nombre a `...HigherOrEqual...` sería más honesto, pero es otro
   rename transversal por un carácter; se documenta en el docstring, que sí se actualiza.
4. El test existente que cubra "admin invita a admin → OK" hay que **invertirlo**, no
   borrarlo: pasa a exigir 403. Es la evidencia de que el cambio es deliberado.

## Data Flow

Cambio de rol y su efecto inmediato en las sesiones vivas:

    Admin (UI, /admin/access?tab=users)
      │  <select> onChange → pendingChange → AlertDialog → confirmar
      │  POST /auth/users/{id}/role  {"role": "moderador"}
      ▼
    require_min_role(ADMIN) ──403──> viewer/moderador
      │
      ▼
    AuthService.change_user_role(actor, target_id, new_role)
      │
      ├─ _load_manageable_target()  [SELECT ... FOR UPDATE]
      │    ├─ self? ──────────────────────────── 409  CannotManageSelfError
      │    ├─ not found? ─────────────────────── 404  UserNotFoundError
      │    └─ level(target) >= level(actor)? ─── 403  CannotManageHigherOrEqualRole
      │
      ├─ target.role == SUPERADMIN? ──────────── 403  CannotChangeSuperadminRole
      ├─ level(new_role) >= level(actor)? ────── 403  CannotAssignHigherOrEqualRole
      ├─ target.role == new_role? ────────────── 409  UserAlreadyHasRole
      │
      └─ UPDATE users SET role = $2 WHERE id = $1
                     │
                     ▼  204 (sin cuerpo) → SWR mutate() → lista refrescada
                     │
                     ▼  y en el request SIGUIENTE de la víctima, sin re-login:

    Request cualquiera con la cookie session (token con role="admin")
      │
      ▼
    get_current_user()
      ├─ decode_access_token() → CurrentUser(role=admin)   ← del JWT, STALE
      ├─ get_user_auth_state(id) → SELECT role, deactivated_at ... WHERE id=$1
      │      ├─ is_active False / role None ──────────────── 401
      │      └─ role = "viewer"                             ← la VERDAD
      └─ return current_user.model_copy(update={"role": viewer})
                     │
                     ▼
              require_min_role(ADMIN): level(viewer)=0 < level(admin)=2 → 403

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `deploy/sql/migrations/` | **Sin cambios** | `users.role` (001) y su `CHECK` (002:17-18) ya existen |
| `src/models/user.py` | Modify | `RoleChangeRequest` nuevo. `UserProfileUpdate` (228) NO se toca — excluye `role` a propósito (233-238) |
| `src/services/auth_service.py` | Modify | Rename `CannotDeactivateSelfError`→`CannotManageSelfError`; `CannotChangeSuperadminRoleError`, `CannotAssignHigherOrEqualRoleError`, `UserAlreadyHasRoleError`; `UserAuthState` + `get_user_auth_state()`; `is_user_active()` reimplementado (firma intacta); `change_user_role()` |
| `src/services/invitation_service.py` | Modify | Línea 251: `>` → `>=` (Decision 10, commit aislado) + docstring |
| `src/api/deps.py` | Modify | `get_current_user()` (40) usa `get_user_auth_state()` y SOBRESCRIBE `role`. `get_current_user_optional()` (118) y `require_min_role()` (195) sin cambios |
| `src/main.py` | Modify | `POST /auth/users/{user_id}/role` (204 + `response_model=None`); imports y `except` del rename en 1477/1532 |
| `dashboard/lib/types.ts` | Modify | `RoleChangePayload`; `ROLE_ORDER` para poblar el select (`UserRole` 116 y `ROLE_LEVEL` 120 ya existen) |
| `dashboard/lib/auth.ts` | Modify | `changeUserRole(userId, role)`, clon de `deactivateUser` (464) + body JSON + `Content-Type` |
| `dashboard/components/admin/UsersPanel.tsx` | Modify | Columna con `<select>` nativo, `assignableRoles` con `<` estricto, `pendingChange` + `AlertDialog`, `SELF_CONFLICT_MARKER`, `accessRevoked` |
| `dashboard/messages/{es,en}.json` | Modify | `admin.users.role*`, `accessRevoked`, `errors.roleGeneric`; `admin.roles.*` se reusa |
| `tests/unit/test_user_management.py` | Modify | Guards, orden de guards, superadmin por excepción específica, concurrencia |
| `tests/unit/test_deps.py` | Modify | El fake (75) suma `get_user_auth_state`; test de sobrescritura del rol |
| `tests/integration/test_users_api.py` | Modify | Endpoint nuevo en `PROTECTED_ENDPOINTS` (44-48); matriz por API directa; degradación en caliente |
| `tests/integration/test_invitations_api.py` | Modify | Invertir el test de admin-invita-admin (Decision 10) |
| `dashboard/components/admin/UsersPanel.test.tsx` | Modify | Opciones del select, confirmación, cancelar, 409/403, `accessRevoked` |

## Interfaces / Contracts

```python
# src/models/user.py
class RoleChangeRequest(BaseModel):
    """Body de POST /auth/users/{user_id}/role.

    Modelo propio y no `UserProfileUpdate` (228): ese excluye `role` a
    propósito y lo documenta (233-238) — el rol es una decisión de
    administración sobre OTRO usuario, no un campo del perfil propio.
    Pydantic valida contra el enum: un rol inexistente es 422, no un guard.
    """
    role: UserRole
```

```python
# src/services/auth_service.py

@dataclass(frozen=True)
class UserAuthState:
    is_active: bool
    role: Optional[UserRole]        # None si y sólo si la fila no existe

class CannotManageSelfError(Exception): ...              # 409 (renombrada)
class CannotChangeSuperadminRoleError(Exception): ...    # 403 (guard dedicado)
class CannotAssignHigherOrEqualRoleError(Exception): ... # 403 (rol PEDIDO vs actor)
class UserAlreadyHasRoleError(Exception): ...            # 409 (no-op explícito)

async def get_user_auth_state(self, user_id: UUID) -> UserAuthState: ...
async def is_user_active(self, user_id: UUID) -> bool: ...   # FIRMA INTACTA
async def change_user_role(
    self, actor: CurrentUser, target_id: UUID, new_role: UserRole
) -> None: ...
```

Matriz completa de status (contrato para tests y frontend):

| Situación | `GET /auth/users` | `deactivate` | `reactivate` | **`role` (nuevo)** |
|---|---|---|---|---|
| sin sesión | 401 | 401 | 401 | **401** |
| viewer / moderador | 403 | 403 | 403 | **403** |
| rol del body inexistente | — | — | — | **422** (Pydantic) |
| ok | 200 `[UserListItem]` | 204 | 204 | **204 sin cuerpo** |
| target == actor | — | 409 | 409 | **409** `cannot change your own role` |
| target inexistente | — | 404 | 404 | **404** `user not found` |
| `level(target) >= level(actor)` | — | 403 | 403 | **403** `cannot manage a user with an equal or higher role` |
| target es superadmin | — | 403 (emergente) | 403 (emergente) | **403** `cannot change the role of a superadmin` (dedicado) |
| `level(new_role) >= level(actor)` | — | — | — | **403** `cannot assign a role equal to or higher than your own` |
| target ya tiene ese rol | — | 409 | 409 | **409** `user already has that role` |

Detalle no negociable del endpoint — `response_model=None`:

```python
@app.post(
    "/auth/users/{user_id}/role",
    status_code=status.HTTP_204_NO_CONTENT,
    # OBLIGATORIO, ver el comentario de deactivate_user() (main.py:1451-1456):
    # sin esto FastAPI infiere el response_model desde la anotación de retorno
    # (Optional[JSONResponse]), concluye que la ruta tiene cuerpo y revienta al
    # IMPORTAR el módulo con "Status code 204 must not have a response body".
    # mypy no lo ve; el primer test que levanta la app, sí.
    response_model=None,
    tags=["auth"],
)
async def change_user_role(
    user_id: UUID,
    payload: RoleChangeRequest,
    admin: CurrentUser = Depends(require_min_role(UserRole.ADMIN)),
    auth_service: AuthService = Depends(_get_auth_service),
) -> Optional[JSONResponse]: ...
```

Un `except` por excepción de dominio, cada uno con
`requests_total.labels(endpoint="/auth/users/{id}/role", status="...")` de label **literal**
(nunca el UUID interpolado, `main.py:1425-1427`), devolviendo
`JSONResponse(status_code=..., content={"error": "..."})`. El camino feliz incrementa `204` y
hace `return None` explícito (1504-1509).

```ts
// dashboard/lib/types.ts
export const ROLE_ORDER: UserRole[] = ['superadmin', 'admin', 'moderador', 'viewer'];
export interface RoleChangePayload { role: UserRole }

// dashboard/lib/auth.ts
export async function changeUserRole(userId: string, role: UserRole): Promise<void>;
// POST, credentials: 'include', Content-Type: application/json,
// body JSON.stringify({ role }), ApiStatusError vía readErrorMessage() (48)
```

## Por qué NO hace falta un guard de "último superadmin"

`LastSuperadminError` (`auth_service.py:106`) existe porque `delete_account()` sí puede
dejar el sistema sin superadmins, y `_determine_bootstrap_role()` (341) existe para poder
recrear uno si eso pasara. La pregunta legítima es si `change_user_role()` necesita algo
equivalente. **No**, y el argumento es que las decisiones 2 y 4 juntas hacen el lockout
inalcanzable por construcción:

- **Un superadmin no puede ser degradado por nadie** (decisión 2 / guard 4): el guard es
  dedicado y no depende de la aritmética de `ROLE_LEVEL`. No hay actor — ni siquiera otro
  superadmin — que pueda bajarle el rol a un superadmin.
- **Nadie puede cambiarse el rol a sí mismo** (decisión 4 / guard 1): el único que podría
  querer auto-degradarse tampoco puede.

O sea: para que el sistema se quede sin superadmins vía cambio de rol, haría falta degradar
a un superadmin, y las dos únicas puertas posibles (otro actor / uno mismo) están cerradas
con guards explícitos. El conjunto de superadmins **no puede achicarse por este endpoint**.

Es el mismo tipo de argumento que ya hizo `user-management`
(`CannotManageHigherOrEqualRoleError`, docstring 147-149: *"nadie puede desactivar a un
superadmin ... lo que hace innecesario un guard de 'último superadmin' acá"*), pero **más
fuerte**: aquel dependía de que `SUPERADMIN` fuera el máximo de `ROLE_LEVEL`; éste
descansa en un guard escrito, que sobrevive a un refactor de la tabla de niveles.

Se dice explícito para que nadie lea la ausencia del guard como un olvido: **es una
consecuencia demostrada, no una omisión.** Y si algún día se levantara el guard de
superadmin, este párrafo es el que avisa que hay que reintroducir el de último superadmin
en el mismo commit.

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (Postgres real) | Los 6 guards de `change_user_role()` **y su ORDEN**: para cada par de guards que puedan dispararse juntos, exigir la excepción del más específico. Casos clave: target superadmin y actor superadmin → `CannotChangeSuperadminRoleError` (NO `CannotManageHigherOrEqualRoleError`); target inexistente + rol pedido inválido → 404, NO 403 | `tests/unit/test_user_management.py` con `db_pool`/`_migrated` (testcontainers). Los mocks de asyncpg son ciegos al SQL — lección documentada del proyecto ("verificar contra la base, no con mocks") |
| Unit (Postgres real) | Concurrencia: dos cambios simultáneos al mismo target se serializan por el `FOR UPDATE` (1280); si piden el mismo rol, exactamente uno gana y el otro sale 409 | Patrón de `test_two_concurrent_deactivations_leave_exactly_one_winner` (294) |
| Unit (Postgres real) | `get_user_auth_state()`: activa+rol, desactivada+rol, fila inexistente → `(False, None)`. Y que `is_user_active()` siga devolviendo lo mismo que antes en los tres casos (no-regresión de la reimplementación) | Extender el bloque de `is_user_active` que ya existe en el archivo |
| Unit | **El test que decide el change**: `get_current_user()` devuelve un `CurrentUser` cuyo `.role` es el de la BASE cuando difiere del token. Assert sobre el VALOR devuelto, no sobre "no tiró excepción" — una implementación que compare y levante 401 tiene que FALLAR este test | `tests/unit/test_deps.py`; el fake (75) suma `async def get_user_auth_state(...) -> UserAuthState` devolviendo valores CONCRETOS (`UserRole.VIEWER`), **nunca** `MagicMock` (precedente: 65 tests rotos en `user-management` por truthy) |
| Unit | Promoción en caliente: token con `viewer`, base con `moderador` ⇒ el `CurrentUser` sale `moderador` y `require_min_role(MODERADOR)` deja pasar. Este caso es el que mata la alternativa "comparar y 401" | Mismo archivo |
| Integration | Endpoint nuevo agregado a `PROTECTED_ENDPOINTS` (`test_users_api.py:44-48`) — el sweep parametrizado de 401/403 lo cubre solo | Agregar `("post", f"/auth/users/{uuid4()}/role")` a la lista |
| Integration | Matriz completa por API DIRECTA (no por botón deshabilitado): admin pidiendo `admin` → 403; cualquiera contra un superadmin → 403; auto-cambio → 409; no-op → 409; rol inventado en el body → 422 | Patrón híbrido documentado en 17-24: `AuthService` REAL contra Postgres real, sólo se parchean `decode_access_token`/`decode_token_payload`; *"is_user_active NO se mockea nunca"* |
| Integration | **Degradación en caliente end-to-end**: emitir sesión admin, degradar a viewer por la base, y exigir **403** (no 401, no 200) en el request siguiente a un endpoint `require_min_role(ADMIN)`, sin re-login | Mismo archivo. Es el criterio de éxito literal del proposal |
| Integration | Bodies LITERALES de los tres 409/403 nuevos (no sólo el status): el frontend discrimina por texto (Decision 6), así que el string es contrato de facto y tiene que romper acá primero | Assert sobre `response.json()["error"]` |
| Integration | Invitaciones: invertir el test de "admin invita a admin" → ahora 403 (Decision 10) | `tests/integration/test_invitations_api.py` |
| Integration | **Barrido de fakes**: confirmar que `test_locale_api.py` y `test_areas_api.py` no definan su propio fake de `is_user_active`; si lo hacen, siguen funcionando (firma intacta) pero hay que verificarlo, no asumirlo | `rg -n "is_user_active\|get_user_auth_state" tests/` |
| Frontend | Un admin NO ve `admin` ni `superadmin` entre las opciones del select (el test que atrapa el copy-paste de `<=`); un superadmin sí ve `admin` | Vitest + Testing Library, patrón de `UsersPanel.test.tsx` (mockea `@/lib/auth` con `importActual` manteniendo `ApiStatusError` REAL; SWR con cache fresca por test) |
| Frontend | Toda selección abre el `AlertDialog`, promoción Y degradación; cancelar NO llama a la API y el select vuelve a mostrar el rol original; confirmar llama a `changeUserRole` con el rol correcto | Mismo archivo |
| Frontend | `ApiStatusError(409, 'user already has that role')` → clave `conflict`; `ApiStatusError(409, 'cannot change your own role')` → clave `self`; 403 → `hierarchy` | Los strings vienen del backend: si cambian allá, este test y el de integración se rompen juntos |
| Frontend | Error 403 en la CARGA de la lista muestra `accessRevoked`, no `sessionLost`; 401 sigue mostrando `sessionLost` | Decision 7 |
| Frontend | Paridad ES/EN con las claves nuevas | `dashboard/messages/parity.test.ts` (corre solo, falla también con valores vacíos) |

Verificación: `pytest`, `vitest` y `tsc --noEmit`. **Nunca `npm run build`.** Postgres local
del proyecto en el **puerto 5433** (container `timescaledb`, base y usuario `seismic`); en
5432 hay un Postgres nativo de macOS que NO es el del stack. Los tests con testcontainers
levantan su propio container, pero cualquier verificación manual va a 5433.

## Migration / Rollout

1. **Sin migración de base.** No hay DDL en este change (`users.role` desde la 001, `CHECK`
   en la 002:17-18). Nada que aplicar, nada que revertir.
2. **Orden de commits**, y este orden importa:
   1. Rename mecánico `CannotDeactivateSelfError` → `CannotManageSelfError` (Decision 5).
      Aislado, sin lógica nueva, tests verdes.
   2. Lector: `UserAuthState` + `get_user_auth_state()` + `is_user_active()` reimplementado
      + `get_current_user()` sobrescribiendo. Con sus tests.
   3. Escritor: excepciones, `change_user_role()`, endpoint. Con sus tests.
   4. Frontend: `changeUserRole()`, selector, diálogo, i18n.
   5. Invitaciones `>` → `>=` (Decision 10), aislado y con el test invertido.
3. **Orden de deploy**: backend primero, dashboard después. Si el dashboard llegara antes,
   el select existiría y el POST devolvería 404 — feo pero no destructivo, y el `outcome`
   del panel lo muestra como error de acción sin romper la lista.
4. **El deploy del lector y el del escritor van JUNTOS.** Ya está en el Rollback Plan del
   proposal y se repite acá porque es la trampa: desplegar sólo el escritor produce cambios
   de rol que tardan hasta 24 h en tener efecto, con la UI afirmando que ya cambió. Peor que
   no tener la feature.
5. **Sin feature flag.** La superficie nueva está gateada por `require_min_role(ADMIN)`.
   Para un no-admin el único cambio observable es la sobrescritura del rol en
   `get_current_user()`, que es transparente mientras su rol no cambie.
6. **Efecto secundario del deploy, esperado**: en cuanto sale a producción, cualquier
   divergencia PREEXISTENTE entre el rol del JWT y el de la base (por un `UPDATE` manual
   hecho a mano en algún momento) se vuelve efectiva de inmediato. Es exactamente lo que
   queremos, pero conviene mirar la tabla `users` contra los tokens vivos antes de
   desplegar, para no sorprenderse.
7. **Verificación en producción**: promover una cuenta de prueba de viewer a moderador y
   confirmar acceso inmediato sin re-login; degradarla y confirmar el 403 inmediato con la
   pestaña abierta (y que el copy que aparece sea `accessRevoked`, no `sessionLost`).

## Open Questions

- [ ] **Código de error estable en el body de la API** (`{"error": ..., "code": ...}`).
      Decision 6 lo difiere a un change propio por ser un refactor transversal de la
      superficie de errores (9 endpoints, `ApiStatusError`, `readErrorMessage()` y sus
      tests). Queda como deuda técnica NOMBRADA: mientras tanto, `SELF_CONFLICT_MARKER`
      concentra el acoplamiento en un solo lugar y los tests de integración clavan los
      bodies literales.
- [ ] **Renombrar `CannotInviteHigherRoleError`** a `CannotInviteHigherOrEqualRoleError`
      después de la Decision 10: el nombre queda parcialmente desactualizado (ahora también
      rechaza el igual). Se difiere para no meter otro rename transversal en este change;
      el docstring sí se actualiza.
- [ ] Ninguna que BLOQUEE la implementación.
