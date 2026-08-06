-- Migration 009: aprobación de beta testers (flujo listado → aprobar → email).
--
-- `approved_at` marca que un admin aprobó al interesado: la aprobación crea
-- una invitación (tabla invitations, 007) y dispara el email de bienvenida
-- con link a /login — el aprobado entra con Google y la invitación se
-- consume por match de email (email-invitations, Decision 5). Timestamp y
-- no boolean: mismo criterio que invitations (el estado se deriva, y la
-- fecha de aprobación es auditoría gratis).
--
-- Convención del proyecto (ver 001-008): manual, sin Alembic, idempotente.
-- Se aplica sola al arranque de la API (scripts/apply_migrations.py).

ALTER TABLE beta_signups ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
