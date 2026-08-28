-- 002: chunks de 1 día y retención de 7 días para spectrogram_columns.
--
-- POR QUÉ EXISTE (caída de producción del 2026-08-28)
--
-- La 001 creó la hypertable sin `chunk_time_interval`, así que tomó el default
-- de TimescaleDB: 7 días por chunk. Y TimescaleDB sólo dropea chunks ENTEROS.
-- Con retención de 24h eso significaba que un chunk recién era candidato a
-- borrarse 7 días + 24h después de abrirse: se pedían 24h de historial y se
-- guardaban hasta 8 días. Medido en prod: `_hyper_1_4_chunk` (20→27 ago) pesaba
-- 3960 MB y `_hyper_1_5_chunk` 569 MB, sobre un volumen de 4,5 GB.
--
-- El disco llegó a 100% y Postgres entró en crash-loop: el redo del WAL
-- terminaba bien, pero el checkpoint de fin de recovery no podía escribir
-- (`PANIC: could not write to file "pg_logical/replorigin_checkpoint.tmp":
-- No space left on device`), el checkpointer moría con señal 6 y el ciclo se
-- repetía ~1 vez por segundo. La base no salía sola: no arrancaba porque no
-- podía escribir el checkpoint, y ese checkpoint era lo que habría liberado
-- espacio. El job de retención NO estaba roto — `job_stats` lo mostraba con
-- `Success` y 0 fallas. El bug era el tamaño del chunk, no la política.
--
-- QUÉ HACE
--
-- 1. Chunks de 1 día: la retención pasa a borrar de verdad, todos los días, en
--    vez de esperar a que se cierre una ventana de 7. Sólo afecta a los chunks
--    NUEVOS; los ya creados conservan su rango (por eso el paso 3).
-- 2. Retención de 7 días en vez de 24h: es una decisión de producto, no
--    técnica. El muro en vivo quiere "qué está pasando"; una semana completa
--    cubre la revisión humana de "qué pasó". Más atrás se reconstruye desde
--    FDSN, que es la fuente de verdad y guarda décadas — acá sólo vive una
--    caché de columnas ya computadas. A ~0,9 GB/día medidos, 7 días son ~6,5 GB
--    y entran en el volumen de 10 GB.
--    OJO: el análisis histórico del asistente sísmico NO depende de esta tabla
--    sino de `seismic_events` (1,1 MB por año, sin retención): son eventos con
--    semántica, no arrays de potencia por frecuencia.
--
-- IDEMPOTENCIA: scripts/apply_migrations.py NO lleva tabla de versiones —
-- re-ejecuta TODOS los .sql en cada arranque del api. Todo lo de abajo tiene
-- que poder correr N veces sin fallar ni duplicar. Verificado en la instancia
-- de prod corriendo el archivo dos veces seguidas con ON_ERROR_STOP=1 dentro de
-- una transacción con ROLLBACK: ambas pasadas completas y UNA sola política al
-- final.
--
-- LO QUE COSTÓ APLICARLA (aprender de esto, no repetirlo)
--
-- `add_retention_policy` EJECUTA la política en el momento de registrarse, y
-- TimescaleDB decide el drop por el `range_start` del chunk, no por su
-- `range_end`. Al aplicar esta migración todavía existía el chunk viejo de 7
-- días (20→27 ago): su inicio caía fuera de la ventana de 7 días, así que se
-- dropeó ENTERO y se llevó puestos también los días 21 al 27, que sí estaban
-- dentro de la ventana y debían sobrevivir. Se perdieron ~6 días de columnas
-- (reconstruibles desde FDSN; `seismic_events`, `signal_picks` y
-- `window_comments` no se tocaron).
--
-- Es el mismo bug que esta migración viene a arreglar, mordiendo una última vez
-- al salir: con chunks de 7 días la retención es todo-o-nada. El orden correcto
-- habría sido migrar los datos del chunk viejo a chunks nuevos ANTES de
-- registrar la política. De acá en más el daño máximo por drop es 1 día.

-- 1. Chunks de 1 día para todo lo que se cree de ahora en más.
--    Idempotente por naturaleza: fija un valor, no acumula estado.
SELECT set_chunk_time_interval('spectrogram_columns', INTERVAL '1 day');

-- 2. Retención a 7 días. `add_retention_policy` con `if_not_exists => TRUE` NO
--    actualiza una política existente con otro `drop_after`: la deja como está
--    y avisa. Por eso se borra primero — así la migración converge al valor de
--    este archivo aunque haya corrido antes con otro.
SELECT remove_retention_policy('spectrogram_columns', if_exists => TRUE);

SELECT add_retention_policy(
    'spectrogram_columns',
    INTERVAL '7 days',
    if_not_exists => TRUE
);
