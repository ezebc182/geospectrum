-- 019: reportes de feedback de beta testers (change feedback-beta-testers).
--
-- El estado ES una columna (status) y no se deriva de timestamps. El criterio
-- de beta_signups/invitations ("timestamps, no columnas de estado que puedan
-- desincronizarse", src/models/beta.py) es correcto para un estado BINARIO:
-- un instante de aprobación existe o no existe, y esa columna es a la vez el
-- estado y el cuándo. Con CINCO estados y movimientos en ambos sentidos
-- (done → in_progress es legítimo), cinco timestamps nullable obligarían a
-- derivar el estado de "cuál es el más reciente" en SQL, en Pydantic y en TS
-- — tres derivaciones que pueden divergir — y a PERDER información al mover
-- hacia atrás (¿se limpia done_at?). Esa es exactamente la desincronización
-- que el criterio quería evitar. Acá: una columna dice EN QUÉ columna está la
-- tarjeta, otra dice DESDE CUÁNDO. Sin historial de transiciones (fuera de
-- alcance, proposal). TEXT + CHECK y no un ENUM de Postgres: mismo patrón que
-- `type` acá y que el resto del repo; agregar un valor es un ALTER del CHECK
-- en una migración aditiva, sin ALTER TYPE.
--
-- Sin índices a propósito: ~4 cuentas y decenas de filas como techo; un seq
-- scan es más barato que mantener el índice y agregarlo mañana es aditivo.

CREATE TABLE IF NOT EXISTS feedback_reports (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type                     TEXT NOT NULL CHECK (type IN ('bug', 'suggestion')),
    body                     TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    -- Contexto técnico capturado por el cliente: columnas acotadas, no JSONB
    -- (shape fijo y conocido; un JSONB libre no valida nada).
    route                    TEXT NOT NULL CHECK (char_length(route) <= 300),
    url                      TEXT NOT NULL CHECK (char_length(url) <= 2000),
    user_agent               TEXT NOT NULL DEFAULT '' CHECK (char_length(user_agent) <= 400),
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Tablero Kanban: columna actual + desde cuándo está ahí. status_changed_at
    -- nace NULL (sin default): "todavía nadie la movió" es un estado observable
    -- del tablero, distinto de "la movieron en el instante de crearla".
    status                   TEXT NOT NULL DEFAULT 'new'
                             CHECK (status IN ('new', 'in_analysis', 'in_progress', 'done', 'discarded')),
    status_changed_at        TIMESTAMPTZ NULL,
    -- UN comentario opcional del admin, reemplazable, sin historial. Ambas
    -- columnas van juntas: las dos NULL (sin comentario) o las dos con valor.
    admin_comment            TEXT NULL
                             CHECK (admin_comment IS NULL OR char_length(admin_comment) BETWEEN 1 AND 2000),
    admin_comment_updated_at TIMESTAMPTZ NULL,
    CONSTRAINT feedback_reports_comment_pair
        CHECK ((admin_comment IS NULL) = (admin_comment_updated_at IS NULL))
);
