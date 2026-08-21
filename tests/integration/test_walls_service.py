"""CRUD de muros contra Postgres real: ownership, unicidad de nombre y JSONB."""

import pytest

from src.models.wall import WallPublic
from src.services.wall_service import (
    InvalidWallLayoutError,
    WallNameConflictError,
    WallNotFoundError,
    WallService,
)

pytestmark = pytest.mark.asyncio

LAYOUT = {
    "columns": [
        {"groups": [{"title": "ASIA", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "Tokyo"}]}]}
    ],
    "showMetrics": False,
}


@pytest.fixture
async def service(db_pool):
    return WallService(db_pool)


@pytest.fixture
async def user_id(db_pool):
    return await db_pool.fetchval(
        "INSERT INTO users (email, password_hash, role) VALUES ('walls-a@example.com', 'x', 'viewer') RETURNING id"
    )


@pytest.fixture
async def other_user_id(db_pool):
    return await db_pool.fetchval(
        "INSERT INTO users (email, password_hash, role) VALUES ('walls-b@example.com', 'x', 'viewer') RETURNING id"
    )


class TestCrud:
    async def test_create_devuelve_wall_con_layout_decodificado(self, service, user_id):
        wall = await service.create(user_id, "Mi muro", LAYOUT)
        assert isinstance(wall, WallPublic)
        # asyncpg devuelve JSONB como str: el service debe decodificarlo a dict
        assert wall.layout == LAYOUT
        assert wall.name == "Mi muro"

    async def test_list_devuelve_solo_los_propios_ordenados_por_nombre(self, service, user_id, other_user_id):
        await service.create(user_id, "Zeta", LAYOUT)
        await service.create(user_id, "Alfa", LAYOUT)
        await service.create(other_user_id, "Ajeno", LAYOUT)
        walls = await service.list_for_user(user_id)
        assert [w.name for w in walls] == ["Alfa", "Zeta"]

    async def test_update_reemplaza_nombre_y_layout(self, service, user_id):
        wall = await service.create(user_id, "Viejo", LAYOUT)
        nuevo_layout = {"columns": [{"groups": []}], "showMetrics": True}
        updated = await service.update(wall.id, user_id, "Nuevo", nuevo_layout)
        assert updated.name == "Nuevo"
        assert updated.layout == nuevo_layout
        assert updated.updated_at >= wall.updated_at

    async def test_delete_borra(self, service, user_id):
        wall = await service.create(user_id, "Efímero", LAYOUT)
        await service.delete(wall.id, user_id)
        assert await service.list_for_user(user_id) == []


class TestOwnership:
    async def test_update_de_muro_ajeno_da_not_found(self, service, user_id, other_user_id):
        wall = await service.create(other_user_id, "Ajeno", LAYOUT)
        with pytest.raises(WallNotFoundError):
            await service.update(wall.id, user_id, "Robado", LAYOUT)

    async def test_delete_de_muro_ajeno_da_not_found(self, service, user_id, other_user_id):
        wall = await service.create(other_user_id, "Ajeno", LAYOUT)
        with pytest.raises(WallNotFoundError):
            await service.delete(wall.id, user_id)
        # y el muro sigue existiendo para su dueño
        assert len(await service.list_for_user(other_user_id)) == 1


class TestReglas:
    async def test_nombre_duplicado_mismo_usuario_da_conflicto(self, service, user_id):
        await service.create(user_id, "Único", LAYOUT)
        with pytest.raises(WallNameConflictError):
            await service.create(user_id, "Único", LAYOUT)

    async def test_mismo_nombre_en_usuarios_distintos_es_valido(self, service, user_id, other_user_id):
        await service.create(user_id, "Compartido", LAYOUT)
        wall = await service.create(other_user_id, "Compartido", LAYOUT)
        assert wall.name == "Compartido"

    async def test_rename_a_nombre_ocupado_da_conflicto(self, service, user_id):
        await service.create(user_id, "Ocupado", LAYOUT)
        wall = await service.create(user_id, "Libre", LAYOUT)
        with pytest.raises(WallNameConflictError):
            await service.update(wall.id, user_id, "Ocupado", LAYOUT)

    async def test_layout_invalido_no_llega_a_la_base(self, service, user_id):
        with pytest.raises(InvalidWallLayoutError):
            await service.create(user_id, "Roto", {"columns": [], "showMetrics": False})
        assert await service.list_for_user(user_id) == []
