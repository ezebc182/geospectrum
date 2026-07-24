-- Migration 005: menú de configuración de cuenta (perfil extendido, 2FA TOTP,
-- backup codes). Ver openspec/changes/account-settings/design.md (Decision 2)
-- para el detalle completo de esta decisión de esquema.
--
-- NOTA (tasks.md 1.1): `users.created_at`/`users.updated_at` YA EXISTEN desde
-- la migración 001_create_users_table.sql (líneas 16-17, ambas
-- `TIMESTAMPTZ NOT NULL DEFAULT now()`), confirmado por inspección directa del
-- archivo y por `\d users` contra el Postgres real (perfil `storage`). Esta
-- migración NO agrega `created_at`/`updated_at` — hacerlo sería crear columnas
-- duplicadas. Esto resuelve la Open Question de design.md (Decision 5).
--
-- `full_name` (NO `name`): columna nueva y deliberadamente separada de `name`
-- (migración 004, poblada solo por Google OAuth, expuesta en /auth/me y en el
-- JWT). `full_name` es editable por el usuario únicamente vía
-- GET/PATCH /account/profile y nunca aparece en /auth/me ni en los claims del
-- JWT (Decisión Cerrada #4 del proposal). Ambos campos coexisten sin
-- unificarse ni sobreescribirse entre sí.
--
-- Convención de este proyecto (sin Alembic ni tool de migraciones detectado):
-- archivos numerados `NNN_description.sql` en deploy/sql/migrations/, aplicados
-- manualmente contra el Postgres/TimescaleDB del perfil `storage` en
-- deploy/docker/docker-compose.yml. No editar migraciones ya aplicadas
-- (001-004); esta migración es aditiva y sigue el mismo estilo.
--
-- Idempotente: seguro de re-ejecutar (ADD COLUMN/CREATE TABLE/INDEX IF NOT EXISTS).

-- Perfil extendido: columnas nuevas directamente en `users`, todas nullable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;

-- 2FA TOTP
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT false;

-- Backup codes: tabla separada, no columna array (ver design.md Decision 2,
-- Alternatives considered — un UPDATE puntual por fila es más simple/robusto
-- que reescribir un array completo para marcar un código como usado).
CREATE TABLE IF NOT EXISTS user_backup_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_backup_codes_user_id ON user_backup_codes(user_id);

-- Rollback:
-- DROP TABLE IF EXISTS user_backup_codes;
-- ALTER TABLE users DROP COLUMN IF EXISTS full_name;
-- ALTER TABLE users DROP COLUMN IF EXISTS address;
-- ALTER TABLE users DROP COLUMN IF EXISTS phone;
-- ALTER TABLE users DROP COLUMN IF EXISTS totp_secret;
-- ALTER TABLE users DROP COLUMN IF EXISTS totp_enabled;
-- (created_at/updated_at NO se tocan en rollback: pre-existían desde 001,
-- no fueron creadas por esta migración)
