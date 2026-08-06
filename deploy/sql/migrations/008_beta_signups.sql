-- Migration 008: lista de espera de la beta (landing pública).
--
-- La landing (dashboard/app/landing) ofrece "sumarme a la beta" con un email.
-- Tabla mínima a propósito: no es un sistema de usuarios ni de invitaciones —
-- cuando alguien de la lista recibe su invitación real, eso pasa por la tabla
-- invitations (007), no por acá.
--
-- email UNIQUE + inserción con ON CONFLICT DO NOTHING en el endpoint: anotarse
-- dos veces es un no-op silencioso. El endpoint responde igual en ambos casos
-- para no funcionar como oráculo de qué emails existen en la base.
--
-- Convención del proyecto (ver 001-007): manual, sin Alembic, idempotente.
-- Archivos numerados NNN_description.sql en deploy/sql/migrations/, aplicados
-- manualmente contra el Postgres/TimescaleDB del perfil `storage`.

CREATE TABLE IF NOT EXISTS beta_signups (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email      TEXT NOT NULL UNIQUE,          -- normalizado a lowercase en el endpoint
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
