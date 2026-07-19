-- Migration 002: amplía el CHECK constraint de `users.role` de 2 valores
-- planos (admin/viewer) a 4 valores con jerarquía estricta descendente
-- (superadmin/admin/moderador/viewer).
--
-- Contexto: cambio de alcance de producto confirmado por el usuario DESPUÉS
-- de que 001_create_users_table.sql ya fue aplicada contra el Postgres real.
-- No se edita 001 (es historia ya aplicada) — ver
-- openspec/changes/multi-user-auth/design.md, Decision 6.
--
-- Jerarquía (nivel, ver src/models/user.py ROLE_LEVEL):
--   superadmin = 3, admin = 2, moderador = 1, viewer = 0
-- Regla de gestión: cada rol solo gestiona roles ESTRICTAMENTE por debajo
-- de su propio nivel.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check
    CHECK (role IN ('superadmin', 'admin', 'moderador', 'viewer'));

-- Rollback:
--
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
-- ALTER TABLE users ADD CONSTRAINT users_role_check
--     CHECK (role IN ('admin', 'viewer'));
--
-- ADVERTENCIA: este rollback FALLA si ya existen filas con role en
-- ('superadmin', 'moderador'), porque el ADD CONSTRAINT es validado contra
-- los datos existentes. Antes de revertir, hay que reasignar o eliminar
-- esas filas manualmente (ej. UPDATE users SET role = 'admin' WHERE role =
-- 'superadmin'; UPDATE users SET role = 'viewer' WHERE role = 'moderador';)
-- — no es un rollback libre de pérdida/reasignación de datos.
