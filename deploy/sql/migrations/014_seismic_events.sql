-- deploy/sql/migrations/014_seismic_events.sql
--
-- Eventos sísmicos persistidos (PR-W4, spec 2026-08-20-spectronet-wall-design.md §5).
--
-- Por qué existe: hasta acá los eventos eran 100% efímeros —fetch a USGS/EMSC,
-- merge en memoria, caché TTL 30 s, response—. El worker de push publica a
-- Redis Pub/Sub, que es fire-and-forget: un subscriber atrasado PIERDE
-- mensajes. Para columnas de espectrograma da igual (la siguiente llega en 1 s);
-- un evento sísmico importa individualmente. Esta tabla es lo que hace
-- aceptable el pub/sub: el snapshot de /ws/events sale de acá, así un cliente
-- que reconecta recupera lo que se perdió mientras estaba desconectado.
--
-- Por qué en deploy/sql/migrations y no en db/migrations aunque sea "dato
-- sísmico": tests/conftest.py:26 sólo aplica deploy/sql/migrations. Una tabla
-- en db/ no existiría en los tests con Postgres real — elegir el otro
-- directorio sería elegir no poder testear.
--
-- El id es el canonical_id (ver src/services/canonical_event_id.py), NO el id
-- de una fuente: el mismo sismo llega como usgs_us7000abcd y emsc_1234567 y
-- tiene que ocupar UNA fila. `fuentes` acumula de dónde vino.
--
-- Sin FK a users: los eventos son globales y públicos, no pertenecen a nadie
-- (misma política que /spectrograms y /stations).

CREATE TABLE IF NOT EXISTS seismic_events (
    id         TEXT PRIMARY KEY,
    fuentes    TEXT[] NOT NULL DEFAULT '{}',
    hora_utc   TIMESTAMPTZ NOT NULL,
    lat        DOUBLE PRECISION NOT NULL,
    lon        DOUBLE PRECISION NOT NULL,
    prof_km    DOUBLE PRECISION,
    mag        DOUBLE PRECISION NOT NULL,
    mag_tipo   TEXT,
    lugar      TEXT,
    sentido    BOOLEAN NOT NULL DEFAULT FALSE,
    revisado   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- La consulta del snapshot es siempre "últimas N horas, magnitud >= M, más
-- reciente primero". El índice compuesto la cubre entera sin tocar la tabla.
-- hora_utc DESC porque ese es el orden en que se lee, nunca ascendente.
CREATE INDEX IF NOT EXISTS seismic_events_hora_mag_idx
    ON seismic_events (hora_utc DESC, mag);

-- Retención/limpieza por antigüedad de ingesta (created_at, no hora_utc: un
-- evento viejo puede llegar hoy por una revisión tardía de EMSC).
CREATE INDEX IF NOT EXISTS seismic_events_created_at_idx
    ON seismic_events (created_at);

-- Rollback:
-- DROP TABLE IF EXISTS seismic_events;
