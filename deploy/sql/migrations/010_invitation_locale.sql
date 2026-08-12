-- Migration 010: idioma del email de invitación (pulido post-rollout de
-- email-invitations).
--
-- `locale` es el idioma en que se envía el email de invitación ('es' | 'en').
-- Lo elige el admin al invitar; el template pasó de bilingüe duplicado a
-- monolingüe según esta columna. Default 'es': todas las invitaciones
-- existentes se crearon con el copy en español primero, y es el idioma
-- principal del producto.
--
-- Convención del proyecto (ver 001-009): manual, sin Alembic, idempotente.
-- Se aplica sola al arranque de la API (scripts/apply_migrations.py).
--
-- Idempotente: ADD COLUMN IF NOT EXISTS; el CHECK va con nombre explícito y
-- DROP CONSTRAINT IF EXISTS previo (mismo guard que usa 002 para
-- users_role_check) — re-ejecutar la migración no duplica ni falla.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';

ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_locale_check;

ALTER TABLE invitations ADD CONSTRAINT invitations_locale_check
    CHECK (locale IN ('es', 'en'));

-- Rollback:
-- ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_locale_check;
-- ALTER TABLE invitations DROP COLUMN IF EXISTS locale;
-- (Las invitaciones sobreviven; solo se pierde el idioma elegido y el email
--  volvería a salir con el default del template.)
