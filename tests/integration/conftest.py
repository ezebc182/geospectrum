"""Fixtures propias de los tests de integración.

Los fixtures de Postgres real (`postgres_container`, `postgres_dsn`,
`_migrated`, `db_pool`) SE MUDARON a tests/conftest.py (un nivel arriba) para
que los tests unitarios de email-invitations también los usen — pytest los
resuelve por jerarquía de directorios, así que siguen disponibles acá sin
importar nada. La motivación es la misma que los trajo al proyecto: los mocks
de asyncpg son ciegos a los errores de SQL, validan que se llame al pool y no
que la query sea correcta contra un motor real.

Queda acá lo exclusivo de integración: Redis.
"""

import pytest
import redis.asyncio as aioredis
from testcontainers.redis import RedisContainer


@pytest.fixture(scope="session")
def redis_container():
    container = RedisContainer("redis:7-alpine")
    container.start()
    yield container
    container.stop()


@pytest.fixture(scope="session")
def redis_url(redis_container):
    host = redis_container.get_container_host_ip()
    port = redis_container.get_exposed_port(6379)
    return f"redis://{host}:{port}/0"


@pytest.fixture
async def redis_client(redis_url):
    client = aioredis.from_url(redis_url, decode_responses=True)
    await client.flushdb()
    yield client
    await client.flushdb()
    await client.aclose()
