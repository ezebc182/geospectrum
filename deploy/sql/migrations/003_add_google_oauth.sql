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
