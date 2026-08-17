# Delta for Invitations (role-management)

Delta sobre el dominio de invitaciones establecido por `email-invitations`
(`openspec/changes/email-invitations/specs/auth/spec.md`).

Va en un archivo propio y no dentro de `auth/spec.md` por una razón de honestidad del
artefacto: este NO es comportamiento nuevo, es un **cambio de comportamiento en un flujo
que ya está en producción**. Mezclarlo con las requirements ADDED del cambio de rol lo
escondería. Un revisor que quiera saber "¿qué se rompe de lo que hoy funciona?" tiene que
poder leerlo en un solo lugar.

## Contexto: la asimetría que este delta cierra

El sistema tiene DOS puertas por las que se decide quién termina con el rol X:

1. **Invitar** — `POST /auth/invitations`. Guard actual
   (`src/services/invitation_service.py:251`): `role_level(role) > role_level(invited_by.role)`,
   comparación ESTRICTA con `>`, o sea que se permite invitar al PROPIO nivel. Hoy, en
   producción, **un admin puede invitar a otro admin**, y un superadmin puede invitar a
   otro superadmin.
2. **Ascender** — `POST /auth/users/{id}/role`, que este change introduce con jerarquía
   estricta (`>=` rechaza): solo se asignan roles de nivel ESTRICTAMENTE MENOR al propio.

Dejar las dos puertas con reglas distintas convierte la regla de escalación en una
formalidad: un admin al que se le prohíbe promover a alguien a admin puede lograr el mismo
resultado invitando una cuenta nueva con rol admin. Este delta las alinea en la regla más
restrictiva: **solo un superadmin crea admins, por cualquiera de las dos puertas.**

Es un cambio consciente y aprobado, no un descubrimiento colateral. Tiene consecuencias
operativas reales (ver [Requirement: Impacto operativo]).

## MODIFIED Requirements

### Requirement: Creación de invitación

El sistema MUST exponer `POST /auth/invitations`, protegido con rol mínimo `admin`, que
crea una invitación con `email` y `role` (restringido al enum `UserRole`). La respuesta de
creación MUST incluir el token en claro — la única vez que el sistema lo devuelve (junto
con el reenvío). La invitación MUST tener `expires_at`, con default de 7 días.

**El rol asignado a la invitación MUST ser de nivel ESTRICTAMENTE MENOR al rol de quien la
crea.** Invitar con un rol de nivel IGUAL o SUPERIOR al propio MUST rechazarse con 403.
Un `admin` invita como máximo a un `moderador`; solo un `superadmin` invita admins; y
NADIE invita superadmins.

(Previously: el guard comparaba con `>` estricto — "el rol invitado MUST NOT ser de nivel
SUPERIOR al de quien invita" — lo que permitía invitar al propio nivel: un admin podía
invitar a otro admin y un superadmin a otro superadmin.)

El resto del contrato de creación (token en claro una sola vez, expiración, locale,
rechazo por email ya registrado, rechazo por invitación pendiente duplicada, lock
advisory por email) MUST NOT cambiar. El guard de jerarquía MUST seguir evaluándose ANTES
de tocar la base: una invitación rechazada MUST NOT dejar ninguna fila.

#### Scenario: Un admin YA NO puede invitar a otro admin

- GIVEN un `admin` autenticado
- WHEN hace `POST /auth/invitations` con `{"email": "nueva@example.com", "role": "admin"}`
- THEN el sistema responde 403 con `{"error": ...}`
- AND no se crea ninguna fila en `invitations`
- AND no se envía ningún email

(Este es el escenario que cambia de resultado: hoy en producción responde 201.)

#### Scenario: Un superadmin YA NO puede invitar a otro superadmin

- GIVEN un `superadmin` autenticado
- WHEN hace `POST /auth/invitations` con `{"role": "superadmin"}`
- THEN el sistema responde 403
- AND no se crea ninguna fila

(Este escenario también cambia de resultado: hoy responde 201. Consecuencia: el segundo
superadmin del sistema ya no se crea por invitación — ver [Requirement: Impacto
operativo].)

#### Scenario: Un superadmin sí puede invitar a un admin

- GIVEN un `superadmin` autenticado
- WHEN hace `POST /auth/invitations` con `{"email": "admin@example.com", "role": "admin"}`
- THEN el sistema responde 201 con el token en claro

#### Scenario: Un admin sigue pudiendo invitar moderadores y viewers

- GIVEN un `admin` autenticado
- WHEN hace `POST /auth/invitations` con `role` en `{moderador, viewer}`
- THEN el sistema responde 201 en ambos casos (sin regresión: son niveles estrictamente
  menores)

#### Scenario: Un admin no puede invitar superadmins

- GIVEN un `admin` autenticado
- WHEN hace `POST /auth/invitations` con `{"role": "superadmin"}`
- THEN el sistema responde 403 (comportamiento ya existente, preservado)

#### Scenario: Las dos puertas dan el mismo veredicto

- GIVEN un actor de rol R y un rol solicitado X
- WHEN se evalúa "¿puede el actor conseguir que alguien tenga el rol X?" por la puerta de
  invitación Y por la de cambio de rol
- THEN ambas responden lo mismo: permitido si y solo si
  `role_level(X) < role_level(R)`

### Requirement: Alineación de la suite de tests existente de invitaciones

Los tests que HOY afirman el comportamiento viejo MUST actualizarse para afirmar el nuevo,
no eliminarse: la aserción se invierte, la cobertura se conserva. Como mínimo MUST
revisarse los casos que hoy verifican que un admin puede invitar a su propio nivel y que
un superadmin puede invitar a otro superadmin, tanto en la suite unitaria del servicio de
invitaciones como en la de integración de la API.

Un test que quede en verde por accidente tras el cambio (porque parametriza roles y el
caso límite se diluye) MUST desdoblarse para que el caso "propio nivel" quede afirmado de
forma explícita.

#### Scenario: El test de "admin invita a su propio nivel" queda invertido

- GIVEN el test unitario que hoy afirma que un admin puede invitar con roles
  `{admin, moderador, viewer}`
- WHEN se aplica este change
- THEN el caso `admin` afirma el rechazo por escalación y los casos `moderador`/`viewer`
  siguen afirmando el éxito

#### Scenario: El test de "superadmin invita superadmin" queda invertido

- GIVEN los tests (unitario y de integración) que hoy afirman 201 al invitar
  `role="superadmin"` siendo superadmin
- WHEN se aplica este change
- THEN afirman el rechazo por escalación

#### Scenario: La suite completa queda verde

- GIVEN la suite de invitaciones actualizada
- WHEN corre `pytest`
- THEN pasa sin tests borrados ni tests marcados como skip para esconder el cambio

### Requirement: Impacto operativo del endurecimiento

El endurecimiento MUST documentarse con su consecuencia práctica, porque cambia el
procedimiento de una operación real: **crear un superadmin adicional ya no es posible por
ninguna vía de la aplicación.** Ni por invitación (403 por nivel igual) ni por cambio de
rol (403 por nivel igual). El único camino que queda es el mismo que existía antes de todo
esto: un `UPDATE` manual contra la base, o el bootstrap del primer usuario.

Esto MUST ser una decisión explícita y no un efecto colateral descubierto en producción.
La UI MUST reflejarlo (ver el delta de dashboard-ui: el rol `superadmin` desaparece del
selector de invitación para todos los actores).

#### Scenario: Ningún actor puede fabricar un superadmin por la aplicación

- GIVEN cualquier actor autenticado, incluido un `superadmin`
- WHEN intenta crear un superadmin por invitación o por cambio de rol
- THEN el sistema responde 403 en ambos casos
- AND el sistema conserva al menos el superadmin existente (el guard de "último
  superadmin" de `DELETE /account` sigue siendo la protección contra quedarse sin ninguno)
