# Account Settings Specification — Perfil extendido, 2FA TOTP, Exportar datos, Borrar cuenta

## Purpose

Especifica el comportamiento del menú de "Configuración de cuenta" (`/account/*` y `/auth/2fa/*` en backend, ruta `dashboard/app/settings/` en frontend) introducido por este change, para un usuario ya autenticado por el sistema existente (`multi-user-auth` + `google-oauth`, ambos ya archivados): gestión de perfil personal opcional, autenticación de dos factores vía TOTP con backup codes, exportación de los propios datos de cuenta, y eliminación de la propia cuenta.

No existe un `openspec/specs/account-settings/spec.md` ni un `openspec/specs/auth/spec.md` previos en `openspec/specs/` (confirmado por inspección: los changes previos `multi-user-auth` y `google-oauth` nunca fusionaron sus specs de dominio `auth` al directorio de specs principal). Este documento se redacta como spec completa (no delta) del dominio `account-settings`, acotada al alcance de este change según `proposal.md` y sus 5 Decisiones Cerradas. No re-especifica ni modifica los requirements ya cubiertos por `openspec/changes/multi-user-auth/specs/auth/spec.md` ni `openspec/changes/google-oauth/specs/auth/spec.md` (registro, login, logout, `/auth/me`, roles jerárquicos, bootstrap de superadmin, expiración de sesión, cookie httpOnly, OAuth de Google) — ver Requirement: No regresión sobre login/registro/OAuth existente.

## Requirements

### Requirement: Consulta del perfil extendido propio

El sistema MUST exponer `GET /account/profile`, protegido por `Depends(get_current_user)`, que devuelva los campos de perfil extendido del usuario autenticado (nombre editable, domicilio, teléfono, y cualquier otro campo de perfil opcional agregado por este change). El sistema MUST responder 401 si no hay sesión válida, con el mismo comportamiento que el resto de los endpoints protegidos del sistema.

#### Scenario: Usuario autenticado consulta su perfil con todos los campos completos

- GIVEN un usuario autenticado con perfil completo (`nombre`, `domicilio`, `telefono` todos con valor)
- WHEN se hace `GET /account/profile` con una cookie `session` válida
- THEN la respuesta HTTP es 200
- AND el body contiene los valores actuales de `nombre`, `domicilio` y `telefono`

#### Scenario: Usuario autenticado consulta su perfil sin haberlo completado nunca

- GIVEN un usuario autenticado que nunca completó ningún campo de perfil extendido
- WHEN se hace `GET /account/profile` con una cookie `session` válida
- THEN la respuesta HTTP es 200
- AND todos los campos de perfil extendido (`nombre`, `domicilio`, `telefono`) son `null`, sin error

#### Scenario: Usuario no autenticado recibe 401

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `GET /account/profile`
- THEN la respuesta HTTP es 401

### Requirement: Edición del perfil extendido propio

El sistema MUST exponer `PATCH /account/profile`, protegido por `Depends(get_current_user)`, que permita actualizar de forma parcial los campos de perfil extendido del usuario autenticado (nombre editable, domicilio, teléfono). Todos los campos MUST ser opcionales tanto en el request como en el estado persistido — un usuario MUST poder completar solo alguno de ellos, dejar el resto en blanco, o no enviar ningún campo. El sistema MUST NOT permitir que este endpoint modifique `role`, `email`, `password_hash`, ni ningún otro campo de seguridad de la cuenta.

#### Scenario: Usuario completa su perfil por primera vez con todos los campos

- GIVEN un usuario autenticado con perfil vacío (`nombre`, `domicilio`, `telefono` todos `null`)
- WHEN se hace `PATCH /account/profile` con `{"nombre": "Ana Gómez", "domicilio": "Av. Siempre Viva 742", "telefono": "+54 9 11 5555-5555"}`
- THEN la respuesta HTTP es 200
- AND una llamada posterior a `GET /account/profile` devuelve esos tres valores actualizados

#### Scenario: Usuario edita parcialmente su perfil dejando el resto sin tocar

- GIVEN un usuario autenticado con perfil ya completo (`nombre="Ana Gómez"`, `domicilio="Av. Siempre Viva 742"`, `telefono="+54 9 11 5555-5555"`)
- WHEN se hace `PATCH /account/profile` con únicamente `{"telefono": "+54 9 11 4444-4444"}`
- THEN la respuesta HTTP es 200
- AND una llamada posterior a `GET /account/profile` devuelve `telefono` actualizado y `nombre`/`domicilio` sin cambios

#### Scenario: Perfil se puede dejar completamente vacío sin error

- GIVEN un usuario autenticado recién creado, sin ningún campo de perfil completado
- WHEN se hace `PATCH /account/profile` con un body vacío `{}` (o sin enviar ningún campo de perfil)
- THEN la respuesta HTTP es 200, sin error de validación
- AND el perfil permanece con todos sus campos en `null`

#### Scenario: Intento de modificar role o email vía este endpoint es ignorado o rechazado

- GIVEN un usuario autenticado con `role="viewer"`
- WHEN se hace `PATCH /account/profile` con `{"nombre": "Bruno", "role": "superadmin", "email": "otro@example.com"}`
- THEN la respuesta HTTP es 200 (o 422 si el schema rechaza campos desconocidos, según la validación del sistema)
- AND el `role` del usuario permanece `"viewer"` y su `email` permanece sin cambios en cualquier caso
- AND el `nombre` sí se actualiza a `"Bruno"`

#### Scenario: Usuario no autenticado recibe 401

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `PATCH /account/profile` con cualquier body
- THEN la respuesta HTTP es 401
- AND no se modifica ningún dato de perfil

### Requirement: Aislamiento del perfil extendido respecto de /auth/me y del JWT

El sistema MUST mantener los campos de perfil extendido (nombre editable, domicilio, teléfono, y cualquier otro campo agregado por este change) completamente fuera de `GET /auth/me` y fuera de los claims del JWT emitido por `POST /auth/login` o por el flujo de Google. Estos datos MUST exponerse únicamente vía `GET /account/profile`.

#### Scenario: El perfil extendido no aparece en /auth/me

- GIVEN un usuario autenticado que completó su perfil extendido (`domicilio` y `telefono` con valor)
- WHEN se hace `GET /auth/me` con su cookie `session`
- THEN la respuesta HTTP es 200
- AND el body de `/auth/me` NO contiene `domicilio` ni `telefono` ni ningún otro campo de perfil extendido — solo el shape ya especificado por `multi-user-auth` (`id`, `email`, `role`)

#### Scenario: El perfil extendido no aparece en los claims del JWT

- GIVEN un usuario autenticado que completó su perfil extendido
- WHEN se decodifica el JWT emitido en la cookie `session` de ese usuario (firma válida, mismo `AUTH_SECRET_KEY`)
- THEN los claims del token NO contienen `domicilio`, `telefono`, ni ningún otro campo de perfil extendido agregado por este change

### Requirement: Activación de 2FA TOTP restringida a usuarios con password propio

El sistema MUST exponer `POST /auth/2fa/setup`, protegido por `Depends(get_current_user)`, que rechace explícitamente con 400 o 409 la activación de 2FA cuando el usuario autenticado tiene `password_hash IS NULL` (usuario 100% Google, sin password propio). Esta restricción es una Decisión Cerrada del proposal y no debe re-evaluarse como pregunta abierta.

#### Scenario: Usuario con password activa 2FA exitosamente

- GIVEN un usuario autenticado con `password_hash` no nulo y `totp_enabled=false`
- WHEN se hace `POST /auth/2fa/setup` con su cookie `session`
- THEN la respuesta HTTP es 200 (o 201)
- AND el body incluye un URI `otpauth://` (o el material necesario para renderizar el QR) y una lista de backup codes en texto claro
- AND `totp_enabled` del usuario permanece `false` hasta que el código generado sea verificado (ver Requirement: Verificación del código TOTP en el setup)

#### Scenario: Usuario 100% Google sin password es rechazado al intentar activar 2FA

- GIVEN un usuario autenticado con `password_hash IS NULL` (creado exclusivamente vía Google, sin haber seteado password propio)
- WHEN se hace `POST /auth/2fa/setup` con su cookie `session`
- THEN la respuesta HTTP es 400 o 409
- AND el body indica explícitamente que 2FA no está disponible para cuentas sin password propio
- AND no se genera ni persiste ningún `totp_secret` ni backup code para ese usuario

#### Scenario: Usuario no autenticado recibe 401

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `POST /auth/2fa/setup`
- THEN la respuesta HTTP es 401

### Requirement: Verificación del código TOTP en el setup

El sistema MUST exponer un endpoint de verificación (ej. `POST /auth/2fa/verify`), protegido por `Depends(get_current_user)`, que reciba un código TOTP de 6 dígitos generado a partir del secreto entregado en el setup y, si es válido, marque `totp_enabled=true` para ese usuario. Si el código es inválido, el sistema MUST responder con error y MUST NOT habilitar 2FA.

#### Scenario: Código TOTP válido en el setup habilita 2FA

- GIVEN un usuario que llamó `POST /auth/2fa/setup` y obtuvo un secreto TOTP, con `totp_enabled=false`
- WHEN se hace `POST /auth/2fa/verify` con un código de 6 dígitos generado correctamente a partir de ese secreto en la ventana de tiempo vigente
- THEN la respuesta HTTP es 200
- AND `totp_enabled` del usuario pasa a `true`

#### Scenario: Código TOTP inválido en el setup no habilita 2FA

- GIVEN un usuario que llamó `POST /auth/2fa/setup` y obtuvo un secreto TOTP, con `totp_enabled=false`
- WHEN se hace `POST /auth/2fa/verify` con un código de 6 dígitos arbitrario que no corresponde al secreto entregado (ej. `"000000"` cuando no es el código válido para ese instante)
- THEN la respuesta HTTP es 400 o 401
- AND el body indica que el código es inválido
- AND `totp_enabled` del usuario permanece `false`

### Requirement: Backup codes expuestos una única vez

El endpoint `POST /auth/2fa/setup` MUST incluir los backup codes en texto claro únicamente en su primera respuesta exitosa. El sistema MUST NOT volver a exponer los backup codes en texto claro en ninguna llamada posterior a `POST /auth/2fa/setup` (re-setup) ni en ningún otro endpoint del sistema (incluyendo `GET /account/profile` y `GET /auth/me`).

#### Scenario: Los backup codes solo aparecen en la primera respuesta de setup

- GIVEN un usuario con password propio y `totp_enabled=false`
- WHEN se hace `POST /auth/2fa/setup` por primera vez
- THEN la respuesta incluye una lista de backup codes en texto claro, junto con un aviso de que no se volverán a mostrar

#### Scenario: Una segunda llamada de setup nunca vuelve a exponer los backup codes originales en claro

- GIVEN un usuario que ya llamó `POST /auth/2fa/setup` una vez y recibió sus backup codes originales
- WHEN se hace `POST /auth/2fa/setup` nuevamente (re-setup, generando un nuevo secreto y nuevos backup codes)
- THEN la respuesta HTTP es exitosa y expone los backup codes NUEVOS en texto claro (propios de este segundo setup)
- AND los backup codes ORIGINALES de la primera llamada ya no son válidos ni se muestran en ninguna respuesta
- AND ningún otro endpoint del sistema (`GET /account/profile`, `GET /auth/me`, o cualquier otro) devuelve backup codes en texto claro en ningún momento

### Requirement: Login con 2FA habilitado requiere segundo factor

Cuando un usuario tiene `totp_enabled=true`, el sistema MUST requerir, además de email y password válidos, un código TOTP vigente (o un backup code válido, ver Requirement: Uso de backup codes como alternativa al código TOTP) antes de completar el login y emitir la cookie de sesión `session` completa. El sistema MUST comportarse de forma observable como un flujo de dos pasos: password correcto por sí solo MUST NOT resultar en una sesión completa y utilizable mientras el segundo factor esté pendiente de verificación.

#### Scenario: Login con password correcto pero sin segundo factor no otorga sesión completa

- GIVEN un usuario con `totp_enabled=true`, email y password válidos
- WHEN se hace `POST /auth/login` con `email` y `password` correctos, sin proveer código TOTP ni backup code
- THEN la respuesta HTTP NO otorga acceso a endpoints protegidos como si la sesión estuviera completamente autenticada (ej. no responde 200 en `GET /auth/me` como sesión válida completa, o responde indicando explícitamente que falta el segundo factor)
- AND no se emite la cookie `session` completa que un login sin 2FA emitiría

#### Scenario: Login completo con password y código TOTP válido

- GIVEN un usuario con `totp_enabled=true`, email y password válidos
- WHEN se completa el flujo de login proveyendo `email`, `password` correctos y un código TOTP válido y vigente
- THEN el sistema otorga una sesión completa equivalente a la de un login sin 2FA (misma cookie `session` httpOnly, mismos claims `sub`/`role`)
- AND una request posterior a `GET /auth/me` con esa cookie responde 200 con el perfil del usuario

#### Scenario: Login rechazado con código TOTP incorrecto

- GIVEN un usuario con `totp_enabled=true`, email y password válidos, en medio del flujo de segundo factor
- WHEN se provee un código TOTP incorrecto o ya expirado
- THEN el sistema rechaza el intento, sin otorgar sesión completa
- AND no se emite la cookie `session` completa

### Requirement: Uso de backup codes como alternativa al código TOTP en el login

El sistema MUST permitir que, en el paso de segundo factor del login, el usuario use un backup code válido en lugar del código TOTP actual. El sistema MUST invalidar ese backup code inmediatamente después de un uso exitoso, de forma que no pueda reutilizarse.

#### Scenario: Login exitoso usando un backup code válido en vez del código TOTP

- GIVEN un usuario con `totp_enabled=true` y al menos un backup code aún no utilizado
- WHEN se completa el flujo de login proveyendo `email`, `password` correctos y ese backup code en lugar de un código TOTP
- THEN el sistema otorga una sesión completa (misma cookie `session` que un login exitoso vía TOTP)
- AND ese backup code queda marcado como usado/invalidado inmediatamente después

#### Scenario: Un backup code ya usado no puede reutilizarse

- GIVEN un usuario con `totp_enabled=true` que ya usó un backup code específico en un login previo
- WHEN se intenta completar el segundo factor de un nuevo login usando ese mismo backup code
- THEN el sistema rechaza el intento (no otorga sesión completa)
- AND el body indica que el código no es válido, sin distinguir explícitamente al usuario si la causa es "ya usado" vs "nunca existió" (mismo criterio de no filtrar información que ya aplica a errores de login por password)

### Requirement: Deshabilitación de 2FA

El sistema MUST exponer `POST /auth/2fa/disable`, protegido por `Depends(get_current_user)` y requiriendo que el usuario tenga una sesión completamente autenticada (segundo factor ya verificado si aplicaba al momento del login), que marque `totp_enabled=false`, invalide el `totp_secret` almacenado, e invalide todos los backup codes restantes del usuario.

#### Scenario: Usuario autenticado deshabilita su 2FA exitosamente

- GIVEN un usuario con `totp_enabled=true` y una sesión completa y válida
- WHEN se hace `POST /auth/2fa/disable` con su cookie `session`
- THEN la respuesta HTTP es 200
- AND `totp_enabled` pasa a `false`
- AND un login posterior con solo email y password (sin código TOTP) otorga sesión completa, igual que un usuario sin 2FA

#### Scenario: Usuario no autenticado recibe 401 al intentar deshabilitar 2FA

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `POST /auth/2fa/disable`
- THEN la respuesta HTTP es 401
- AND `totp_enabled` no cambia para ningún usuario

### Requirement: Exportación de los propios datos de cuenta

El sistema MUST exponer `GET /account/export`, protegido por `Depends(get_current_user)`, que devuelva de forma síncrona un JSON válido con los datos de cuenta del usuario autenticado (perfil extendido, metadata de cuenta como `email`, `role`, fechas de creación/actualización). El sistema MUST NOT incluir `password_hash`, `totp_secret`, ni backup codes (ni en claro ni hasheados) en el JSON exportado. El sistema MUST incluir en la exportación únicamente los datos del usuario que realiza el request, nunca datos de otros usuarios.

#### Scenario: Usuario autenticado exporta sus propios datos

- GIVEN un usuario autenticado con perfil parcialmente completo y cuenta activa
- WHEN se hace `GET /account/export` con su cookie `session`
- THEN la respuesta HTTP es 200 con `Content-Type` JSON
- AND el body contiene un JSON válido con al menos `email`, `role`, y los campos de perfil extendido del usuario
- AND el body NO contiene `password_hash`, `totp_secret`, ni backup codes bajo ninguna forma

#### Scenario: El export nunca incluye datos de otro usuario

- GIVEN dos usuarios autenticados distintos, `usuario_a` y `usuario_b`, cada uno con su propio perfil completado con valores distintos entre sí
- WHEN `usuario_a` hace `GET /account/export` con su propia cookie `session`
- THEN la respuesta contiene únicamente los datos de `usuario_a`
- AND no aparece ningún campo, email, ni valor de perfil correspondiente a `usuario_b`

#### Scenario: Usuario no autenticado recibe 401

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `GET /account/export`
- THEN la respuesta HTTP es 401

### Requirement: Eliminación de la propia cuenta

El sistema MUST exponer `DELETE /account`, protegido por `Depends(get_current_user)`, que elimine (hard-delete) la fila del usuario autenticado en `users`, salvo que ese usuario sea el único `superadmin` del sistema. Tras un borrado exitoso, cualquier intento posterior de `POST /auth/login` con las credenciales de esa cuenta MUST fallar como si el usuario nunca hubiera existido.

#### Scenario: Usuario no-superadmin-único elimina su propia cuenta exitosamente

- GIVEN un usuario autenticado con `role="viewer"` (o cualquier rol que no sea el único `superadmin` del sistema)
- WHEN se hace `DELETE /account` con su cookie `session`
- THEN la respuesta HTTP es 200 o 204
- AND la fila de ese usuario ya no existe en `users`
- AND un `POST /auth/login` posterior con el `email`/`password` de esa cuenta responde 401, igual que para un email inexistente

#### Scenario: El último superadmin del sistema no puede eliminar su propia cuenta

- GIVEN un usuario autenticado con `role="superadmin"` que es el único usuario con `role="superadmin"` en el sistema (`COUNT(*) WHERE role='superadmin') = 1`)
- WHEN ese usuario hace `DELETE /account` con su cookie `session`
- THEN la respuesta HTTP es 409
- AND el body indica explícitamente que no puede eliminar su cuenta por ser el único superadmin del sistema
- AND la fila del usuario permanece intacta en `users`
- AND un `POST /auth/login` posterior con sus credenciales sigue funcionando exactamente igual que antes del intento

#### Scenario: Un superadmin que no es el único puede eliminar su propia cuenta

- GIVEN al menos dos usuarios con `role="superadmin"` en el sistema
- WHEN uno de ellos hace `DELETE /account` con su propia cookie `session`
- THEN la respuesta HTTP es 200 o 204
- AND la fila de ese superadmin ya no existe en `users`
- AND el otro (u otros) superadmin restante sigue existiendo y pudiendo autenticarse con normalidad

#### Scenario: Usuario no autenticado recibe 401 al intentar eliminar una cuenta

- GIVEN un cliente sin cookie `session` válida
- WHEN se hace `DELETE /account`
- THEN la respuesta HTTP es 401
- AND no se elimina ninguna fila de `users`

### Requirement: No regresión sobre login/registro/OAuth existente

Ningún escenario ya especificado en `openspec/changes/multi-user-auth/specs/auth/spec.md` (registro, login, logout, `/auth/me` sin 2FA habilitado, roles jerárquicos, bootstrap del primer superadmin, expiración de sesión, cookie httpOnly, no regresión de endpoints públicos) ni en `openspec/changes/google-oauth/specs/auth/spec.md` (login/registro vía Google, auto-link por email, bootstrap vía Google, login indistinto por password o Google, manejo de errores OAuth) MUST verse afectado por este change para usuarios con `totp_enabled=false` (el estado por defecto de todo usuario existente antes de este change). Este change es aditivo sobre el sistema de auth existente: no modifica el contrato de ningún endpoint ya especificado en esos dos documentos.

#### Scenario: Login por password sin 2FA sigue funcionando exactamente igual que antes de este change

- GIVEN un usuario con `password_hash` no nulo y `totp_enabled=false` (o el campo no existente antes de la migración de este change, tratado como `false` por defecto)
- WHEN se hace `POST /auth/login` con `email` y `password` correctos
- THEN la respuesta HTTP es 200, emite la cookie `session` httpOnly de una sola vez, sin ningún paso adicional de segundo factor
- AND el comportamiento es idéntico al especificado en `multi-user-auth/specs/auth/spec.md` (Requirement: Login)

#### Scenario: Login y registro vía Google siguen funcionando exactamente igual que antes de este change

- GIVEN un usuario que se autentica vía el flujo `GET /auth/google/login` → `GET /auth/google/callback` con `totp_enabled=false`
- WHEN completa ese flujo con un ID token válido y `email_verified=true`
- THEN el comportamiento (creación/auto-link de usuario, emisión de cookie `session`, manejo de errores OAuth) es idéntico al especificado en `google-oauth/specs/auth/spec.md`, sin ningún paso adicional introducido por este change

## Out of Scope (heredado de la propuesta, no se especifica aquí)

- Envío de backup codes o alertas de seguridad por email — no existe sistema de email en el proyecto (Decisión Cerrada #2 del proposal).
- 2FA para cuentas 100% Google (`password_hash IS NULL`) — explícitamente rechazado, no diferido (Decisión Cerrada #1 del proposal).
- Exportación asíncrona de datos o notificación por email de "export listo".
- Soft-delete o ventana de gracia para el borrado de cuenta — se usa hard-delete inmediato.
- Transferencia guiada de rol de superadmin como flujo de producto — el usuario bloqueado debe pedirle a otro superadmin que otorgue el rol a un tercero, fuera de este change.
- Auditoría/logging dedicado de "cuenta eliminada" más allá de los logs de aplicación ya existentes.
