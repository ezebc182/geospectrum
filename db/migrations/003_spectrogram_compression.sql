-- 003: compresión nativa de TimescaleDB para spectrogram_columns.
--
-- POR QUÉ EXISTE (volumen al 82 % el 2026-09-06)
--
-- Medido en prod ese día: ~915 MB por chunk diario con ~110 canales vivos
-- escribiendo cada 4 s. Siete días de retención (002) son ~6,4 GB, más el
-- chunk de 7 días heredado de la 001 (`_hyper_1_5_chunk`, 27 ago → 3 sep,
-- 4195 MB) que la retención recién podía dropear el 10 de septiembre. Total:
-- 7,5 GB sobre un volumen de 9,1 GB usables, subiendo 0,9 GB/día. Se llenaba
-- el 8 de septiembre, dos días antes de que la retención lo salvara sola. Y
-- sin el chunk heredado el problema seguía: con el muro completo, 7 días de
-- columnas sin comprimir no entran en 10 GB.
--
-- Cada fila lleva dos REAL[] de ~40 a 51 bins: `freqs` es IDÉNTICO en todas
-- las filas de un canal (es el eje, no la señal) y `power_db` son valores
-- vecinos muy correlacionados. Comprimido por canal (segmentby) y ordenado
-- por tiempo, TimescaleDB guarda el eje una vez por lote y las columnas
-- contiguas se codifican juntas. Medido en prod sobre chunks reales:
-- 915 MB → 197 MB, 918 → 198, 906 → 195 (4,6x), sin perder una fila.
-- Con esto 7 días son ~1,4 GB.
--
-- QUÉ HACE
--
-- 1. Habilita compresión con `segmentby = channel` y `orderby = endtime DESC`.
--    Es la forma de TODAS las lecturas (timescale_service.fetch_history,
--    live_channels, station_uptime.rollup): siempre por canal y rango de
--    tiempo. Un segmento por canal hace que esas consultas abran sólo los
--    lotes del canal pedido. El PK (channel, endtime) queda cubierto por
--    segmentby + orderby, que es lo que TimescaleDB exige para mantener la
--    unicidad en chunks comprimidos.
-- 2. Política: comprimir chunks cuyo `range_end` tenga más de 1 hora, con el
--    job corriendo cada hora. Los chunks son de 1 día (002), así que cada
--    día se comprime a la ~01:00 UTC. El ingestor escribe `endtime = ahora`,
--    nunca vuelve horas atrás; e igual TimescaleDB 2.28 acepta INSERT ...
--    ON CONFLICT en chunks comprimidos, sólo más lento.
--
-- LO QUE COSTÓ APLICARLA (aprender de esto, no repetirlo)
--
-- `compress_chunk` NO comprime en el lugar: ordena el chunk entero por
-- segmentby/orderby (temporales en disco) y escribe el chunk comprimido con
-- WAL de por medio ANTES de liberar el original. Necesita espacio libre del
-- orden del chunk que comprime. El 2026-09-06 se comprimió a mano el chunk
-- heredado de 4195 MB con 2,2 GB libres: el disco llegó a 100 %, Postgres
-- murió con `PANIC: could not write to file "pg_wal/xlogtemp": No space
-- left on device`, hizo recovery automático (1 minuto, la transacción se
-- revirtió sola, sin archivos huérfanos) y volvió. NUNCA comprimir a mano un
-- chunk mayor que el espacio libre. La política de abajo comprime chunks de
-- un día (~1 GB): el margen del volumen tiene que contemplarlo.
--
-- IDEMPOTENCIA: scripts/apply_migrations.py re-ejecuta TODOS los .sql en cada
-- arranque del api. El ALTER va guardado por `compression_enabled` porque
-- prod ya lo tiene aplicado a mano (mismos valores) y con chunks comprimidos
-- presentes. La política sigue el patrón de 002: remove + add para converger
-- al valor de este archivo aunque haya corrido antes con otro (`if_not_exists`
-- solo NO actualiza una política existente). Verificado contra
-- timescale/timescaledb:2.28.3-pg15 (la versión de prod) corriendo 001+002+003
-- tres veces seguidas con chunks comprimidos de por medio.

-- 1. Compresión por canal, ordenada por tiempo. Sólo la primera vez.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM timescaledb_information.hypertables
        WHERE hypertable_name = 'spectrogram_columns'
          AND compression_enabled
    ) THEN
        ALTER TABLE spectrogram_columns SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'channel',
            timescaledb.compress_orderby   = 'endtime DESC'
        );
    END IF;
END
$$;

-- 2. Política horaria: comprime cada chunk diario una hora después de cerrar.
SELECT remove_compression_policy('spectrogram_columns', if_exists => TRUE);

SELECT add_compression_policy(
    'spectrogram_columns',
    compress_after    => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists     => TRUE
);
