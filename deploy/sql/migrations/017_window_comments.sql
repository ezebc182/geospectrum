-- 017: hilo de conversación por ventana analizada (decisión 2026-08-26).
--
-- Colaborativo a propósito: todos los usuarios leen todos los hilos (el
-- análisis sísmico es trabajo de equipo, igual que los eventos globales);
-- el ownership aplica solo al borrado. El hilo cuelga de (channel, ventana)
-- y la lectura filtra por SOLAPAMIENTO, no por igualdad exacta: un zoom que
-- corre la ventana unos segundos no puede hacer desaparecer la conversación.

CREATE TABLE IF NOT EXISTS window_comments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel      TEXT NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    window_end   TIMESTAMPTZ NOT NULL,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT window_comments_window_valida CHECK (window_end > window_start)
);

-- La consulta del hilo: canal + solapamiento de ventana, en orden de llegada.
CREATE INDEX IF NOT EXISTS idx_window_comments_channel_window
    ON window_comments (channel, window_start, window_end);
