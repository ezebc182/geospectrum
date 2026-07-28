-- Migration 006: áreas de interés (AOI-1). Reemplaza la región de monitoreo
-- única y fija por áreas seleccionables y propias de cada usuario.
--
-- Ver docs/superpowers/specs/2026-07-27-plate-boundaries-usgs-style-design.md
-- ("Decisiones heredadas: AOI-1") para el detalle de las 9 decisiones que
-- fundamentan este esquema.
--
-- Convención de este proyecto (sin Alembic ni tool de migraciones detectado):
-- archivos numerados `NNN_description.sql` en deploy/sql/migrations/, aplicados
-- manualmente contra el Postgres/TimescaleDB del perfil `storage` en
-- deploy/docker/docker-compose.yml. No editar migraciones ya aplicadas
-- (001-005); esta migración es aditiva y sigue el mismo estilo.
--
-- SIN POSTGIS (Decisión heredada #1). Verificado contra la base corriendo:
-- `postgis` no aparece en `pg_available_extensions` — la imagen
-- `timescale/timescaledb:latest-pg15` no trae los binarios, y
-- `timescale/timescaledb-postgis` está deprecada upstream. De ahí las dos
-- consecuencias de diseño de esta tabla:
--
--   1. `geometry` es JSONB con GeoJSON crudo (RFC 7946), no `geometry(Polygon)`.
--      El punto-en-polígono lo resuelve Shapely en Python (Decisión heredada #2),
--      no `ST_Contains`. Migrable a PostGIS más adelante vía `ST_GeomFromGeoJSON()`
--      sin perder datos.
--   2. Las 4 columnas `bbox_*` NO son denormalización redundante: sin PostGIS no
--      hay índice GiST, así que son el único pre-filtro indexable. Descartan la
--      enorme mayoría de los eventos con comparaciones de floats y Shapely sólo
--      corre sobre los que sobreviven. Se derivan de `geometry` en el service al
--      escribir; nunca las setea el cliente.
--
-- Idempotente: seguro de re-ejecutar (CREATE TABLE/INDEX/ADD COLUMN IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS areas_of_interest (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT NOT NULL,
    name        TEXT NOT NULL,
    -- owner_id NULL ⇔ is_system=true (preset del sistema, visible para todos).
    -- El CHECK de abajo hace de esa equivalencia un invariante de la base, no
    -- una convención que dependa de que el service se acuerde.
    owner_id    UUID REFERENCES users(id) ON DELETE CASCADE,
    is_system   BOOLEAN NOT NULL DEFAULT false,
    geometry    JSONB NOT NULL,
    bbox_minlat REAL NOT NULL,
    bbox_maxlat REAL NOT NULL,
    bbox_minlon REAL NOT NULL,
    bbox_maxlon REAL NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT areas_of_interest_system_has_no_owner
        CHECK ((is_system AND owner_id IS NULL) OR (NOT is_system AND owner_id IS NOT NULL)),
    CONSTRAINT areas_of_interest_bbox_ordered
        CHECK (bbox_minlat < bbox_maxlat AND bbox_minlon < bbox_maxlon),
    CONSTRAINT areas_of_interest_bbox_in_range
        CHECK (bbox_minlat >= -90  AND bbox_maxlat <= 90
           AND bbox_minlon >= -180 AND bbox_maxlon <= 180)
);

-- Unicidad de slug SÓLO entre presets del sistema: dos usuarios distintos
-- pueden tener cada uno su área 'mi-zona' sin colisionar, pero el catálogo
-- curado no admite duplicados. Índice parcial porque `is_system=false` no
-- participa de la restricción.
CREATE UNIQUE INDEX IF NOT EXISTS idx_aoi_system_slug
    ON areas_of_interest (slug) WHERE is_system;

CREATE INDEX IF NOT EXISTS idx_aoi_owner_id ON areas_of_interest (owner_id);

-- Índice del pre-filtro grueso descrito arriba: cubre el patrón de consulta
-- "¿qué áreas podrían contener este evento?" (lat/lon contra el bbox).
CREATE INDEX IF NOT EXISTS idx_aoi_bbox
    ON areas_of_interest (bbox_minlat, bbox_maxlat, bbox_minlon, bbox_maxlon);

-- Selección activa del usuario.
--
-- ON DELETE SET NULL, no CASCADE: si el usuario borra el área que tenía activa,
-- debe caer al preset por defecto — no desaparecer él mismo (que es lo que haría
-- un CASCADE mal puesto acá).
--
-- NULL es un estado legítimo y es el de todo usuario existente tras esta
-- migración: significa "sin selección explícita ⇒ usar el preset por defecto"
-- (andes_argentina_chile, el mismo bbox -40/-20/-75/-60 que estaba fijo en
-- settings.region_*). Por eso NO se hace backfill: el default se resuelve en
-- lectura, y así un cambio futuro del preset por defecto no requiere reescribir
-- la tabla `users`.
ALTER TABLE users ADD COLUMN IF NOT EXISTS active_area_id UUID
    REFERENCES areas_of_interest(id) ON DELETE SET NULL;

-- El seed del catálogo curado (~16 regiones sísmicas, Decisión heredada #4) NO
-- va en este archivo: son polígonos GeoJSON, algunos MultiPolygon partidos en el
-- antimeridiano (Decisión heredada #5), imposibles de mantener a mano en SQL.
-- Se generan con scripts/build_areas_of_interest.py y se cargan con
-- scripts/seed_areas_of_interest.py, mismo criterio que plate_boundaries.json
-- (que se genera con scripts/build_plate_boundaries.py y no se edita a mano).

-- Rollback:
-- ALTER TABLE users DROP COLUMN IF EXISTS active_area_id;
-- DROP TABLE IF EXISTS areas_of_interest;
