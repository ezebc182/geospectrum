-- Migration 007: registro invitation-only (email-invitations).
--
-- Ver openspec/changes/email-invitations/design.md (Decision 1) para el
-- detalle de cada punto estructural de esta tabla.
--
-- Convención del proyecto (ver 001-006): manual, sin Alembic, idempotente.
-- Archivos numerados `NNN_description.sql` en deploy/sql/migrations/,
-- aplicados manualmente contra el Postgres/TimescaleDB del perfil `storage`
-- en deploy/docker/docker-compose.yml. No editar migraciones ya aplicadas
-- (001-006); esta migración es aditiva y sigue el mismo estilo.
--
-- Puntos estructurales (Decision 1):
--   * token_hash guarda el SHA-256 hex del token en claro (secrets.token_urlsafe(32),
--     256 bits de entropía) — NUNCA el token en claro: un dump de la base no
--     debe filtrar links de alta con rol pre-asignado. SHA-256 sin salt
--     alcanza (la fuerza bruta sobre 256 bits es inviable) y su determinismo
--     es lo que permite el lookup indexado WHERE token_hash = $1.
--   * El estado (pending/accepted/revoked/expired) es DERIVADO de los
--     timestamps, sin columna status: una columna textual podría
--     desincronizarse de los timestamps (dos fuentes de verdad).
--   * invited_by/accepted_by con ON DELETE SET NULL: si el admin que invitó
--     borra su cuenta, la invitación sigue válida — se pierde trazabilidad,
--     no funcionalidad.
--   * SIN índice unique parcial sobre email pendiente: el predicado de un
--     índice parcial exige expresiones inmutables y `expires_at > now()` no
--     lo es. La unicidad "una sola invitación pendiente y vigente por email"
--     se garantiza a nivel de servicio, dentro de la transacción de
--     create_invitation() (InvitationService).
--
-- Idempotente: seguro de re-ejecutar (CREATE TABLE/INDEX IF NOT EXISTS,
-- ADD COLUMN IF NOT EXISTS; el backfill sólo toca filas con NULL).

CREATE TABLE IF NOT EXISTS invitations (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email          TEXT NOT NULL,
    role           TEXT NOT NULL CHECK (role IN ('superadmin', 'admin', 'moderador', 'viewer')),
    token_hash     TEXT NOT NULL UNIQUE,          -- sha256 hex; NUNCA el token en claro
    invited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    accepted_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at     TIMESTAMPTZ NOT NULL,
    accepted_at    TIMESTAMPTZ,                   -- estado DERIVADO de timestamps, sin columna status
    revoked_at     TIMESTAMPTZ,
    email_sent_at  TIMESTAMPTZ                    -- confirmación de envío (mark-sent desde Next)
);

CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations (lower(email));

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed_at TIMESTAMPTZ;

-- Backfill: los usuarios EXISTENTES no deben ver el wizard de onboarding
-- (es para usuarios nuevos invitados). Corre una sola vez, antes del deploy
-- del código que lee la columna.
UPDATE users SET onboarding_completed_at = now() WHERE onboarding_completed_at IS NULL;

-- Rollback:
-- DROP TABLE IF EXISTS invitations;             -- sin FKs entrantes desde otras tablas
-- ALTER TABLE users DROP COLUMN IF EXISTS onboarding_completed_at;
-- (Los usuarios creados por invitación sobreviven como usuarios normales;
--  solo se pierde la trazabilidad de quién los invitó — aceptable en rollback.)
