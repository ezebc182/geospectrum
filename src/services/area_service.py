"""
Acceso a datos de áreas de interés (AOI-1).

Clase con pool inyectado, igual que AuthService —y no funciones libres como
report_service— porque acá hay estado (la conexión) y el pool lo crea el
lifespan (ver src/main.py). El pool es PRESTADO: este servicio nunca lo cierra.

AUTORIZACIÓN POR OWNERSHIP, NO POR ROL. src/api/deps.py:8-9 reservaba
require_min_role para "endpoints futuros (regiones, dashboards personalizados)",
pero para áreas PROPIAS la pregunta correcta es "¿es tuya?" y no "¿qué rol
tenés?": un viewer tiene todo el derecho de crear y editar sus áreas. Por eso
las queries filtran por owner_id y no se apoyan en la jerarquía de roles.
require_min_role queda reservado para un futuro endpoint de creación de
presets del sistema (is_system=true), fuera del alcance de AOI-1.

El bbox NUNCA lo manda el cliente: se deriva de la geometría con
geo_filter.bbox_of() en cada escritura. Es lo que garantiza el invariante del
que depende el filtro de dos etapas —si el bbox fuera más chico que la
geometría, point_in_area() descartaría eventos que sí están dentro del área
(ver tests/unit/test_geo_filter.py::test_point_in_area_bbox_incoherente_...).
"""

from __future__ import annotations

import json
from typing import Any, Optional
from uuid import UUID

import asyncpg

from src.models.area import AreaBbox, AreaPublic
from src.services.geo_filter import bbox_of

# Preset que se usa cuando el usuario no eligió ninguno (users.active_area_id
# IS NULL). DEBE coincidir con `default_slug` del catálogo generado por
# scripts/build_areas_of_interest.py — scripts/seed_areas_of_interest.py aborta
# si se desincronizan, porque si no get_default() falla recién en runtime.
#
# Es "global" y no una región concreta. La versión anterior de esta constante
# era `andes_argentina_chile`, para que el default replicara el bbox fijo de
# settings.region_* y ningún usuario existente percibiera un cambio. Se
# descartó: el sistema no tiene ninguna señal de dónde está el usuario (no hay
# geolocalización ni país en `users`), así que cualquier default regional le
# impone una región ajena a la mayoría —un usuario de California no tiene por
# qué ver los Andes—. Global es la única opción neutral, y es coherente con la
# Decisión #1 de AOI-1 (ingesta global, filtro al leer).
#
# El costo de la decisión —cambiarle el área a un usuario preexistente— es
# nulo en la práctica: al tomarla había 2 usuarios en la base, ambos con
# active_area_id NULL. Defaultear por geolocalización es un feature propio,
# fuera del alcance de AOI-1.
DEFAULT_AREA_SLUG = "global"


class AreaNotFoundError(Exception):
    """El área no existe, o existe pero no es visible para este usuario.

    Deliberadamente NO se distingue "no existe" de "es de otro" — devolver 404
    en ambos casos evita filtrar la existencia de áreas ajenas por diferencia
    de código de estado.
    """


class SystemAreaNotEditableError(Exception):
    """Intento de modificar o borrar un preset del sistema."""


class DefaultAreaMissingError(Exception):
    """No existe el preset por defecto en la base.

    Es un error de configuración del servidor (falta correr el seed), no una
    condición de usuario: se propaga como 500, no como 404. Mismo criterio que
    la resolución de AuthService en src/api/deps.py:14-17.
    """


def _row_to_public(row: asyncpg.Record) -> AreaPublic:
    """Mapea una fila de areas_of_interest al modelo público.

    `geometry` sale de JSONB: asyncpg lo entrega como str (no decodifica JSONB
    a dict por defecto, a diferencia de psycopg), así que se parsea acá. Es el
    tipo de detalle que, si se olvida, hace que el frontend reciba un string
    donde espera un GeoJSON.
    """
    geometry = row["geometry"]
    if isinstance(geometry, str):
        geometry = json.loads(geometry)

    return AreaPublic(
        id=row["id"],
        slug=row["slug"],
        name=row["name"],
        is_system=row["is_system"],
        geometry=geometry,
        bbox=AreaBbox(
            minlat=row["bbox_minlat"],
            maxlat=row["bbox_maxlat"],
            minlon=row["bbox_minlon"],
            maxlon=row["bbox_maxlon"],
        ),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


_SELECT_COLUMNS = """
    id, slug, name, is_system, geometry,
    bbox_minlat, bbox_maxlat, bbox_minlon, bbox_maxlon,
    created_at, updated_at
"""

# Variante calificada, obligatoria en el JOIN de get_active(): `users` también
# tiene `id`, `name` y `created_at`, así que sin el prefijo Postgres rechaza la
# query con AmbiguousColumnError.
_SELECT_COLUMNS_QUALIFIED = """
    a.id, a.slug, a.name, a.is_system, a.geometry,
    a.bbox_minlat, a.bbox_maxlat, a.bbox_minlon, a.bbox_maxlon,
    a.created_at, a.updated_at
"""


def _slugify(name: str, owner_id: UUID) -> str:
    """Slug de un área de usuario.

    Sólo los presets del sistema tienen unicidad de slug (índice parcial
    idx_aoi_system_slug), así que acá no hace falta garantizar unicidad
    global: el slug de un área propia es un identificador legible, no una
    clave. Se prefija con el owner para que siga siendo razonablemente único
    en logs sin necesidad de consultar la base.
    """
    base = "".join(c if c.isalnum() else "-" for c in name.lower()).strip("-")
    base = "-".join(filter(None, base.split("-")))[:60] or "area"
    return f"{base}-{str(owner_id)[:8]}"


class AreaService:
    """Operaciones de lectura y escritura sobre areas_of_interest."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        """
        Args:
            pool: pool de asyncpg creado por el lifespan. PRESTADO — este
                servicio no lo crea ni lo cierra (ver src/main.py y la
                bandera _owns_pool de AuthService).
        """
        self._pool = pool

    # -------------------------------------------------------------------
    # Lectura
    # -------------------------------------------------------------------

    async def list_for_user(self, user_id: UUID) -> list[AreaPublic]:
        """Presets del sistema + áreas propias del usuario.

        Los presets van primero y después las propias, ambos por nombre: el
        orden lo fija la query y no el cliente, así el frontend puede
        renderizar la lista tal cual llega.
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT {_SELECT_COLUMNS}
                FROM areas_of_interest
                WHERE is_system OR owner_id = $1
                ORDER BY is_system DESC, name ASC
                """,
                user_id,
            )
        return [_row_to_public(r) for r in rows]

    async def get_visible(self, area_id: UUID, user_id: UUID) -> AreaPublic:
        """Un área, si el usuario puede verla (preset del sistema o propia).

        Raises:
            AreaNotFoundError: no existe o es de otro usuario
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                SELECT {_SELECT_COLUMNS}
                FROM areas_of_interest
                WHERE id = $1 AND (is_system OR owner_id = $2)
                """,
                area_id,
                user_id,
            )
        if row is None:
            raise AreaNotFoundError(f"Area {area_id} not found")
        return _row_to_public(row)

    async def get_default(self) -> AreaPublic:
        """El preset por defecto (DEFAULT_AREA_SLUG).

        Raises:
            DefaultAreaMissingError: falta el seed del catálogo
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                SELECT {_SELECT_COLUMNS}
                FROM areas_of_interest
                WHERE is_system AND slug = $1
                """,
                DEFAULT_AREA_SLUG,
            )
        if row is None:
            raise DefaultAreaMissingError(
                f"Default system preset {DEFAULT_AREA_SLUG!r} is missing — "
                "run the areas_of_interest seed (scripts/seed_areas_of_interest.py)"
            )
        return _row_to_public(row)

    async def get_active(self, user_id: UUID) -> tuple[AreaPublic, bool]:
        """Área activa del usuario, con el default como fallback.

        Una sola query con LEFT JOIN en vez de "leer users, después leer el
        área": evita el round-trip extra y, sobre todo, la condición de
        carrera de que el área se borre entre ambas lecturas.

        Returns:
            (área, is_default) — is_default=True cuando el usuario no tiene
            selección explícita y está viendo el preset por defecto.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                SELECT {_SELECT_COLUMNS_QUALIFIED}
                FROM users u
                JOIN areas_of_interest a ON a.id = u.active_area_id
                WHERE u.id = $1
                """,
                user_id,
            )
        if row is not None:
            return _row_to_public(row), False
        return await self.get_default(), True

    # -------------------------------------------------------------------
    # Escritura
    # -------------------------------------------------------------------

    async def create(self, user_id: UUID, name: str, geometry: dict) -> AreaPublic:
        """Crea un área propia del usuario.

        El bbox se deriva de la geometría; el cliente no puede declararlo.

        Raises:
            InvalidGeometryError: la geometría no es un Polygon/MultiPolygon
                interpretable (se propaga desde geo_filter.bbox_of)
        """
        bbox = bbox_of(geometry)  # valida la geometría de paso
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                INSERT INTO areas_of_interest
                    (slug, name, owner_id, is_system, geometry,
                     bbox_minlat, bbox_maxlat, bbox_minlon, bbox_maxlon)
                VALUES ($1, $2, $3, false, $4::jsonb, $5, $6, $7, $8)
                RETURNING {_SELECT_COLUMNS}
                """,
                _slugify(name, user_id),
                name,
                user_id,
                json.dumps(geometry),
                bbox["minlat"],
                bbox["maxlat"],
                bbox["minlon"],
                bbox["maxlon"],
            )
        return _row_to_public(row)

    async def update(
        self,
        area_id: UUID,
        user_id: UUID,
        name: Optional[str] = None,
        geometry: Optional[dict] = None,
    ) -> AreaPublic:
        """Actualiza parcialmente un área propia.

        Si viene `geometry`, los bbox_* se recalculan en el mismo UPDATE: no
        pueden quedar desfasados respecto de la geometría.

        Raises:
            AreaNotFoundError: no existe o es de otro usuario
            SystemAreaNotEditableError: es un preset del sistema
            InvalidGeometryError: geometría no interpretable
        """
        await self._assert_owned(area_id, user_id)

        sets: list[str] = []
        params: list[Any] = []

        if name is not None:
            params.append(name)
            sets.append(f"name = ${len(params)}")

        if geometry is not None:
            bbox = bbox_of(geometry)
            params.append(json.dumps(geometry))
            sets.append(f"geometry = ${len(params)}::jsonb")
            for key in ("minlat", "maxlat", "minlon", "maxlon"):
                params.append(bbox[key])
                sets.append(f"bbox_{key} = ${len(params)}")

        if not sets:
            # PATCH vacío: no es un error, simplemente no hay nada que cambiar.
            return await self.get_visible(area_id, user_id)

        sets.append("updated_at = now()")
        params.extend([area_id, user_id])

        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"""
                UPDATE areas_of_interest
                SET {', '.join(sets)}
                WHERE id = ${len(params) - 1} AND owner_id = ${len(params)}
                RETURNING {_SELECT_COLUMNS}
                """,
                *params,
            )
        if row is None:
            raise AreaNotFoundError(f"Area {area_id} not found")
        return _row_to_public(row)

    async def delete(self, area_id: UUID, user_id: UUID) -> None:
        """Borra un área propia.

        Si era la activa del usuario, `users.active_area_id` queda en NULL por
        el ON DELETE SET NULL de la migración 006 y el usuario vuelve al
        preset por defecto — no queda apuntando a un área inexistente.

        Raises:
            AreaNotFoundError: no existe o es de otro usuario
            SystemAreaNotEditableError: es un preset del sistema
        """
        await self._assert_owned(area_id, user_id)
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM areas_of_interest WHERE id = $1 AND owner_id = $2",
                area_id,
                user_id,
            )
        if result == "DELETE 0":
            raise AreaNotFoundError(f"Area {area_id} not found")

    async def set_active(self, user_id: UUID, area_id: Optional[UUID]) -> None:
        """Fija el área activa del usuario. `area_id=None` vuelve al default.

        Valida la visibilidad ANTES de escribir: sin ese chequeo, un usuario
        podría activar el área de otro pasando su UUID —la FK de la base
        acepta cualquier id existente, no distingue de quién es.

        Raises:
            AreaNotFoundError: el área no existe o no es visible
        """
        if area_id is not None:
            await self.get_visible(area_id, user_id)  # levanta si no es visible

        async with self._pool.acquire() as conn:
            await conn.execute(
                "UPDATE users SET active_area_id = $1, updated_at = now() WHERE id = $2",
                area_id,
                user_id,
            )

    # -------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------

    async def _assert_owned(self, area_id: UUID, user_id: UUID) -> None:
        """Verifica que el área exista y sea editable por este usuario.

        Distingue los dos motivos de rechazo porque el caller los mapea a
        códigos distintos: 403 para un preset del sistema (existe, es visible,
        pero nadie lo edita) y 404 para un área ajena o inexistente.
        """
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT is_system, owner_id FROM areas_of_interest WHERE id = $1",
                area_id,
            )
        if row is None:
            raise AreaNotFoundError(f"Area {area_id} not found")
        if row["is_system"]:
            raise SystemAreaNotEditableError(
                f"Area {area_id} is a system preset and cannot be modified"
            )
        if row["owner_id"] != user_id:
            raise AreaNotFoundError(f"Area {area_id} not found")
