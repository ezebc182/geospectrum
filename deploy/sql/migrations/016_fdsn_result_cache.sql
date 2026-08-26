-- 016: cache sin vencimiento de resultados FDSN de ventana absoluta.
--
-- Una ventana histórica es inmutable, pero el cache en memoria muere con cada
-- redeploy (diarios en este proyecto) y el TTL de 900 s repaga ~60 s de
-- EarthScope por ventana. Esta tabla persiste el RESULTADO ya computado
-- (waveform decimado / espectro / RSAM), no el miniSEED crudo.
--
-- Sin TTL a propósito: la purga es por tope de entradas (LRU sobre
-- last_accessed_at, aplicada por el servicio al insertar) porque el costo es
-- tamaño, no frescura — un espectro de 1 h ronda los 2 MB de JSON.

CREATE TABLE IF NOT EXISTS fdsn_result_cache (
    cache_key        TEXT PRIMARY KEY,
    payload          JSONB NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- La purga ordena por last_accessed_at; sin este índice cada insert paga un
-- sort completo de la tabla.
CREATE INDEX IF NOT EXISTS idx_fdsn_result_cache_last_accessed
    ON fdsn_result_cache (last_accessed_at);
