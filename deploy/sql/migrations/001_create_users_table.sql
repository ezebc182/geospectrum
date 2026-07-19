-- Migration 001: crea la tabla `users` para autenticación multi-usuario con roles.
--
-- Convención de este proyecto (sin Alembic ni tool de migraciones detectado):
-- archivos numerados `NNN_description.sql` en deploy/sql/migrations/, aplicados
-- manualmente contra el Postgres/TimescaleDB del perfil `storage` en
-- deploy/docker/docker-compose.yml. Ver openspec/changes/multi-user-auth/design.md
-- (Migration/Rollout) para el contexto completo de esta decisión.
--
-- Idempotente: seguro de re-ejecutar (CREATE TABLE/INDEX IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'viewer')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);

-- Rollback:
-- DROP TABLE IF EXISTS users;
