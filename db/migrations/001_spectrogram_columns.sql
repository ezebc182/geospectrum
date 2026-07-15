-- Hypertable de historial de espectrogramas en vivo (SeedLink).
-- Cada fila es UNA columna del espectrograma (freqs + power_db van juntos,
-- no normalizados a fila-por-bin: siempre se leen/escriben como unidad).
CREATE TABLE IF NOT EXISTS spectrogram_columns (
    channel     TEXT        NOT NULL,
    endtime     TIMESTAMPTZ NOT NULL,
    freqs       REAL[]      NOT NULL,
    power_db    REAL[]      NOT NULL,
    PRIMARY KEY (channel, endtime)
);

SELECT create_hypertable(
    'spectrogram_columns',
    by_range('endtime'),
    if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_spectrogram_columns_channel_endtime
    ON spectrogram_columns (channel, endtime DESC);

-- Retención: no guardar más de 24h de historial (ver settings.sse_replay_window_hours,
-- que ya usa la misma ventana de 24h para el replay de eventos).
SELECT add_retention_policy(
    'spectrogram_columns',
    INTERVAL '24 hours',
    if_not_exists => TRUE
);
