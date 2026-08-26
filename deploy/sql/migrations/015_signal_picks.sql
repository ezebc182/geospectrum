-- deploy/sql/migrations/015_signal_picks.sql
--
-- Picking manual de fases sísmicas por usuario (spec analiticas-profesionales-senal,
-- Fase 5). Patrón de 013_walls.sql: tabla propia, ownership por user_id con
-- CASCADE, índices IF NOT EXISTS para que la migración sea re-ejecutable.
--
-- Por qué tabla propia y no un JSON en users.settings: los picks son N por
-- usuario Y por canal, se consultan por rango temporal (el wave view pide los
-- picks de la ventana visible) y se exportan a CSV. Un JSONB no se indexa por
-- rango sin trabajo extra y la consulta natural es un BETWEEN.
--
-- pick_time es TIMESTAMPTZ y NO un offset dentro de una ventana: la misma onda
-- se mira con zooms distintos, y un offset sólo tiene sentido relativo a la
-- ventana en la que se marcó. El instante absoluto sobrevive a cualquier zoom.
--
-- La UNIQUE (user_id, channel, phase, pick_time) hace idempotente el POST desde
-- un doble clic: marcar la MISMA fase en el MISMO instante dos veces es un
-- accidente de UI, no dos mediciones. Marcar dos P en instantes distintos SÍ es
-- legítimo (dos eventos en la misma ventana), y por eso pick_time está en la
-- clave: no se restringe a una P por canal.
--
-- phase es TEXT + CHECK y NO un ENUM de Postgres: los enums necesitan
-- ALTER TYPE ... ADD VALUE para crecer y eso no corre dentro de una transacción
-- en versiones viejas; un CHECK se cambia con un ALTER TABLE normal. El repo no
-- usa enums de Postgres en ninguna migración existente.

CREATE TABLE IF NOT EXISTS signal_picks (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel    TEXT NOT NULL,
    phase      TEXT NOT NULL,
    pick_time  TIMESTAMPTZ NOT NULL,
    note       TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- El CHECK va inline (no como índice) porque no necesita ser re-ejecutable
    -- por separado: si la tabla existe, el constraint ya está.
    CONSTRAINT signal_picks_phase_check CHECK (phase IN ('P', 'S', 'coda')),
    CONSTRAINT signal_picks_note_len CHECK (note IS NULL OR char_length(note) <= 280)
);

-- Idempotencia del POST (ver comentario de cabecera). Índice separado, no
-- constraint inline, para que la migración sea re-ejecutable con IF NOT EXISTS
-- (mismo criterio que walls_user_id_name_key).
CREATE UNIQUE INDEX IF NOT EXISTS signal_picks_user_channel_phase_time_key
    ON signal_picks (user_id, channel, phase, pick_time);

-- La consulta caliente es exactamente esta: "los picks de ESTE usuario en ESTE
-- canal dentro de ESTA ventana". El orden de las columnas es el de la
-- selectividad de la query, no alfabético.
CREATE INDEX IF NOT EXISTS signal_picks_user_channel_time_idx
    ON signal_picks (user_id, channel, pick_time);

-- Rollback:
-- ATENCIÓN: dropear la tabla BORRA mediciones reales de usuarios. Si hay picks
-- guardados, el rollback correcto es revertir el código de la UI y dejar la
-- tabla huérfana hasta decidir qué hacer con esos datos. Sólo dropear si
-- SELECT count(*) FROM signal_picks; devuelve 0.
--
-- DROP INDEX IF EXISTS signal_picks_user_channel_time_idx;
-- DROP INDEX IF EXISTS signal_picks_user_channel_phase_time_key;
-- DROP TABLE IF EXISTS signal_picks;
