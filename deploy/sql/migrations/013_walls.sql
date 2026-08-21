-- deploy/sql/migrations/013_walls.sql
--
-- Muros SPECTRONET por usuario (PR-W2, spec 2026-08-20-spectronet-wall-design.md §2).
--
-- Por qué tabla propia y no un JSON en users.settings: los muros son N por
-- usuario, con nombre único por dueño y edición por id desde el armador.
-- El layout viaja como JSONB opaco: la validación semántica (máx. columnas,
-- máx. canales, formato SCNL) vive en la app, igual que la geometría de
-- areas_of_interest. El muro default "Global" NO es una fila: se genera del
-- catálogo en wall_service.build_global_wall() (id reservado "global").
--
-- UNIQUE (user_id, name) va como índice separado (no constraint inline) para
-- que la migración sea re-ejecutable con IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS walls (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    layout     JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS walls_user_id_name_key ON walls (user_id, name);
CREATE INDEX IF NOT EXISTS walls_user_id_idx ON walls (user_id);

-- Rollback:
-- DROP TABLE IF EXISTS walls;
