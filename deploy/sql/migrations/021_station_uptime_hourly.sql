-- 021: historial horario de disponibilidad por canal
-- (change analytics-professional-panels, Decision 2 del design).
--
-- Por qué una tabla PLANA y no otra cosa:
--   * La evidencia de "canal vivo" ya existe: una fila en spectrogram_columns
--     cada COLUMN_INTERVAL_SECONDS (4 s) por canal. Pero esa tabla vive en
--     db/migrations/ (Timescale), tiene retención de 7 días y NO la aplica
--     tests/conftest.py. Un rollup horario acá (deploy/sql/migrations/, el
--     único directorio que la suite aplica) es testeable y no caduca.
--   * No es un continuous aggregate de Timescale: heredaría la retención de
--     la raw y no se puede probar en el testcontainer postgres:16-alpine.
--   * No es Redis: un flush borraría la historia.
--   * No sale del watchdog: el watchdog vigila SERVICIOS (api, ui, seedlink,
--     events), no estaciones, y sólo guarda el último estado.
--
-- Volumen: ~107 canales x 24 h x 365 d ~ 940 k filas/año, decenas de MB.
-- Sin retención a propósito. El índice por bucket_start sirve a la lectura
-- por rango de /analytics/station-uptime; la PK (channel, bucket_start) es
-- la clave del upsert idempotente del rollup (ON CONFLICT ... DO UPDATE).
-- `IF NOT EXISTS` la vuelve idempotente, como el resto de las migraciones.

CREATE TABLE IF NOT EXISTS station_uptime_hourly (
    channel       TEXT        NOT NULL,
    bucket_start  TIMESTAMPTZ NOT NULL,
    columns_count INTEGER     NOT NULL CHECK (columns_count >= 0),
    PRIMARY KEY (channel, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_station_uptime_hourly_bucket
    ON station_uptime_hourly (bucket_start);

-- Rollback: DROP TABLE IF EXISTS station_uptime_hourly;
