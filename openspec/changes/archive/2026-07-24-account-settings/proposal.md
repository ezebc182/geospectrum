# Proposal: Menú de configuración de cuenta (perfil, 2FA TOTP, exportar datos, borrar cuenta)

## Intent

Hoy el usuario autenticado (`multi-user-auth` + `google-oauth`, ambos ya archivados) no tiene ningún lugar para gestionar su propia cuenta más allá de login/logout: no puede completar datos de perfil opcionales, no tiene una segunda capa de seguridad además de su password, no puede obtener una copia de sus propios datos, y no puede eliminar su cuenta sin intervención manual sobre la base.

Este change agrega un menú de "Configuración de cuenta" (`/account/*` en backend, ruta `dashboard/app/settings/` en frontend) que cubre cuatro capacidades, tratadas como sub-features dentro de UN SOLO change (no se dividen en changes separados):

1. Perfil personal opcional (nombre si no vino de Google, domicilio, teléfono, otros campos de perfil razonables).
2. 2FA vía TOTP (QR para setup) con backup codes como único mecanismo de recuperación.
3. Exportación de los propios datos del usuario (JSON descargable, síncrono).
4. Eliminación de la propia cuenta (hard-delete), con protección explícita contra dejar el sistema sin superadmins.

## Scope

### In Scope

- **Perfil extendido**: nuevas columnas de perfil (nombre editable si no vino de Google, domicilio, teléfono, y cualquier otro campo de perfil razonable) en tabla/columnas separadas de `users`, TODAS opcionales (`Optional`), sin tocar `role` ni ningún campo crítico de seguridad.
  - Endpoint dedicado `GET /account/profile` (lectura) y endpoint de escritura (ej. `PATCH /account/profile`) — separados de `/auth/me`.
- **2FA TOTP**: setup con QR (`pyotp` + generación de URI `otpauth://`), verificación de código, deshabilitación, y backup codes generados en el momento del setup.
  - Restringido a usuarios con `password_hash` propio (ver Decisiones Cerradas #1).
  - Backup codes mostrados UNA VEZ en la respuesta del endpoint de setup (ver Decisión #2).
  - Backup codes persistidos hasheados con bcrypt, reutilizando `_pwd_context` (ver Decisión #5).
- **Exportar datos**: `GET /account/export` — arma un JSON con todos los datos propios del usuario (perfil, metadata de cuenta) en el mismo request/response, sin infraestructura de jobs.
- **Borrar cuenta**: endpoint (ej. `DELETE /account`) que hace hard-delete de la fila en `users`, bloqueado si el usuario es el único superadmin del sistema (ver Decisión #3).
- Frontend: nueva ruta de settings (`dashboard/app/settings/` o similar) con formularios de perfil, flujo de setup de 2FA (QR + input de código + pantalla de backup codes con aviso "guardalos ahora"), botón de exportar datos, y "zona de riesgo" con diálogo de confirmación destructivo para borrar cuenta.

### Out of Scope

- Envío de backup codes o alertas de seguridad por email (no existe sistema de email en el proyecto; ver Riesgos).
- 2FA para cuentas 100% Google (`password_hash IS NULL`) — explícitamente rechazado, no diferido a "fase 2" sin criterio: es una decisión de producto, no solo de secuencia (ver Decisión #1).
- Exportación asíncrona / con notificación por email cuando el archivo está "listo".
- Soft-delete o ventana de gracia para el borrado de cuenta (se eligió hard-delete inmediato).
- Transferencia de rol de superadmin como flujo guiado (el usuario bloqueado deberá pedirle a otro superadmin que le otorgue el rol a un tercero antes de poder borrarse, fuera de este change).
- Auditoría/logging dedicado de "cuenta eliminada" más allá de los logs de aplicación ya existentes.

## Approach

Seguir el mismo patrón arquitectónico ya establecido por `multi-user-auth`/`google-oauth`: SQL parametrizado vía `asyncpg` en `AuthService` (sin ORM), migraciones manuales numeradas en `deploy/sql/migrations/`, `Depends(get_current_user)` para proteger endpoints, y separación estricta entre el shape liviano que viaja en el JWT (`UserPublic`/`CurrentUser`) y cualquier dato adicional de PII.

- **2FA**: usar `pyotp` (RFC 6238 ya implementado y probado) en vez de una implementación manual — mismo criterio que ya aplicó este proyecto a bcrypt/JWT: no reinventar primitivas de seguridad.
- **Borrado de cuenta**: hard-delete, ya que no existe ninguna FK hacia `users` hoy (confirmado por grep sobre `deploy/sql/migrations/`), replicando el patrón transaccional de `_determine_bootstrap_role` pero para el caso inverso (verificar que no sea el único superadmin antes de borrar).
- **Exportación**: síncrona, JSON directo en el response — no hay infraestructura de jobs/colas en el proyecto y el volumen de datos por usuario es una sola fila.
- **Perfil**: columnas/tabla nueva separada de `UserPublic`/JWT, consultada solo bajo demanda vía `GET /account/profile` — evita inflar el JWT con PII.

## Decisiones Cerradas (no son preguntas abiertas)

Estas 5 decisiones fueron tomadas explícitamente y NO deben re-discutirse en design/tasks salvo que aparezca información nueva que las invalide:

1. **2FA solo para usuarios con password propio.** El endpoint de activación de TOTP (ej. `POST /auth/2fa/setup`) DEBE rechazar con 400/409 si `password_hash IS NULL` (usuario 100% Google). Rationale: un usuario 100% Google ya depende de la seguridad de su cuenta de Google (que tiene su propio 2FA nativo); permitir un TOTP local adicional duplicaría "quién puede desloguearte" sin necesidad real, y complica el caso "perdí el TOTP y el acceso a Google simultáneamente" sin agregar seguridad genuina.

2. **Backup codes se muestran UNA VEZ en la UI**, en el mismo response del endpoint de setup, con aviso explícito ("guardalos ahora, no se van a volver a mostrar"). Rationale: no existe sistema de email/SMTP en el proyecto (confirmado, sin resultados en `requirements.txt` ni en el árbol de código) — este es el único mecanismo de recuperación posible sin infraestructura nueva. Si el usuario pierde los backup codes, la única salida es desactivar 2FA estando logueado; no existe "recuperar cuenta por email".

3. **Bloquear el borrado de cuenta si es el ÚLTIMO superadmin del sistema.** `delete_account()` DEBE verificar, dentro de la misma transacción que hace el `DELETE`, si el usuario es `role='superadmin'` Y `COUNT(*) WHERE role='superadmin') = 1`; si es así, rechazar con 409 y un mensaje explícito (ej. "no podés eliminar tu cuenta: sos el único superadmin del sistema"). Rationale: mismo criterio que `_determine_bootstrap_role` ya usa para garantizar que el sistema nunca arranque sin superadmin — acá se aplica el criterio inverso, para que el sistema nunca quede sin ninguno en runtime.

4. **El perfil extendido vive FUERA del JWT y de `UserPublic`.** Domicilio, teléfono, y cualquier otro campo de perfil nuevo se guardan en columnas/tabla separadas y se exponen SOLO vía un endpoint dedicado nuevo (`GET /account/profile`), nunca en `/auth/me` ni en los claims del JWT. Rationale: `UserPublic` ya viaja en el JWT (cookie `session`) y en cada respuesta de `/auth/me`; agregar PII ahí infla el tamaño de la cookie y expone datos sensibles en un JWT que está firmado pero NO cifrado.

5. **Backup codes se persisten hasheados con bcrypt, reutilizando `_pwd_context`** (el mismo `passlib` context que ya hashea `password_hash` en `auth_service.py`), NO cifrados ni firmados con un secret nuevo. Rationale: evita introducir un tercer patrón de gestión de secrets en el proyecto, que hoy tiene exactamente dos patrones documentados y justificados (`AUTH_SECRET_KEY` fail-fast total; `GOOGLE_CLIENT_ID/SECRET` opcional/condicional). Un backup code es funcionalmente equivalente a un password de un solo uso — el mismo patrón de hash aplica sin necesidad de justificar un tercer modelo de secret.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `deploy/sql/migrations/005_account_settings.sql` | New | Nueva migración: columnas de perfil (nombre editable, domicilio, teléfono, etc., todas nullable) en tabla/columnas separadas; `totp_secret TEXT`, `totp_enabled BOOLEAN DEFAULT false`; tabla `user_backup_codes` (o columna `backup_codes_hash TEXT[]`) para los códigos hasheados con bcrypt. Sin `deleted_at` (se descartó soft-delete). |
| `src/models/user.py` | Modified | Nuevo modelo `UserProfile` (todos los campos `Optional`, separado de `UserPublic`/`CurrentUser`). Nuevos modelos de request: `UserProfileUpdate`, `TotpSetupResponse` (incluye backup codes, uso único), `TotpVerifyRequest`. |
| `src/services/auth_service.py` | Modified | Nuevos métodos: `get_profile()`, `update_profile()`, `enable_totp()` (rechaza si `password_hash IS NULL`), `verify_totp()`, `disable_totp()`, `generate_backup_codes()`/`consume_backup_code()` (hash bcrypt vía `_pwd_context`), `export_user_data()`, `delete_account()` (transacción con chequeo de último superadmin). |
| `src/api/deps.py` | No change required | Los nuevos endpoints reutilizan `get_current_user` existente; no se introduce un segundo factor de sesión en este change (2FA es un flag de cuenta, no un gate de sesión intermedio — fuera de scope de diseño de sesión). |
| `src/main.py` | Modified | Nuevos endpoints: `GET /account/profile`, `PATCH /account/profile`, `GET /account/export`, `DELETE /account`, `POST /auth/2fa/setup`, `POST /auth/2fa/verify`, `POST /auth/2fa/disable`. Todos protegidos por `Depends(get_current_user)`. |
| `requirements.txt` | Modified | Agregar `pyotp` (TOTP RFC 6238) y, si no está ya disponible transitivamente, `qrcode` para generar la imagen del QR (a confirmar en design si `Pillow`/`qrcode` ya vienen por `obspy`). |
| `dashboard/lib/types.ts` | Modified | Nuevo tipo `UserProfile` (separado de `UserPublic`), tipos de request/response para 2FA setup/verify. |
| `dashboard/lib/auth.ts` | Modified | Nuevas funciones cliente: `getProfile`, `updateProfile`, `setupTotp`, `verifyTotp`, `disableTotp`, `exportData`, `deleteAccount` — todas con `credentials: 'include'` (mismo patrón cross-origin ya usado). |
| `dashboard/hooks/use-auth.tsx` | Modified | `deleteAccount()` debe limpiar el estado `user` local y redirigir a login, igual que `logout()`. |
| `dashboard/app/settings/` (nueva ruta) | New | Página de configuración de cuenta: formulario de perfil, flujo de 2FA (QR + código + pantalla de backup codes), botón de exportar datos, sección "zona de riesgo" con diálogo de confirmación para borrar cuenta. Reutiliza componentes shadcn/ui ya presentes en `dashboard/components/ui/`. |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Usuario pierde backup codes sin acceso a su método de login primario | Medium | Aceptado explícitamente (Decisión #2): única vía de recuperación es desactivar 2FA logueado. Documentado en la UI con aviso explícito al momento del setup. |
| No hay alertas de seguridad por email (ej. "se deshabilitó 2FA", "tu cuenta fue eliminada") | Medium | Riesgo aceptado explícitamente — no hay sistema de email en el proyecto; fuera de scope resolverlo acá. |
| Olvido de excluir un endpoint de superadmin del chequeo "último superadmin" en el futuro | Low | El chequeo vive encapsulado en `delete_account()` dentro de `AuthService`, un único punto de entrada — no hay múltiples rutas de borrado que puedan olvidarse. |
| Backup codes generados con baja entropía o reutilizados | Low | Usar generación criptográficamente segura (`secrets.token_hex` o equivalente) al crear los códigos, con longitud suficiente (ej. 10 códigos de 8+ caracteres); cubrir con test específico en `sdd-tasks`. |
| Hard-delete irreversible ante error de UI o click accidental | Low-Medium | Confirmación explícita en frontend (diálogo destructivo, posiblemente con confirmación de texto tipo "escribí ELIMINAR"); decisión de UX a detallar en `sdd-design`, no bloquea el proposal. |
| `pyotp`/`qrcode` agregan superficie de dependencias nuevas en `requirements.txt` (ya extenso) | Low | Librerías maduras y ampliamente usadas para su propósito específico (RFC 6238); alternativa manual fue evaluada y descartada por riesgo de seguridad (ver exploration.md). |

## Rollback Plan

- **Migración 005**: todas las columnas nuevas (perfil, `totp_secret`, `totp_enabled`, `backup_codes_hash`/tabla `user_backup_codes`) son nullable o tienen default seguro (`totp_enabled DEFAULT false`) — mismo estilo que las migraciones 001-004 ya aplicadas. Revertir consiste en un script `005_rollback.sql` (o migración inversa manual, siguiendo la convención ya establecida de nunca editar migraciones aplicadas) que hace `ALTER TABLE users DROP COLUMN ...` / `DROP TABLE user_backup_codes` (si se usó tabla separada). No hay pérdida de datos crítica salvo la que ya exista en esas columnas al momento del rollback (perfil completado, 2FA habilitado) — se documenta como aceptable, igual que en changes previos.
- **Deshabilitar sin revertir código**: los endpoints nuevos (`/account/*`, `/auth/2fa/*`) pueden desactivarse sin rollback de esquema simplemente no registrando las rutas en `src/main.py` (o gateándolas detrás de un flag de config, mismo patrón condicional que ya usa el proyecto para `google_oauth_enabled` en `lifespan()`). Esto permite apagar 2FA/exportación/borrado de forma independiente entre sí si se detecta un bug en uno solo de los cuatro sub-features, sin afectar login/logout existente.
- **Frontend**: la ruta `dashboard/app/settings/` es aislada del resto de la navegación — remover el link de acceso (ej. en `UserMenu.tsx`) es suficiente para ocultarla sin revertir código, si hiciera falta un rollback rápido de UI mientras se corrige el backend.

## Dependencies

- **`pyotp`** (nueva dependencia de `requirements.txt`) — implementación RFC 6238 (TOTP) para setup/verificación de 2FA. Elegida sobre una implementación manual por el mismo criterio de seguridad ya aplicado a bcrypt/JWT en este proyecto (no reinventar primitivas criptográficas).
- **Librería de generación de QR** (`qrcode`, a confirmar en design si no viene ya transitivamente vía `Pillow`/`obspy`) — para renderizar el `otpauth://` URI como imagen QR en el flujo de setup.
- Ninguna dependencia externa de infraestructura nueva (sin colas de jobs, sin storage de archivos temporales, sin servicio de email) — decisión explícita para mantener el alcance dentro de lo que el proyecto ya soporta operacionalmente.

## Success Criteria

- [ ] Un usuario con password puede completar/editar su perfil (nombre, domicilio, teléfono) vía `PATCH /account/profile`, y los datos NO aparecen en el JWT ni en la respuesta de `/auth/me`.
- [ ] Un usuario con password puede activar 2FA: escanear el QR con un authenticator app real (ej. Google Authenticator, Authy), verificar un código válido, y loguearse subsecuentemente usando el código TOTP.
- [ ] Un usuario 100% Google (`password_hash IS NULL`) recibe 400/409 explícito al intentar `POST /auth/2fa/setup`.
- [ ] Al activar 2FA, la respuesta incluye los backup codes UNA sola vez; una llamada posterior al mismo endpoint (o cualquier otro) nunca vuelve a exponerlos en claro.
- [ ] Un usuario puede desactivar su 2FA usando un backup code válido en vez del código TOTP actual, y ese backup code queda invalidado tras su uso (no reutilizable).
- [ ] Un usuario con password puede exportar sus datos vía `GET /account/export` y descargar un JSON válido con su información de cuenta.
- [ ] Un usuario puede eliminar su propia cuenta (`DELETE /account`) y, tras el borrado, `POST /auth/login` con esas credenciales falla (usuario ya no existe).
- [ ] El intento de borrado de cuenta del último superadmin del sistema es rechazado con 409 y un mensaje explícito, sin eliminar la fila.
- [ ] Ningún test de regresión de `multi-user-auth`/`google-oauth` (login, registro, OAuth callback) se rompe por los cambios de este change.
