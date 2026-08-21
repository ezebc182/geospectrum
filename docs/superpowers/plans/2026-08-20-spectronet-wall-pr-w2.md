# PR-W2 — Tabla `walls` + CRUD + armador manual + selector de muro: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El usuario arma y guarda muros SPECTRONET propios (tabla `walls` server-side con ownership), los edita con un armador manual en `/spectrograms-live` con preview en vivo, y los elige en la cartelera de `/globe` (persistido en localStorage + `?wall=` para kiosks).

**Architecture:** Backend calca el patrón AOI: migración SQL idempotente, service asyncpg con ownership en el WHERE, router con excepciones→HTTP. El endpoint `/walls/global` existente se muda al router nuevo (estático antes que paramétrico). Frontend: cliente `lib/walls.ts` calcado de `lib/areas.ts`, lib pura de edición de layout (inmutable, TDD con mutación), armador controlado + manager con SWR, y selector en el overlay clonando el patrón de `readFocusMode`.

**Tech Stack:** FastAPI + asyncpg (sin ORM); Next.js 15 App Router + SWR + next-intl; vitest/pytest con testcontainers.

**Spec:** `docs/superpowers/specs/2026-08-20-spectronet-wall-design.md` (§2 y §6/PR-W2)

## Global Constraints

- Rama: `feat/spectronet-wall-w2` desde `main`.
- **Decisión de contrato (resuelve discrepancia spec §2 vs PR-W1):** `layout.columns[].groups[].channels` se persiste como **objetos `{channel, label}`** (lo que implementó PR-W1 y consume `SpectronetWall`/`WallResponse` en `dashboard/lib/types.ts:315-333`), NO como `string[]` del ejemplo del spec. La paridad de forma con `GET /walls/global` es lo que permite un solo componente de render.
- Validación server-side (spec §2): máx. **8 columnas**, máx. **120 canales** por muro, canales formato **SCNL** (`NET.STA.LOC.CHA`, LOC puede ser vacío: `JP.JYT..BHZ` existe en el catálogo).
- El muro default "Global" (`id` reservado `global`) NO es una fila de la tabla: sigue generándose de `build_global_wall()`.
- Migraciones: SQL puro idempotente en `deploy/sql/migrations/`, numeración 3 dígitos (la próxima es **013**), bloque de comentarios justificatorio + `-- Rollback:` comentado. No hay tabla de versiones.
- Ownership: en el WHERE de cada query (patrón `AreaService`), 404 unificado para "no existe" y "es de otro" (no filtrar existencia de recursos ajenos).
- `DELETE` con 204 **sin anotación de retorno** en el router (un `-> None` aborta el arranque de FastAPI).
- Rutas estáticas antes que paramétricas dentro del router (gotcha documentado en `areas.py`).
- JSONB con asyncpg: escribir con `json.dumps(...)` + cast `$N::jsonb`; al leer, `json.loads` si viene `str` (asyncpg no decodifica JSONB).
- Frontend: `credentials: 'include'` en TODA llamada autenticada; bodies en snake_case; mocks de router/searchParams con **referencia estable** (`vi.hoisted`); i18n paridad `es.json`/`en.json` (hay parity test + tipado en `global.d.ts`: agregar claves en ambos o no compila/falla).
- Identificadores en inglés, comentarios en español; TDD estricto; sin atribución de IA en commits.
- Tests backend: `./venv/bin/python -m pytest tests/... -q --no-cov` (venv en `venv/`, Docker arriba para testcontainers). Frontend: `cd dashboard && npx vitest run <archivo>`.
- Anclas verificadas (2026-08-20): última migración `deploy/sql/migrations/012_user_deactivation.sql`; `AreaService` en `src/services/area_service.py`; `get_current_user` en `src/api/deps.py`; routers registrados en `src/main.py:424-427`; lifespan servicios `src/main.py:270-330`; `@app.get("/walls/global")` en `src/main.py:2201-2206`; `build_global_wall` en `src/services/wall_service.py`; `WallResponse` en `dashboard/lib/types.ts:315-333`; `useSWR('broadcast-wall', ...)` en `dashboard/components/GlobeBroadcastOverlay.tsx:168`; popover de config L671-748 (radiogroup de focus L702-720); página `dashboard/app/(app)/spectrograms-live/page.tsx`; patrón tabs `?tab=` en `dashboard/app/(app)/admin/access/page.tsx`; `_LazyPool` y `_login_as` en `tests/integration/test_invitations_api.py`.

---

### Task 1: Migración `013_walls.sql` + validación pura del layout

**Files:**
- Create: `deploy/sql/migrations/013_walls.sql`
- Modify: `src/services/wall_service.py` (agregar validación al final del módulo)
- Test: `tests/unit/test_wall_layout_validation.py`

**Interfaces:**
- Produces: `validate_wall_layout(layout: object) -> None` que levanta `InvalidWallLayoutError(ValueError)` con mensaje descriptivo; constantes `MAX_WALL_COLUMNS = 8`, `MAX_WALL_CHANNELS = 120`, `MAX_WALL_TEXT_LEN = 40`. Task 2 la llama en create/update; Task 3 mapea la excepción a 422.
- Produces: tabla `walls` (id UUID PK, user_id FK→users ON DELETE CASCADE, name TEXT, layout JSONB, created_at/updated_at TIMESTAMPTZ, unique (user_id, name) por índice).

- [ ] **Step 1: Escribir la migración**

```sql
-- deploy/sql/migrations/013_walls.sql
--
-- Muros SPECTRONET por usuario (PR-W2, spec 2026-08-20-spectronet-wall-design.md §2).
--
-- Por qué tabla propia y no un JSON en users.settings: los muros son N por
-- usuario, con nombre único por dueño y edición por id desde el armador.
-- El layout viaja como JSONB opaco: la validación semántica (máx. columnas,
-- máx. canales, formato SCNL) vive en la app, igual que la geometría de
-- areas_of_interest. El muro default "Global" NO es una fila: se genera del
-- catálogo en wall_service.build_global_wall() (id reservado "global").
--
-- UNIQUE (user_id, name) va como índice separado (no constraint inline) para
-- que la migración sea re-ejecutable con IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS walls (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    layout     JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS walls_user_id_name_key ON walls (user_id, name);
CREATE INDEX IF NOT EXISTS walls_user_id_idx ON walls (user_id);

-- Rollback:
-- DROP TABLE IF EXISTS walls;
```

- [ ] **Step 2: Escribir los tests de validación que fallan**

```python
# tests/unit/test_wall_layout_validation.py
"""Validación server-side del layout de muro (spec §2: 8 columnas, 120 canales, SCNL)."""

import pytest

from src.services.wall_service import (
    MAX_WALL_CHANNELS,
    MAX_WALL_COLUMNS,
    InvalidWallLayoutError,
    validate_wall_layout,
)


def _layout(columns=None, show_metrics=False):
    if columns is None:
        columns = [
            {"groups": [{"title": "ASIA", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "Tokyo"}]}]}
        ]
    return {"columns": columns, "showMetrics": show_metrics}


def test_layout_valido_pasa():
    validate_wall_layout(_layout())  # no levanta


def test_loc_vacio_es_valido():
    # JP.JYT..BHZ existe en LIVE_CANDIDATES_BY_CITY: LOC vacío es legal en SCNL
    validate_wall_layout(
        _layout([{"groups": [{"title": "ASIA", "channels": [{"channel": "JP.JYT..BHZ", "label": "Tokyo"}]}]}])
    )


def test_muro_vacio_es_valido():
    # Un muro a medio armar se puede guardar (columna con grupo sin canales)
    validate_wall_layout(_layout([{"groups": [{"title": "NUEVO", "channels": []}]}]))
    validate_wall_layout(_layout([{"groups": []}]))


@pytest.mark.parametrize(
    "bad",
    ["", "IU.MAJO.00", "iu.majo.00.bhz", "IU.MAJO.00.BHZZ", "IU MAJO 00 BHZ", "TOOLONG.MAJO.00.BHZ", "IU.MAJO.00.BHZ.EXTRA"],
)
def test_canal_no_scnl_rechazado(bad):
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": [{"channel": bad, "label": "x"}]}]}]))


def test_canal_como_string_pelado_rechazado():
    # Decisión de contrato: channels son objetos {channel, label}, no strings
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": ["IU.MAJO.00.BHZ"]}]}]))


def test_mas_de_ocho_columnas_rechazado():
    cols = [{"groups": []} for _ in range(MAX_WALL_COLUMNS + 1)]
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout(cols))


def test_mas_de_120_canales_rechazado():
    chans = [{"channel": f"IU.S{i:03d}.00.BHZ", "label": f"s{i}"} for i in range(MAX_WALL_CHANNELS + 1)]
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "X", "channels": chans}]}]))


def test_estructura_rota_rechazada():
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout({"showMetrics": False})  # sin columns
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout({"columns": [], "showMetrics": False})  # columns vacía
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout(show_metrics="yes"))  # showMetrics no bool
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"sin_groups": True}]))
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout("no soy un dict")


def test_titulo_de_grupo_y_label_obligatorios_y_acotados():
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(_layout([{"groups": [{"title": "  ", "channels": []}]}]))
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(
            _layout([{"groups": [{"title": "X", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": ""}]}]}])
        )
    with pytest.raises(InvalidWallLayoutError):
        validate_wall_layout(
            _layout([{"groups": [{"title": "X", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "x" * 41}]}]}])
        )
```

- [ ] **Step 3: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/unit/test_wall_layout_validation.py -q --no-cov`
Expected: FAIL con `ImportError` (no existe `validate_wall_layout`)

- [ ] **Step 4: Implementar la validación** (agregar al final de `src/services/wall_service.py`)

```python
import re

# --- Validación de layouts de muros guardados (PR-W2, spec §2) ---

MAX_WALL_COLUMNS = 8
MAX_WALL_CHANNELS = 120
MAX_WALL_TEXT_LEN = 40  # títulos de grupo y labels de tira

# SCNL del catálogo real: NET 1-2, STA 1-5, LOC 0-2 (frecuentemente vacío), CHA 3
_SCNL_RE = re.compile(r"^[A-Z0-9]{1,2}\.[A-Z0-9]{1,5}\.[A-Z0-9]{0,2}\.[A-Z0-9]{3}$")


class InvalidWallLayoutError(ValueError):
    """Layout que no cumple el contrato: forma, límites o canales no SCNL."""


def _valid_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip()) and len(value) <= MAX_WALL_TEXT_LEN


def validate_wall_layout(layout: object) -> None:
    if not isinstance(layout, dict):
        raise InvalidWallLayoutError("layout debe ser un objeto")
    columns = layout.get("columns")
    if not isinstance(columns, list) or not columns:
        raise InvalidWallLayoutError("layout.columns debe ser una lista no vacía")
    if len(columns) > MAX_WALL_COLUMNS:
        raise InvalidWallLayoutError(f"máximo {MAX_WALL_COLUMNS} columnas por muro")
    if not isinstance(layout.get("showMetrics"), bool):
        raise InvalidWallLayoutError("layout.showMetrics debe ser booleano")
    total_channels = 0
    for column in columns:
        if not isinstance(column, dict) or not isinstance(column.get("groups"), list):
            raise InvalidWallLayoutError("cada columna debe tener una lista groups")
        for group in column["groups"]:
            if not isinstance(group, dict) or not isinstance(group.get("channels"), list):
                raise InvalidWallLayoutError("cada grupo debe tener una lista channels")
            if not _valid_text(group.get("title")):
                raise InvalidWallLayoutError("título de grupo inválido")
            for channel in group["channels"]:
                if not isinstance(channel, dict):
                    raise InvalidWallLayoutError("cada canal debe ser un objeto {channel, label}")
                scnl = channel.get("channel")
                if not isinstance(scnl, str) or not _SCNL_RE.match(scnl):
                    raise InvalidWallLayoutError(f"canal no SCNL: {scnl!r}")
                if not _valid_text(channel.get("label")):
                    raise InvalidWallLayoutError("label de canal inválido")
                total_channels += 1
    if total_channels > MAX_WALL_CHANNELS:
        raise InvalidWallLayoutError(f"máximo {MAX_WALL_CHANNELS} canales por muro")
```

- [ ] **Step 5: Verificar que pasa + suite unit**

Run: `./venv/bin/python -m pytest tests/unit/test_wall_layout_validation.py -q --no-cov && ./venv/bin/python -m pytest tests/unit -q --no-cov 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 6: Commit**

```bash
git add deploy/sql/migrations/013_walls.sql src/services/wall_service.py tests/unit/test_wall_layout_validation.py
git commit -m "feat(muro): tabla walls y validación server-side de layouts"
```

---

### Task 2: Modelos Pydantic + `WallService` (CRUD con ownership)

**Files:**
- Create: `src/models/wall.py`
- Modify: `src/services/wall_service.py` (agregar service + excepciones)
- Modify: `tests/conftest.py` (agregar `walls` a la limpieza del fixture `db_pool`)
- Test: `tests/integration/test_walls_service.py`

**Interfaces:**
- Consumes: `validate_wall_layout` / `InvalidWallLayoutError` (Task 1); pool asyncpg prestado (patrón `AreaService.__init__`).
- Produces (Task 3 consume):
  - `WallCreate(name: str [1..120], layout: dict)` / `WallUpdate(name: str [1..120], layout: dict)` / `WallPublic(id: UUID, name: str, layout: dict, created_at: datetime, updated_at: datetime)` en `src/models/wall.py`.
  - `WallService(pool)` con `list_for_user(user_id) -> list[WallPublic]`, `create(user_id, name, layout) -> WallPublic`, `update(wall_id, user_id, name, layout) -> WallPublic`, `delete(wall_id, user_id) -> None`.
  - Excepciones: `WallNotFoundError` (no existe O es de otro), `WallNameConflictError` (unique user_id+name).

- [ ] **Step 1: Escribir los modelos**

```python
# src/models/wall.py
"""Modelos de la API de muros SPECTRONET (PR-W2).

WallCreate/WallUpdate NO exponen user_id: el dueño sale de la sesión
(seguridad por diseño de tipos, patrón AreaCreate). PUT es reemplazo total,
por eso WallUpdate tiene los mismos campos obligatorios que WallCreate.
"""

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class WallCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    layout: dict


class WallUpdate(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)
    layout: dict


class WallPublic(BaseModel):
    id: UUID
    name: str
    layout: dict
    created_at: datetime
    updated_at: datetime
```

- [ ] **Step 2: Escribir los tests de integración que fallan**

```python
# tests/integration/test_walls_service.py
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
```

- [ ] **Step 3: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/integration/test_walls_service.py -q --no-cov`
Expected: FAIL con `ImportError` (no existe `WallService`)

- [ ] **Step 4: Implementar el service** (agregar a `src/services/wall_service.py`, debajo de la validación; agregar `import json`, `from uuid import UUID`, `import asyncpg`, `from src.models.wall import WallPublic` arriba)

```python
# --- CRUD de muros guardados por usuario (PR-W2) ---


class WallNotFoundError(Exception):
    """El muro no existe o pertenece a otro usuario (404 unificado, patrón AOI)."""


class WallNameConflictError(Exception):
    """Ya existe un muro con ese nombre para este usuario (UNIQUE user_id+name)."""


_WALL_COLUMNS = "id, name, layout, created_at, updated_at"


def _row_to_public(row: asyncpg.Record) -> WallPublic:
    layout = row["layout"]
    # asyncpg no decodifica JSONB a dict (a diferencia de psycopg)
    if isinstance(layout, str):
        layout = json.loads(layout)
    return WallPublic(
        id=row["id"],
        name=row["name"],
        layout=layout,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


class WallService:
    """CRUD de muros. El pool es prestado: lo abre y cierra el lifespan."""

    def __init__(self, pool: asyncpg.Pool) -> None:
        self._pool = pool

    async def list_for_user(self, user_id: UUID) -> list[WallPublic]:
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                f"SELECT {_WALL_COLUMNS} FROM walls WHERE user_id = $1 ORDER BY name",
                user_id,
            )
        return [_row_to_public(row) for row in rows]

    async def create(self, user_id: UUID, name: str, layout: dict) -> WallPublic:
        validate_wall_layout(layout)
        try:
            async with self._pool.acquire() as conn:
                row = await conn.fetchrow(
                    f"INSERT INTO walls (user_id, name, layout) VALUES ($1, $2, $3::jsonb) "
                    f"RETURNING {_WALL_COLUMNS}",
                    user_id,
                    name,
                    json.dumps(layout),
                )
        except asyncpg.UniqueViolationError as exc:
            raise WallNameConflictError(f"Wall '{name}' already exists") from exc
        return _row_to_public(row)

    async def update(self, wall_id: UUID, user_id: UUID, name: str, layout: dict) -> WallPublic:
        validate_wall_layout(layout)
        try:
            async with self._pool.acquire() as conn:
                # Ownership en el WHERE: un muro ajeno devuelve row None → 404,
                # indistinguible de inexistente a propósito.
                row = await conn.fetchrow(
                    f"UPDATE walls SET name = $3, layout = $4::jsonb, updated_at = now() "
                    f"WHERE id = $1 AND user_id = $2 RETURNING {_WALL_COLUMNS}",
                    wall_id,
                    user_id,
                    name,
                    json.dumps(layout),
                )
        except asyncpg.UniqueViolationError as exc:
            raise WallNameConflictError(f"Wall '{name}' already exists") from exc
        if row is None:
            raise WallNotFoundError(f"Wall {wall_id} not found")
        return _row_to_public(row)

    async def delete(self, wall_id: UUID, user_id: UUID) -> None:
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "DELETE FROM walls WHERE id = $1 AND user_id = $2",
                wall_id,
                user_id,
            )
        if result == "DELETE 0":
            raise WallNotFoundError(f"Wall {wall_id} not found")
```

En `tests/conftest.py`, en el teardown del fixture `db_pool` donde limpia `invitations`, `areas_of_interest` y `users`: agregar `DELETE FROM walls` ANTES del delete de users (el CASCADE lo cubriría, pero la limpieza explícita documenta la dependencia y sobrevive a un cambio de FK).

- [ ] **Step 5: Verificar que pasa**

Run: `./venv/bin/python -m pytest tests/integration/test_walls_service.py -v --no-cov`
Expected: PASS (11 tests)

- [ ] **Step 6: Commit**

```bash
git add src/models/wall.py src/services/wall_service.py tests/conftest.py tests/integration/test_walls_service.py
git commit -m "feat(muro): WallService con CRUD, ownership y unicidad de nombre"
```

---

### Task 3: Router `/walls` + wiring en `main.py`

**Files:**
- Create: `src/api/routers/walls.py`
- Modify: `src/main.py` (lifespan + include_router + BORRAR el `@app.get("/walls/global")` de L2201-2206)
- Test: `tests/integration/test_walls_api.py`

**Interfaces:**
- Consumes: `WallService` y excepciones (Task 2); `get_current_user`/`CurrentUser` de `src/api/deps.py`; `build_global_wall` (existente).
- Produces:
  - `GET /walls/global` → dict del muro default (público, sin auth — la cartelera funciona sin login). Misma ruta y forma que hoy; solo se muda al router.
  - `GET /walls` → `list[WallPublic]` (200, auth). `POST /walls` → `WallPublic` (201, auth; 409 nombre, 422 layout). `PUT /walls/{wall_id}` → `WallPublic` (200; 404/409/422). `DELETE /walls/{wall_id}` → 204 (404).
  - `app.state.wall_service` inicializado en el lifespan.

- [ ] **Step 1: Escribir los tests HTTP que fallan** (calcar fixtures de `tests/integration/test_invitations_api.py`: `_LazyPool`, `_reset_app_state`, `_login_as`/`_logout`, seed de usuarios con psycopg2 síncrono — copiar esos helpers al archivo nuevo tal como hace ese archivo, adaptando los keys de `app.state` a `("auth_service", "wall_service")`)

```python
# tests/integration/test_walls_api.py
"""Endpoints /walls por HTTP: auth, mapeo de errores y el muro global público.

La cobertura fina del CRUD vive en test_walls_service.py; acá se verifica la
capa HTTP: 401 sin sesión, códigos de error y serialización.
"""

# ... fixtures copiadas de test_invitations_api.py (_LazyPool, client,
# _reset_app_state, _login_as, _logout, seed síncrono de usuario) ...

LAYOUT = {
    "columns": [
        {"groups": [{"title": "ASIA", "channels": [{"channel": "IU.MAJO.00.BHZ", "label": "Tokyo"}]}]}
    ],
    "showMetrics": False,
}

PROTECTED_ENDPOINTS = [
    ("GET", "/walls", None),
    ("POST", "/walls", {"name": "x", "layout": LAYOUT}),
    ("PUT", "/walls/00000000-0000-0000-0000-000000000000", {"name": "x", "layout": LAYOUT}),
    ("DELETE", "/walls/00000000-0000-0000-0000-000000000000", None),
]


@pytest.mark.parametrize("method,path,body", PROTECTED_ENDPOINTS)
def test_sin_sesion_todo_da_401(client, method, path, body):
    response = client.request(method, path, json=body)
    assert response.status_code == 401


def test_walls_global_es_publico(client):
    response = client.get("/walls/global")
    assert response.status_code == 200
    body = response.json()
    assert body["id"] == "global"
    assert body["layout"]["columns"]


def test_crud_feliz(client, viewer_user):
    _login_as(viewer_user, client)
    created = client.post("/walls", json={"name": "Mi muro", "layout": LAYOUT})
    assert created.status_code == 201
    wall_id = created.json()["id"]

    listed = client.get("/walls")
    assert [w["name"] for w in listed.json()] == ["Mi muro"]

    updated = client.put(f"/walls/{wall_id}", json={"name": "Renombrado", "layout": LAYOUT})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Renombrado"

    deleted = client.delete(f"/walls/{wall_id}")
    assert deleted.status_code == 204
    assert client.get("/walls").json() == []


def test_nombre_duplicado_da_409(client, viewer_user):
    _login_as(viewer_user, client)
    assert client.post("/walls", json={"name": "Uno", "layout": LAYOUT}).status_code == 201
    assert client.post("/walls", json={"name": "Uno", "layout": LAYOUT}).status_code == 409


def test_layout_invalido_da_422(client, viewer_user):
    _login_as(viewer_user, client)
    bad = {"columns": [], "showMetrics": False}
    assert client.post("/walls", json={"name": "Roto", "layout": bad}).status_code == 422


def test_muro_inexistente_da_404(client, viewer_user):
    _login_as(viewer_user, client)
    ghost = "00000000-0000-0000-0000-000000000000"
    assert client.put(f"/walls/{ghost}", json={"name": "x", "layout": LAYOUT}).status_code == 404
    assert client.delete(f"/walls/{ghost}").status_code == 404
```

Nota para el ejecutor: `viewer_user` = fixture que inserta un user por psycopg2 síncrono y devuelve el `CurrentUser` correspondiente (mismo patrón del archivo de invitaciones, incluido el mock de `get_user_auth_state` devolviendo un `UserAuthState` concreto — NUNCA un MagicMock pelado). En este archivo `app.state.wall_service = WallService(lazy_pool)` se setea en un fixture autouse junto al reset.

- [ ] **Step 2: Verificar que falla**

Run: `./venv/bin/python -m pytest tests/integration/test_walls_api.py -q --no-cov`
Expected: FAIL — 404 en `/walls` (router inexistente)

- [ ] **Step 3: Implementar el router**

```python
# src/api/routers/walls.py
"""CRUD de muros SPECTRONET (PR-W2).

Autorización por ownership (no por rol): el service filtra por user_id en el
WHERE; acá solo se exige sesión y se mapean excepciones a HTTP. El 404 de un
muro ajeno es idéntico al de uno inexistente a propósito.
"""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request

from src.api.deps import get_current_user
from src.models.user import CurrentUser
from src.models.wall import WallCreate, WallPublic, WallUpdate
from src.services.wall_service import (
    InvalidWallLayoutError,
    WallNameConflictError,
    WallNotFoundError,
    WallService,
    build_global_wall,
)

router = APIRouter(prefix="/walls", tags=["walls"])


def _get_wall_service(request: Request) -> WallService:
    return request.app.state.wall_service


# Estática ANTES que la paramétrica /{wall_id} (gotcha documentado en areas.py)
@router.get("/global")
async def get_global_wall() -> dict:
    """Muro default "Global" (público: la cartelera funciona sin login)."""
    return build_global_wall()


@router.get("", response_model=list[WallPublic])
async def list_walls(
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> list[WallPublic]:
    return await wall_service.list_for_user(current_user.id)


@router.post("", response_model=WallPublic, status_code=201)
async def create_wall(
    payload: WallCreate,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> WallPublic:
    try:
        return await wall_service.create(current_user.id, payload.name, payload.layout)
    except WallNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidWallLayoutError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.put("/{wall_id}", response_model=WallPublic)
async def update_wall(
    wall_id: UUID,
    payload: WallUpdate,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
) -> WallPublic:
    try:
        return await wall_service.update(wall_id, current_user.id, payload.name, payload.layout)
    except WallNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except WallNameConflictError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except InvalidWallLayoutError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


# OJO: sin anotación de retorno — un `-> None` con 204 aborta el arranque
@router.delete("/{wall_id}", status_code=204)
async def delete_wall(
    wall_id: UUID,
    current_user: CurrentUser = Depends(get_current_user),
    wall_service: WallService = Depends(_get_wall_service),
):
    try:
        await wall_service.delete(wall_id, current_user.id)
    except WallNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
```

En `src/main.py`:
- Import junto al de areas: `from src.api.routers import walls as walls_router`.
- Registro junto a `app.include_router(areas_router.router)` (L424-427): `app.include_router(walls_router.router)`.
- Lifespan (L270-330), junto a `app.state.area_service = AreaService(db_pool)`: `app.state.wall_service = WallService(db_pool)` (import arriba con los demás services).
- **BORRAR** el bloque `@app.get("/walls/global")` de L2201-2206 (la ruta ahora vive en el router; el path público no cambia).

- [ ] **Step 4: Verificar que pasa + suites backend completas**

Run: `./venv/bin/python -m pytest tests/integration/test_walls_api.py tests/integration/test_walls_service.py -q --no-cov && ./venv/bin/python -m pytest tests/unit -q --no-cov 2>&1 | tail -1`
Expected: todo passed (incluido `tests/unit/test_wall_service.py` de W1, que no se toca)

- [ ] **Step 5: Commit**

```bash
git add src/api/routers/walls.py src/main.py tests/integration/test_walls_api.py
git commit -m "feat(muro): endpoints /walls con ownership y muro global en el router"
```

---

### Task 4: Tipos TS + cliente `lib/walls.ts`

**Files:**
- Modify: `dashboard/lib/types.ts` (L315-333: extraer tipos nombrados de `WallResponse`)
- Create: `dashboard/lib/walls.ts`
- Test: `dashboard/lib/walls.test.ts`

**Interfaces:**
- Produces (Tasks 5-8 consumen):

```ts
// en types.ts — WallResponse pasa a componerse de estos (sin cambiar su forma):
export interface WallChannel { channel: string; label: string }
export interface WallGroup { title: string; channels: WallChannel[] }
export interface WallColumn { groups: WallGroup[] }
export interface WallLayout { columns: WallColumn[]; showMetrics: boolean }
export interface WallResponse { id: string; name: string; layout: WallLayout }
export interface Wall extends WallResponse { created_at: string; updated_at: string }
export interface WallPayload { name: string; layout: WallLayout }
```

- `listWalls(): Promise<Wall[] | null>` (401 → `null`, patrón areas.ts), `createWall(payload): Promise<Wall | null>`, `updateWall(id, payload): Promise<Wall | null>`, `deleteWall(id): Promise<void>`. Errores ≠401 → `ApiStatusError` (de `lib/auth.ts`) con el `detail` del backend, para que la UI distinga 409.

- [ ] **Step 1: Extraer los tipos en `types.ts`** — reemplazar la interface inline `WallResponse` (L315-333) por el bloque de arriba, conservando los comentarios existentes. `tsc`/vitest de los usos existentes (`SpectronetWall`, `api.ts`) no deben requerir cambios: la forma es idéntica.

- [ ] **Step 2: Escribir los tests del cliente que fallan**

```ts
// dashboard/lib/walls.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatusError } from './auth';
import { createWall, deleteWall, listWalls } from './walls';

const LAYOUT = { columns: [{ groups: [] }], showMetrics: false };

function mockFetch(status: number, body: unknown = null) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  } as Response;
  const spy = vi.fn(() => Promise.resolve(response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('walls client', () => {
  it('manda credentials include y content-type JSON', async () => {
    const spy = mockFetch(200, []);
    await listWalls();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('401 devuelve null (sin sesión no es un error)', async () => {
    mockFetch(401);
    expect(await listWalls()).toBeNull();
  });

  it('409 lanza ApiStatusError con el detail del backend', async () => {
    mockFetch(409, { detail: "Wall 'Uno' already exists" });
    const error = await createWall({ name: 'Uno', layout: LAYOUT }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(409);
    expect(error.message).toContain('already exists');
  });

  it('delete con 204 resuelve sin intentar parsear body', async () => {
    mockFetch(204);
    await expect(deleteWall('abc')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `cd dashboard && npx vitest run lib/walls.test.ts`
Expected: FAIL — módulo inexistente

- [ ] **Step 4: Implementar**

```ts
// dashboard/lib/walls.ts
/**
 * Cliente del CRUD de muros (/walls). Mismo molde que lib/areas.ts:
 * 401 => null (no hay sesión, no es un error); otros !ok => ApiStatusError
 * para que la UI distinga 409 (nombre duplicado) de fallas genéricas.
 * El backend responde {"detail": "..."} (HTTPException del router).
 */

import { ApiStatusError } from './auth';
import type { Wall, WallPayload } from './types';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

async function request<T>(path: string, init?: RequestInit): Promise<T | null> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    cache: 'no-store',
    ...init,
  });
  if (response.status === 401) return null;
  if (!response.ok) {
    let detail = `API Error: ${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { detail?: unknown } | null;
      if (body?.detail) detail = String(body.detail);
    } catch {
      // body no-JSON: queda el mensaje genérico
    }
    throw new ApiStatusError(response.status, detail);
  }
  if (response.status === 204) return null;
  return response.json() as Promise<T>;
}

export async function listWalls(): Promise<Wall[] | null> {
  return request<Wall[]>('/walls');
}

export async function createWall(payload: WallPayload): Promise<Wall | null> {
  return request<Wall>('/walls', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateWall(id: string, payload: WallPayload): Promise<Wall | null> {
  return request<Wall>(`/walls/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export async function deleteWall(id: string): Promise<void> {
  await request<unknown>(`/walls/${id}`, { method: 'DELETE' });
}
```

- [ ] **Step 5: Verificar que pasa + suite**

Run: `cd dashboard && npx vitest run lib/walls.test.ts && npx vitest run 2>&1 | tail -2`
Expected: todo passed (la extracción de tipos no rompe nada)

- [ ] **Step 6: Commit**

```bash
git add dashboard/lib/types.ts dashboard/lib/walls.ts dashboard/lib/walls.test.ts
git commit -m "feat(muro): tipos de layout nombrados y cliente CRUD de /walls"
```

---

### Task 5: Lib pura de edición de layout (`wall-editor.ts`)

**Files:**
- Create: `dashboard/lib/wall-editor.ts`
- Test: `dashboard/lib/wall-editor.test.ts`

**Interfaces:**
- Consumes: `WallChannel`, `WallLayout` de `./types` (Task 4).
- Produces (Task 6 consume) — TODAS inmutables (devuelven layout nuevo; no-op devuelve el MISMO objeto para que React no re-renderice):
  - `MAX_WALL_COLUMNS = 8`, `MAX_WALL_CHANNELS = 120` (espejo del backend)
  - `createEmptyLayout(): WallLayout` — una columna con un grupo vacío no: una columna con `groups: []`
  - `countChannels(layout): number`, `hasChannel(layout, channel: string): boolean`
  - `addColumn(layout)`, `removeColumn(layout, col)` (nunca deja 0 columnas)
  - `addGroup(layout, col, title)`, `renameGroup(layout, col, group, title)`, `removeGroup(layout, col, group)`, `moveGroup(layout, col, group, dir: -1 | 1)`
  - `addChannel(layout, col, group, ch: WallChannel)` (no-op si el canal ya está en el muro o se llegó a 120), `removeChannel(layout, col, group, index)`, `moveChannel(layout, col, group, index, dir: -1 | 1)`
  - `toggleMetrics(layout)`

- [ ] **Step 1: Escribir los tests que fallan**

```ts
// dashboard/lib/wall-editor.test.ts
import { describe, expect, it } from 'vitest';
import type { WallLayout } from './types';
import {
  addChannel,
  addColumn,
  addGroup,
  countChannels,
  createEmptyLayout,
  hasChannel,
  MAX_WALL_CHANNELS,
  MAX_WALL_COLUMNS,
  moveChannel,
  moveGroup,
  removeChannel,
  removeColumn,
  removeGroup,
  renameGroup,
  toggleMetrics,
} from './wall-editor';

const TOKYO = { channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' };
const LIMA = { channel: 'II.NNA.00.BHZ', label: 'Lima' };

function baseLayout(): WallLayout {
  return {
    columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO] }] }],
    showMetrics: false,
  };
}

describe('wall-editor', () => {
  it('createEmptyLayout arranca con una columna vacía', () => {
    expect(createEmptyLayout()).toEqual({ columns: [{ groups: [] }], showMetrics: false });
  });

  it('addChannel agrega al final del grupo sin mutar el original', () => {
    const layout = baseLayout();
    const next = addChannel(layout, 0, 0, LIMA);
    expect(next.columns[0].groups[0].channels).toEqual([TOKYO, LIMA]);
    expect(layout.columns[0].groups[0].channels).toEqual([TOKYO]); // inmutable
  });

  it('addChannel es no-op (misma referencia) si el canal ya está en CUALQUIER grupo', () => {
    const layout = addGroup(baseLayout(), 0, 'OTRA');
    expect(addChannel(layout, 0, 1, TOKYO)).toBe(layout);
  });

  it('addChannel es no-op al llegar al máximo de canales', () => {
    let layout = createEmptyLayout();
    layout = addGroup(layout, 0, 'BULK');
    for (let i = 0; i < MAX_WALL_CHANNELS; i++) {
      layout = addChannel(layout, 0, 0, { channel: `IU.S${String(i).padStart(3, '0')}.00.BHZ`, label: `s${i}` });
    }
    expect(countChannels(layout)).toBe(MAX_WALL_CHANNELS);
    expect(addChannel(layout, 0, 0, { channel: 'IU.FULL.00.BHZ', label: 'full' })).toBe(layout);
  });

  it('removeChannel y hasChannel', () => {
    const layout = baseLayout();
    const next = removeChannel(layout, 0, 0, 0);
    expect(next.columns[0].groups[0].channels).toEqual([]);
    expect(hasChannel(layout, TOKYO.channel)).toBe(true);
    expect(hasChannel(next, TOKYO.channel)).toBe(false);
  });

  it('moveChannel intercambia con el vecino y respeta los bordes', () => {
    const layout = addChannel(baseLayout(), 0, 0, LIMA);
    const down = moveChannel(layout, 0, 0, 0, 1);
    expect(down.columns[0].groups[0].channels).toEqual([LIMA, TOKYO]);
    expect(moveChannel(layout, 0, 0, 0, -1)).toBe(layout); // borde: no-op
    expect(moveChannel(layout, 0, 0, 1, 1)).toBe(layout);
  });

  it('grupos: agregar, renombrar, mover, quitar', () => {
    let layout = addGroup(baseLayout(), 0, 'OCEANÍA');
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['ASIA', 'OCEANÍA']);
    layout = renameGroup(layout, 0, 1, 'PACÍFICO');
    expect(layout.columns[0].groups[1].title).toBe('PACÍFICO');
    layout = moveGroup(layout, 0, 1, -1);
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['PACÍFICO', 'ASIA']);
    layout = removeGroup(layout, 0, 0);
    expect(layout.columns[0].groups.map((g) => g.title)).toEqual(['ASIA']);
  });

  it('columnas: agrega hasta el máximo y nunca deja cero', () => {
    let layout = createEmptyLayout();
    for (let i = 0; i < MAX_WALL_COLUMNS + 2; i++) layout = addColumn(layout);
    expect(layout.columns).toHaveLength(MAX_WALL_COLUMNS);
    for (let i = 0; i < MAX_WALL_COLUMNS + 2; i++) layout = removeColumn(layout, 0);
    expect(layout.columns).toHaveLength(1);
  });

  it('removeColumn descarta la columna con sus canales', () => {
    let layout = addColumn(baseLayout());
    layout = removeColumn(layout, 0);
    expect(countChannels(layout)).toBe(0);
  });

  it('toggleMetrics invierte showMetrics', () => {
    expect(toggleMetrics(baseLayout()).showMetrics).toBe(true);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run lib/wall-editor.test.ts`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar**

```ts
// dashboard/lib/wall-editor.ts
/**
 * Operaciones puras de edición del layout de un muro (armador PR-W2).
 * Todas inmutables; un no-op devuelve el MISMO objeto (los componentes
 * pueden comparar por referencia y saltarse el re-render). Los límites
 * espejan la validación server-side de wall_service.py.
 */

import type { WallChannel, WallColumn, WallGroup, WallLayout } from './types';

export const MAX_WALL_COLUMNS = 8;
export const MAX_WALL_CHANNELS = 120;

export function createEmptyLayout(): WallLayout {
  return { columns: [{ groups: [] }], showMetrics: false };
}

export function countChannels(layout: WallLayout): number {
  return layout.columns.reduce(
    (total, col) => total + col.groups.reduce((n, g) => n + g.channels.length, 0),
    0
  );
}

export function hasChannel(layout: WallLayout, channel: string): boolean {
  return layout.columns.some((col) =>
    col.groups.some((g) => g.channels.some((ch) => ch.channel === channel))
  );
}

function mapColumn(layout: WallLayout, col: number, fn: (c: WallColumn) => WallColumn): WallLayout {
  return { ...layout, columns: layout.columns.map((c, i) => (i === col ? fn(c) : c)) };
}

function mapGroup(layout: WallLayout, col: number, group: number, fn: (g: WallGroup) => WallGroup): WallLayout {
  return mapColumn(layout, col, (c) => ({
    ...c,
    groups: c.groups.map((g, i) => (i === group ? fn(g) : g)),
  }));
}

function moveItem<T>(items: T[], index: number, dir: -1 | 1): T[] | null {
  const target = index + dir;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return null;
  const next = [...items];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function addColumn(layout: WallLayout): WallLayout {
  if (layout.columns.length >= MAX_WALL_COLUMNS) return layout;
  return { ...layout, columns: [...layout.columns, { groups: [] }] };
}

export function removeColumn(layout: WallLayout, col: number): WallLayout {
  if (layout.columns.length <= 1) return layout;
  return { ...layout, columns: layout.columns.filter((_, i) => i !== col) };
}

export function addGroup(layout: WallLayout, col: number, title: string): WallLayout {
  return mapColumn(layout, col, (c) => ({ ...c, groups: [...c.groups, { title, channels: [] }] }));
}

export function renameGroup(layout: WallLayout, col: number, group: number, title: string): WallLayout {
  return mapGroup(layout, col, group, (g) => ({ ...g, title }));
}

export function removeGroup(layout: WallLayout, col: number, group: number): WallLayout {
  return mapColumn(layout, col, (c) => ({ ...c, groups: c.groups.filter((_, i) => i !== group) }));
}

export function moveGroup(layout: WallLayout, col: number, group: number, dir: -1 | 1): WallLayout {
  const moved = moveItem(layout.columns[col]?.groups ?? [], group, dir);
  if (!moved) return layout;
  return mapColumn(layout, col, (c) => ({ ...c, groups: moved }));
}

export function addChannel(layout: WallLayout, col: number, group: number, ch: WallChannel): WallLayout {
  if (hasChannel(layout, ch.channel) || countChannels(layout) >= MAX_WALL_CHANNELS) return layout;
  return mapGroup(layout, col, group, (g) => ({ ...g, channels: [...g.channels, ch] }));
}

export function removeChannel(layout: WallLayout, col: number, group: number, index: number): WallLayout {
  return mapGroup(layout, col, group, (g) => ({
    ...g,
    channels: g.channels.filter((_, i) => i !== index),
  }));
}

export function moveChannel(layout: WallLayout, col: number, group: number, index: number, dir: -1 | 1): WallLayout {
  const moved = moveItem(layout.columns[col]?.groups[group]?.channels ?? [], index, dir);
  if (!moved) return layout;
  return mapGroup(layout, col, group, (g) => ({ ...g, channels: moved }));
}

export function toggleMetrics(layout: WallLayout): WallLayout {
  return { ...layout, showMetrics: !layout.showMetrics };
}
```

- [ ] **Step 4: Verificar que pasa + mutación**

Run: `cd dashboard && npx vitest run lib/wall-editor.test.ts`
Expected: PASS (10 tests)

Verificación por mutación (manual, revertir después de cada una): (a) en `addChannel` quitar el chequeo `hasChannel` → debe fallar el test de duplicados; (b) en `moveItem` cambiar `target < 0` por `target < -1` → debe fallar el test de bordes; (c) en `removeColumn` quitar el guard `<= 1` → debe fallar el test de columnas.

- [ ] **Step 5: Commit**

```bash
git add dashboard/lib/wall-editor.ts dashboard/lib/wall-editor.test.ts
git commit -m "feat(muro): lib pura de edición de layout con límites espejados"
```

---

### Task 6: Componente `WallBuilder` (armador controlado)

**Files:**
- Create: `dashboard/components/WallBuilder.tsx`
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json` (namespace `charts.spectrogramsPage.wall.*`)
- Test: `dashboard/components/WallBuilder.test.tsx`

**Interfaces:**
- Consumes: `wall-editor` (Task 5); tipos (Task 4); `useTranslations('charts.spectrogramsPage.wall')`.
- Produces (Task 7 consume): `<WallBuilder layout={layout} onChange={(next: WallLayout) => void} catalog={WallChannel[]} />` — componente 100% controlado: cada acción llama `onChange` con el layout nuevo; el estado interno es solo la selección de grupo activo y el texto de búsqueda.

- [ ] **Step 1: Agregar las claves i18n** (en `es.json` bajo `charts.spectrogramsPage`, clave nueva `wall`; espejo en `en.json` — el tono de las existentes manda)

```json
"wall": {
  "tabCards": "Tarjetas",
  "tabWall": "Muro",
  "catalogTitle": "Canales disponibles",
  "searchPlaceholder": "Buscar canal o ciudad",
  "add": "Agregar",
  "alreadyInWall": "Ya está en el muro",
  "column": "Columna {number}",
  "addColumn": "Agregar columna",
  "removeColumn": "Quitar columna",
  "addGroup": "Agregar grupo",
  "newGroupTitle": "NUEVO GRUPO",
  "groupTitleLabel": "Título del grupo",
  "removeGroup": "Quitar grupo",
  "activeGroup": "Grupo activo",
  "selectGroup": "Elegir grupo",
  "moveUp": "Subir",
  "moveDown": "Bajar",
  "remove": "Quitar",
  "showMetrics": "Mostrar métricas",
  "channelsCount": "{count} canales",
  "emptyGroup": "Sin canales — agregalos desde el catálogo",
  "name": "Nombre del muro",
  "namePlaceholder": "Mi muro",
  "save": "Guardar",
  "saving": "Guardando…",
  "saved": "Guardado",
  "newWall": "Nuevo muro",
  "duplicate": "Duplicar",
  "delete": "Eliminar muro",
  "nameTaken": "Ya tenés un muro con ese nombre",
  "invalidLayout": "El servidor rechazó el muro: revisá los canales",
  "saveError": "No se pudo guardar el muro",
  "needSession": "Iniciá sesión para guardar muros",
  "preview": "Vista previa",
  "wallsTitle": "Mis muros"
}
```

(en.json: "Cards", "Wall", "Available channels", "Search channel or city", "Add", "Already in the wall", "Column {number}", "Add column", "Remove column", "Add group", "NEW GROUP", "Group title", "Remove group", "Active group", "Select group", "Move up", "Move down", "Remove", "Show metrics", "{count} channels", "No channels — add them from the catalog", "Wall name", "My wall", "Save", "Saving…", "Saved", "New wall", "Duplicate", "Delete wall", "You already have a wall with that name", "The server rejected the wall: check the channels", "The wall could not be saved", "Sign in to save walls", "Preview", "My walls".)

Las claves de manager (`name`…`wallsTitle`) las consume Task 7 pero se agregan acá de una para no tocar los JSON dos veces (el parity test exige ambos idiomas juntos).

- [ ] **Step 2: Escribir los tests que fallan**

```tsx
// dashboard/components/WallBuilder.test.tsx
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import es from '@/messages/es.json';
import type { WallLayout } from '@/lib/types';
import { WallBuilder } from './WallBuilder';

const TOKYO = { channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' };
const LIMA = { channel: 'II.NNA.00.BHZ', label: 'Lima' };

const LAYOUT: WallLayout = {
  columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO] }] }],
  showMetrics: false,
};

function renderBuilder(layout: WallLayout = LAYOUT, onChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <WallBuilder layout={layout} onChange={onChange} catalog={[TOKYO, LIMA]} />
    </NextIntlClientProvider>
  );
  return onChange;
}

afterEach(cleanup);

describe('WallBuilder', () => {
  it('agrega un canal del catálogo al grupo activo', () => {
    const onChange = renderBuilder();
    // botón "Agregar" DENTRO de la fila de Lima del catálogo (Tokyo ya está en el muro)
    const limaRow = screen.getByText('Lima').closest('li')!;
    fireEvent.click(within(limaRow).getByRole('button'));
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].channels).toEqual([TOKYO, LIMA]);
  });

  it('el canal ya presente en el muro tiene su botón deshabilitado', () => {
    renderBuilder();
    const row = screen.getByText('Tokyo').closest('li')!;
    expect(row.querySelector('button')!.hasAttribute('disabled')).toBe(true);
  });

  it('la búsqueda filtra el catálogo por label y por canal', () => {
    renderBuilder();
    fireEvent.change(screen.getByPlaceholderText('Buscar canal o ciudad'), {
      target: { value: 'NNA' },
    });
    expect(screen.queryByText('Tokyo')).toBeNull();
    expect(screen.getByText('Lima')).toBeTruthy();
  });

  it('renombrar el grupo dispara onChange con el título nuevo', () => {
    const onChange = renderBuilder();
    fireEvent.change(screen.getByDisplayValue('ASIA'), { target: { value: 'PACÍFICO' } });
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].title).toBe('PACÍFICO');
  });

  it('las flechas reordenan canales dentro del grupo', () => {
    const layout: WallLayout = {
      columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO, LIMA] }] }],
      showMetrics: false,
    };
    const onChange = renderBuilder(layout);
    // fila de Tokyo dentro de la estructura del muro (no del catálogo)
    const rows = screen.getAllByTestId('builder-channel-row');
    fireEvent.click(rows[0].querySelector('button[aria-label="Bajar"]')!);
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].channels).toEqual([LIMA, TOKYO]);
  });

  it('agregar columna y grupo', () => {
    const onChange = renderBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar columna' }));
    expect((onChange.mock.calls[0][0] as WallLayout).columns).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar grupo' })[0]);
    const withGroup = onChange.mock.calls[1][0] as WallLayout;
    expect(withGroup.columns[0].groups).toHaveLength(2);
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `cd dashboard && npx vitest run components/WallBuilder.test.tsx`
Expected: FAIL — módulo inexistente

- [ ] **Step 4: Implementar**

```tsx
// dashboard/components/WallBuilder.tsx
'use client';

/**
 * Armador manual de muros (spec §2, v1 sin drag & drop): catálogo con
 * búsqueda a la izquierda, estructura de columnas/grupos a la derecha,
 * reordenar con flechas. Componente controlado: el layout vive en el padre
 * (que también renderiza la preview); acá solo hay selección de grupo
 * activo y texto de búsqueda.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import type { WallChannel, WallLayout } from '@/lib/types';
import {
  addChannel,
  addColumn,
  addGroup,
  hasChannel,
  moveChannel,
  moveGroup,
  removeChannel,
  removeColumn,
  removeGroup,
  renameGroup,
  toggleMetrics,
} from '@/lib/wall-editor';

interface WallBuilderProps {
  layout: WallLayout;
  onChange: (layout: WallLayout) => void;
  catalog: WallChannel[];
}

export function WallBuilder({ layout, onChange, catalog }: WallBuilderProps) {
  const t = useTranslations('charts.spectrogramsPage.wall');
  const [search, setSearch] = useState('');
  // Grupo activo: destino de "Agregar" desde el catálogo
  const [active, setActive] = useState<{ col: number; group: number }>({ col: 0, group: 0 });

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return catalog;
    return catalog.filter(
      (ch) => ch.label.toLowerCase().includes(query) || ch.channel.toLowerCase().includes(query)
    );
  }, [catalog, search]);

  const activeGroupExists = Boolean(layout.columns[active.col]?.groups[active.group]);

  return (
    <div className="flex gap-4">
      {/* Catálogo */}
      <div className="w-64 shrink-0 rounded-md border border-border p-2">
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">
          {t('catalogTitle')}
        </div>
        <input
          className="mb-2 w-full rounded border border-border bg-background px-2 py-1 text-sm"
          placeholder={t('searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <ul className="max-h-80 space-y-1 overflow-y-auto">
          {filtered.map((ch) => {
            const present = hasChannel(layout, ch.channel);
            return (
              <li key={ch.channel} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate" title={ch.channel}>
                  {ch.label}
                  <span className="ml-1 font-mono text-[10px] text-muted-foreground">{ch.channel}</span>
                </span>
                <button
                  type="button"
                  className="rounded border border-border px-1.5 py-0.5 text-xs disabled:opacity-40"
                  disabled={present || !activeGroupExists}
                  title={present ? t('alreadyInWall') : t('add')}
                  onClick={() => onChange(addChannel(layout, active.col, active.group, ch))}
                >
                  {t('add')}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Estructura del muro */}
      <div className="flex flex-1 gap-3 overflow-x-auto">
        {layout.columns.map((column, ci) => (
          <div key={ci} className="w-64 shrink-0 rounded-md border border-border p-2">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase text-muted-foreground">
                {t('column', { number: ci + 1 })}
              </span>
              <button
                type="button"
                aria-label={t('removeColumn')}
                className="text-muted-foreground hover:text-destructive"
                onClick={() => onChange(removeColumn(layout, ci))}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
            {column.groups.map((group, gi) => {
              const isActive = active.col === ci && active.group === gi;
              return (
                <div
                  key={gi}
                  className={`mb-2 rounded border p-1.5 ${isActive ? 'border-teal-500' : 'border-border'}`}
                  onClick={() => setActive({ col: ci, group: gi })}
                >
                  <div className="flex items-center gap-1">
                    <input
                      aria-label={t('groupTitleLabel')}
                      className="w-full bg-transparent font-mono text-xs font-bold uppercase"
                      value={group.title}
                      onChange={(e) => onChange(renameGroup(layout, ci, gi, e.target.value))}
                    />
                    <button type="button" aria-label={t('moveUp')} onClick={() => onChange(moveGroup(layout, ci, gi, -1))}>
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button type="button" aria-label={t('moveDown')} onClick={() => onChange(moveGroup(layout, ci, gi, 1))}>
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('removeGroup')}
                      onClick={() => onChange(removeGroup(layout, ci, gi))}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  {group.channels.length === 0 && (
                    <div className="py-1 text-[11px] text-muted-foreground">{t('emptyGroup')}</div>
                  )}
                  <ul>
                    {group.channels.map((ch, chi) => (
                      <li
                        key={ch.channel}
                        data-testid="builder-channel-row"
                        className="flex items-center justify-between gap-1 py-0.5 text-xs"
                      >
                        <span className="truncate">{ch.label}</span>
                        <span className="flex shrink-0 items-center gap-0.5">
                          <button type="button" aria-label={t('moveUp')} onClick={() => onChange(moveChannel(layout, ci, gi, chi, -1))}>
                            <ArrowUp className="h-3 w-3" />
                          </button>
                          <button type="button" aria-label={t('moveDown')} onClick={() => onChange(moveChannel(layout, ci, gi, chi, 1))}>
                            <ArrowDown className="h-3 w-3" />
                          </button>
                          <button type="button" aria-label={t('remove')} onClick={() => onChange(removeChannel(layout, ci, gi, chi))}>
                            <Trash2 className="h-3 w-3" />
                          </button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
            <button
              type="button"
              className="flex w-full items-center justify-center gap-1 rounded border border-dashed border-border py-1 text-xs text-muted-foreground"
              onClick={() => onChange(addGroup(layout, ci, t('newGroupTitle')))}
            >
              <Plus className="h-3 w-3" /> {t('addGroup')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="h-10 shrink-0 rounded border border-dashed border-border px-3 text-xs text-muted-foreground"
          onClick={() => onChange(addColumn(layout))}
        >
          <span className="flex items-center gap-1"><Plus className="h-3 w-3" /> {t('addColumn')}</span>
        </button>
      </div>

      <label className="sr-only flex items-center gap-2 text-xs">
        <input type="checkbox" checked={layout.showMetrics} onChange={() => onChange(toggleMetrics(layout))} />
        {t('showMetrics')}
      </label>
    </div>
  );
}
```

Nota: el checkbox `showMetrics` queda `sr-only` hasta el PR-W3 (que trae las métricas); el dato ya persiste. Si el test del click "Agregar" resulta ambiguo por múltiples botones, afinar con `within(screen.getByText('Lima').closest('li')!)`.

- [ ] **Step 5: Verificar que pasa + parity de i18n**

Run: `cd dashboard && npx vitest run components/WallBuilder.test.tsx messages/parity.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add dashboard/components/WallBuilder.tsx dashboard/components/WallBuilder.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(muro): armador manual controlado con catálogo y flechas"
```

---

### Task 7: `WallManager` + pestaña "Muro" en `/spectrograms-live`

**Files:**
- Create: `dashboard/components/WallManager.tsx`
- Modify: `dashboard/app/(app)/spectrograms-live/page.tsx` (tabs `?tab=cards|wall`, patrón `admin/access`; envolver el export en `<Suspense>` como `globe/page.tsx` por `useSearchParams`)
- Test: `dashboard/components/WallManager.test.tsx`

**Interfaces:**
- Consumes: `listWalls/createWall/updateWall/deleteWall` (Task 4), `ApiStatusError` (`lib/auth.ts`), `WallBuilder` (Task 6), `createEmptyLayout` (Task 5), `SpectronetWall` (existente), `seismicAPI.getGlobalWall()` y `seismicAPI.getLiveChannels()` (existentes), `HIGH_RISK_SEISMIC_CITIES` para los labels del catálogo.
- Produces: `<WallManager />` autocontenido (hace su propio fetch); la página solo lo monta en la pestaña "Muro".

- [ ] **Step 1: Escribir los tests que fallan**

```tsx
// dashboard/components/WallManager.test.tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import es from '@/messages/es.json';
import { ApiStatusError } from '@/lib/auth';
import { WallManager } from './WallManager';

const LAYOUT = {
  columns: [{ groups: [{ title: 'ASIA', channels: [{ channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' }] }] }],
  showMetrics: false,
};

const { wallsMock, apiMock } = vi.hoisted(() => ({
  wallsMock: {
    listWalls: vi.fn(),
    createWall: vi.fn(),
    updateWall: vi.fn(),
    deleteWall: vi.fn(),
  },
  apiMock: {
    getGlobalWall: vi.fn(),
    getLiveChannels: vi.fn(),
  },
}));

vi.mock('@/lib/walls', () => wallsMock);
vi.mock('@/lib/api', () => ({ seismicAPI: apiMock }));
vi.mock('./SpectronetWall', () => ({
  SpectronetWall: ({ wall }: { wall: { name: string } }) => (
    <div data-testid="preview-wall">{wall.name}</div>
  ),
}));

function renderManager() {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <SWRConfig value={{ provider: () => new Map() }}>
        <WallManager />
      </SWRConfig>
    </NextIntlClientProvider>
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function arrange(walls: unknown[] | null = []) {
  wallsMock.listWalls.mockResolvedValue(walls);
  apiMock.getGlobalWall.mockResolvedValue({ id: 'global', name: 'Global', layout: LAYOUT });
  apiMock.getLiveChannels.mockResolvedValue([{ city_id: 'tokyo', channel: 'IU.MAJO.00.BHZ' }]);
}

describe('WallManager', () => {
  it('lista los muros del usuario y muestra la preview del seleccionado', async () => {
    arrange([{ id: 'w1', name: 'Andes', layout: LAYOUT, created_at: '', updated_at: '' }]);
    renderManager();
    await waitFor(() => expect(screen.getByText('Andes')).toBeTruthy());
    fireEvent.click(screen.getByText('Andes'));
    await waitFor(() => expect(screen.getByTestId('preview-wall').textContent).toBe('Andes'));
  });

  it('guarda un muro nuevo con createWall', async () => {
    arrange([]);
    wallsMock.createWall.mockResolvedValue({ id: 'w9', name: 'Nuevo', layout: LAYOUT, created_at: '', updated_at: '' });
    renderManager();
    await waitFor(() => expect(wallsMock.listWalls).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Mi muro'), { target: { value: 'Nuevo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() =>
      expect(wallsMock.createWall).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'Nuevo' })
      )
    );
  });

  it('un 409 muestra el error de nombre duplicado', async () => {
    arrange([]);
    wallsMock.createWall.mockRejectedValue(new ApiStatusError(409, 'conflict'));
    renderManager();
    await waitFor(() => expect(wallsMock.listWalls).toHaveBeenCalled());
    fireEvent.change(screen.getByPlaceholderText('Mi muro'), { target: { value: 'Repetido' } });
    fireEvent.click(screen.getByRole('button', { name: 'Guardar' }));
    await waitFor(() => expect(screen.getByText('Ya tenés un muro con ese nombre')).toBeTruthy());
  });

  it('sin sesión (listWalls null) muestra el aviso y deshabilita guardar', async () => {
    arrange(null);
    renderManager();
    await waitFor(() => expect(screen.getByText('Iniciá sesión para guardar muros')).toBeTruthy());
    expect((screen.getByRole('button', { name: 'Guardar' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('duplicar el muro Global precarga su layout con nombre "Global (copia)"', async () => {
    arrange([]);
    renderManager();
    await waitFor(() => expect(apiMock.getGlobalWall).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicar' }));
    await waitFor(() =>
      expect((screen.getByPlaceholderText('Mi muro') as HTMLInputElement).value).toBe('Global (copia)')
    );
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run components/WallManager.test.tsx`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar `WallManager`**

```tsx
// dashboard/components/WallManager.tsx
'use client';

/**
 * Gestión de muros guardados (spec §2): lista + armador + preview en vivo.
 * El outcome de guardado se guarda como CLAVE i18n (patrón del repo), no
 * como texto resuelto. El muro "Global" no es editable: solo se duplica.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { seismicAPI } from '@/lib/api';
import { ApiStatusError } from '@/lib/auth';
import { HIGH_RISK_SEISMIC_CITIES } from '@/lib/seismic-cities';
import type { WallChannel, WallLayout } from '@/lib/types';
import { createEmptyLayout } from '@/lib/wall-editor';
import { createWall, deleteWall, listWalls, updateWall } from '@/lib/walls';
import { SpectronetWall } from './SpectronetWall';
import { WallBuilder } from './WallBuilder';

const CITY_NAME_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c.name]));

type SaveOutcome = 'saved' | 'nameTaken' | 'invalidLayout' | 'saveError' | null;

export function WallManager() {
  const t = useTranslations('charts.spectrogramsPage.wall');
  const { data: walls, mutate } = useSWR('walls-list', () => listWalls(), {
    revalidateOnFocus: false,
  });
  const { data: globalWall } = useSWR('walls-global', () => seismicAPI.getGlobalWall(), {
    revalidateOnFocus: false,
  });
  const { data: liveChannels } = useSWR('walls-catalog', () => seismicAPI.getLiveChannels(), {
    revalidateOnFocus: false,
  });

  const [selectedId, setSelectedId] = useState<'new' | string>('new');
  const [name, setName] = useState('');
  const [layout, setLayout] = useState<WallLayout>(createEmptyLayout);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);

  const noSession = walls === null;

  const catalog: WallChannel[] = useMemo(
    () =>
      (liveChannels ?? []).map((c) => ({
        channel: c.channel,
        label: CITY_NAME_BY_ID.get(c.city_id) ?? c.city_id,
      })),
    [liveChannels]
  );

  // Cargar el muro elegido en el editor (o resetear en "nuevo")
  useEffect(() => {
    if (selectedId === 'new') {
      setName('');
      setLayout(createEmptyLayout());
      return;
    }
    const wall = walls?.find((w) => w.id === selectedId);
    if (wall) {
      setName(wall.name);
      setLayout(wall.layout);
    }
  }, [selectedId, walls]);

  const handleSave = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const payload = { name: name.trim(), layout };
      const saved = selectedId === 'new' ? await createWall(payload) : await updateWall(selectedId, payload);
      if (saved) setSelectedId(saved.id);
      setOutcome('saved');
      await mutate();
    } catch (error) {
      if (error instanceof ApiStatusError && error.status === 409) setOutcome('nameTaken');
      else if (error instanceof ApiStatusError && error.status === 422) setOutcome('invalidLayout');
      else setOutcome('saveError');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (selectedId === 'new') return;
    await deleteWall(selectedId);
    setSelectedId('new');
    await mutate();
  };

  const handleDuplicate = () => {
    // Duplica el muro seleccionado; con "nuevo" seleccionado duplica el Global
    // (spec §2: "duplicar un muro existente (incluido duplicar el default)")
    const source = selectedId === 'new' ? globalWall : walls?.find((w) => w.id === selectedId);
    if (!source) return;
    setSelectedId('new');
    // el efecto de selección resetea; pisamos después del render con la copia
    setTimeout(() => {
      setName(`${source.name} (copia)`);
      setLayout(source.layout);
    }, 0);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t('wallsTitle')}</span>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => setSelectedId('new')}>
          {t('newWall')}
        </button>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={handleDuplicate}>
          {t('duplicate')}
        </button>
        {(walls ?? []).map((wall) => (
          <button
            key={wall.id}
            type="button"
            className={`rounded border px-2 py-1 text-xs ${selectedId === wall.id ? 'border-teal-500' : 'border-border'}`}
            onClick={() => setSelectedId(wall.id)}
          >
            {wall.name}
          </button>
        ))}
      </div>

      {noSession && <p className="text-sm text-amber-500">{t('needSession')}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-56 rounded border border-border bg-background px-2 py-1 text-sm"
          aria-label={t('name')}
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="rounded bg-teal-600 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={noSession || saving || !name.trim()}
          onClick={handleSave}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {selectedId !== 'new' && (
          <button type="button" className="rounded border border-destructive px-2 py-1 text-xs text-destructive" onClick={handleDelete}>
            {t('delete')}
          </button>
        )}
        {outcome === 'saved' && <span className="text-xs text-teal-500">{t('saved')}</span>}
        {outcome && outcome !== 'saved' && <span className="text-xs text-destructive">{t(outcome)}</span>}
      </div>

      <WallBuilder layout={layout} onChange={setLayout} catalog={catalog} />

      <div>
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t('preview')}</div>
        <div className="rounded-md border border-border bg-black">
          <SpectronetWall wall={{ id: 'preview', name: name || t('namePlaceholder'), layout }} stripWidth={240} stripHeight={28} />
        </div>
      </div>
    </div>
  );
}
```

Nota sobre el botón Guardar deshabilitado sin nombre: el test de 409 escribe nombre antes de clickear, así que no choca.

- [ ] **Step 4: Verificar que pasa**

Run: `cd dashboard && npx vitest run components/WallManager.test.tsx`
Expected: PASS (5 tests). Si el `setTimeout` de duplicar resulta frágil en jsdom, reemplazar por un estado `pendingDuplicate` que el efecto de selección aplique al procesar `'new'` — el test es el contrato, la táctica es libre.

- [ ] **Step 5: Pestaña "Muro" en la página**

En `dashboard/app/(app)/spectrograms-live/page.tsx`:
- Envolver el export default en `<Suspense>` (patrón exacto de `globe/page.tsx`: el componente interno usa `useSearchParams`).
- Leer `const tab = searchParams.get('tab') === 'wall' ? 'wall' : 'cards';` y cambiar con `router.replace(`${pathname}?tab=${next}`, { scroll: false })` (patrón `admin/access/page.tsx`, botones con `aria-selected`).
- Labels de tabs: `t('wall.tabCards')` / `t('wall.tabWall')` del namespace `charts.spectrogramsPage`.
- `tab === 'wall'` → `<WallManager />`; `tab === 'cards'` → todo el contenido actual sin tocar.

Test (agregar a un archivo nuevo `dashboard/app/(app)/spectrograms-live/wall-tab.test.tsx`, con el mock ESTABLE de `next/navigation` vía `vi.hoisted` — `useSearchParams`, `useRouter`, `usePathname` — patrón `broadcast-default.test.tsx`): con `?tab=wall` se renderiza el manager (mockear `@/components/WallManager` con un `div data-testid="wall-manager"`) y sin query se ve la vista de tarjetas actual (assert de `getByTestId('wall-manager')` ausente).

- [ ] **Step 6: Verificar suite completa del dashboard**

Run: `cd dashboard && npx vitest run 2>&1 | tail -2`
Expected: todo passed

- [ ] **Step 7: Commit**

```bash
git add dashboard/components/WallManager.tsx dashboard/components/WallManager.test.tsx dashboard/app/\(app\)/spectrograms-live/
git commit -m "feat(muro): gestión de muros guardados con pestaña Muro y preview en vivo"
```

---

### Task 8: Selector de muro en la cartelera de `/globe`

**Files:**
- Create: `dashboard/lib/wall-selection.ts`
- Modify: `dashboard/components/GlobeBroadcastOverlay.tsx` (SWR L168 + popover de config L671-748)
- Modify: `dashboard/messages/es.json`, `dashboard/messages/en.json` (claves `globe.broadcast.wallSelector.*`)
- Test: `dashboard/lib/wall-selection.test.ts` + agregar casos a `dashboard/components/GlobeBroadcastOverlay.test.tsx`

**Interfaces:**
- Consumes: `listWalls` (Task 4), `Wall`/`WallResponse` (Task 4), SWR `'broadcast-wall'` existente.
- Produces:
  - `WALL_PARAM = 'wall'`, `WALL_STORAGE_KEY = 'globe.broadcast.wall.v1'`, `GLOBAL_WALL_ID = 'global'`
  - `readWallSelection(search: string, stored: string | null): string` — query param gana; default `'global'` (patrón `readFocusMode`).
  - `resolveWall(selectedId: string, userWalls: Wall[] | null | undefined, globalWall: WallResponse | undefined): WallResponse | undefined` — id desconocido o muro borrado → Global (el kiosk nunca queda en blanco).

- [ ] **Step 1: Escribir los tests de la lib que fallan**

```ts
// dashboard/lib/wall-selection.test.ts
import { describe, expect, it } from 'vitest';
import type { Wall, WallResponse } from './types';
import { GLOBAL_WALL_ID, readWallSelection, resolveWall } from './wall-selection';

const GLOBAL: WallResponse = {
  id: 'global',
  name: 'Global',
  layout: { columns: [{ groups: [] }], showMetrics: false },
};

const MINE: Wall = {
  id: 'w1',
  name: 'Andes',
  layout: { columns: [{ groups: [] }], showMetrics: false },
  created_at: '',
  updated_at: '',
};

describe('readWallSelection', () => {
  it('el query param gana sobre lo guardado', () => {
    expect(readWallSelection('?wall=w1', 'w2')).toBe('w1');
  });
  it('sin query usa lo guardado; sin nada, global', () => {
    expect(readWallSelection('', 'w2')).toBe('w2');
    expect(readWallSelection('', null)).toBe(GLOBAL_WALL_ID);
  });
});

describe('resolveWall', () => {
  it('encuentra el muro del usuario por id', () => {
    expect(resolveWall('w1', [MINE], GLOBAL)).toBe(MINE);
  });
  it('id desconocido o muro borrado cae al Global (kiosk nunca en blanco)', () => {
    expect(resolveWall('fantasma', [MINE], GLOBAL)).toBe(GLOBAL);
    expect(resolveWall('w1', null, GLOBAL)).toBe(GLOBAL);
  });
  it('global explícito devuelve el Global', () => {
    expect(resolveWall(GLOBAL_WALL_ID, [MINE], GLOBAL)).toBe(GLOBAL);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `cd dashboard && npx vitest run lib/wall-selection.test.ts`
Expected: FAIL — módulo inexistente

- [ ] **Step 3: Implementar la lib**

```ts
// dashboard/lib/wall-selection.ts
/**
 * Selección del muro de la cartelera (spec §2): query param `?wall=` gana
 * sobre localStorage (kiosks por URL), default el muro de fábrica "Global".
 * Lib pura, patrón readFocusMode de event-focus.ts.
 */

import type { Wall, WallResponse } from './types';

export const WALL_PARAM = 'wall';
export const WALL_STORAGE_KEY = 'globe.broadcast.wall.v1';
export const GLOBAL_WALL_ID = 'global';

export function readWallSelection(search: string, stored: string | null): string {
  const fromQuery = new URLSearchParams(search).get(WALL_PARAM);
  if (fromQuery) return fromQuery;
  if (stored) return stored;
  return GLOBAL_WALL_ID;
}

export function resolveWall(
  selectedId: string,
  userWalls: Wall[] | null | undefined,
  globalWall: WallResponse | undefined
): WallResponse | undefined {
  if (selectedId !== GLOBAL_WALL_ID) {
    const match = userWalls?.find((wall) => wall.id === selectedId);
    if (match) return match;
  }
  // Fallback deliberado: id desconocido/borrado → Global, la cartelera nunca en blanco
  return globalWall;
}
```

- [ ] **Step 4: Cablear el overlay** (`GlobeBroadcastOverlay.tsx`)

- i18n: agregar en `es.json` bajo `globe.broadcast`: `"wallSelector": { "label": "Muro", "global": "Global" }`; en `en.json`: `{ "label": "Wall", "global": "Global" }`.
- Junto al SWR existente de L168 (renombrar la variable `wallData` → `globalWall`, misma key `'broadcast-wall'`):

```ts
const { data: userWalls } = useSWR('broadcast-user-walls', () => listWalls(), {
  revalidateOnFocus: false,
});
const [wallId, setWallId] = useState<string>(() => {
  if (typeof window === 'undefined') return GLOBAL_WALL_ID;
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(WALL_STORAGE_KEY);
  } catch {
    // storage bloqueado: queda el default
  }
  return readWallSelection(window.location.search, stored);
});
const activeWall = resolveWall(wallId, userWalls, globalWall);
```

- Persistencia (efecto nuevo, patrón del `?event=` de `globe/page.tsx:116-123` — `history.replaceState`, NUNCA `router.replace`, que remonta el canvas WebGL):

```ts
useEffect(() => {
  try {
    window.localStorage.setItem(WALL_STORAGE_KEY, wallId);
  } catch {
    // storage bloqueado: la selección vive solo en la sesión
  }
  const url = new URL(window.location.href);
  if (wallId === GLOBAL_WALL_ID) url.searchParams.delete(WALL_PARAM);
  else url.searchParams.set(WALL_PARAM, wallId);
  window.history.replaceState(null, '', url.toString());
}, [wallId]);
```

- Render del muro: donde hoy se usa `wallData` (L796-816), pasar a `activeWall` — el fallback a `wallStrips` cuando no hay data queda igual.
- UI: en el popover de config (L671-748), sección nueva antes de la de espectrogramas, siguiendo el markup del radiogroup de focus (L702-720) pero con `<select>` nativo (los muros son N):

```tsx
<div>
  <div className="mb-1 text-xs font-semibold">{t('wallSelector.label')}</div>
  <select
    aria-label={t('wallSelector.label')}
    className="w-full rounded border border-border bg-background px-2 py-1 text-xs"
    value={wallId}
    onChange={(e) => setWallId(e.target.value)}
  >
    <option value={GLOBAL_WALL_ID}>{t('wallSelector.global')}</option>
    {(userWalls ?? []).map((wall) => (
      <option key={wall.id} value={wall.id}>{wall.name}</option>
    ))}
  </select>
</div>
```

- [ ] **Step 5: Tests del overlay** (agregar a `GlobeBroadcastOverlay.test.tsx`; sumar `listWalls` al set de mocks `vi.hoisted` con `vi.mock('@/lib/walls', ...)`; por default que devuelva `[]`)

```tsx
describe('selector de muro', () => {
  const USER_WALL = {
    id: 'w1',
    name: 'Andes',
    layout: {
      columns: [{ groups: [{ title: 'MI GRUPO', channels: [{ channel: 'II.NNA.00.BHZ', label: 'Lima' }] }] }],
      showMetrics: false,
    },
    created_at: '',
    updated_at: '',
  };

  it('?wall= renderiza el muro del usuario en la cartelera', async () => {
    listWallsMock.mockResolvedValue([USER_WALL]);
    window.history.replaceState(null, '', '?wall=w1');
    renderOverlay();
    await waitFor(() => expect(screen.getByText('MI GRUPO')).toBeTruthy());
    window.history.replaceState(null, '', '/');
  });

  it('un wall id desconocido cae al muro Global', async () => {
    listWallsMock.mockResolvedValue([USER_WALL]);
    window.history.replaceState(null, '', '?wall=fantasma');
    renderOverlay();
    // el muro global mockeado por getGlobalWall sigue en pantalla
    await waitFor(() => expect(screen.queryByText('MI GRUPO')).toBeNull());
    window.history.replaceState(null, '', '/');
  });

  it('elegir un muro en la config lo persiste en localStorage', async () => {
    listWallsMock.mockResolvedValue([USER_WALL]);
    renderOverlay();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /config/i }));
    await user.selectOptions(await screen.findByRole('combobox', { name: /muro/i }), 'w1');
    await waitFor(() => expect(localStorage.getItem('globe.broadcast.wall.v1')).toBe('w1'));
  });
});
```

(Usar los helpers reales del archivo: `renderOverlay`, nombres de botones del popover, etc. — si el botón de config tiene otro accesible name, seguir el existente.)

- [ ] **Step 6: Verificar TODO verde (dashboard + backend)**

Run: `cd dashboard && npx vitest run components/GlobeBroadcastOverlay.test.tsx lib/wall-selection.test.ts && npx vitest run 2>&1 | tail -2 && cd .. && ./venv/bin/python -m pytest tests/unit -q --no-cov 2>&1 | tail -1`
Expected: todo passed

- [ ] **Step 7: Commit + PR**

```bash
git add dashboard/lib/wall-selection.ts dashboard/lib/wall-selection.test.ts dashboard/components/GlobeBroadcastOverlay.tsx dashboard/components/GlobeBroadcastOverlay.test.tsx dashboard/messages/es.json dashboard/messages/en.json
git commit -m "feat(muro): selector de muro guardado en la cartelera con ?wall= para kiosks"
git push -u origin feat/spectronet-wall-w2
gh pr create --title "feat(muro): tabla walls + CRUD + armador manual + selector de muro (PR-W2)" --body "Implementa PR-W2 de docs/superpowers/specs/2026-08-20-spectronet-wall-design.md: migración 013 con tabla walls (ownership por usuario, nombre único por dueño), endpoints /walls con validación server-side (8 columnas / 120 canales / SCNL), armador manual con preview en vivo en la pestaña Muro de /spectrograms-live, y selector de muro guardado en la cartelera de /globe persistido en localStorage + ?wall= para kiosks. El layout persiste canales como {channel, label} (paridad con /walls/global del PR-W1)."
```

---

## Verificación final del PR

- [ ] Migración aplicada en local (`RUN_MIGRATIONS_ON_STARTUP` o `python -m scripts.apply_migrations`) y re-ejecutable (correrla dos veces no falla).
- [ ] QA manual: armar un muro en `/spectrograms-live?tab=wall`, guardarlo, verlo en `/globe` desde el popover de config, recargar (persiste), probar `?wall=<id>` en incógnito con sesión y sin sesión (sin sesión → Global).
- [ ] Verificación por mutación backend: invertir el `user_id = $2` del UPDATE por un `OR TRUE` y confirmar que `test_update_de_muro_ajeno_da_not_found` caza la mutación; quitar la llamada a `validate_wall_layout` en `create` y confirmar que `test_layout_invalido_no_llega_a_la_base` falla.
- [ ] Verificación por mutación frontend: las tres mutaciones de Task 5 Step 4.
- [ ] `mypy`/lint como venga configurado en pre-commit del repo (no agregar deuda nueva).
- [ ] Recordatorio deploy: la migración 013 corre en Railway vía `RUN_MIGRATIONS_ON_STARTUP` — verificar el flag en el servicio API antes de mergear (lección de la 008 de la landing).
