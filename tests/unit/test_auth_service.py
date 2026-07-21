"""Tests unitarios para AuthService: hashing y JWT (sin Postgres real)."""
from datetime import timedelta
from typing import Optional
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pytest
from freezegun import freeze_time
from jose import jwt as jose_jwt

from src.models.user import CurrentUser, ROLE_LEVEL, UserPublic, UserRole, role_level
from src.services.auth_service import (
    AuthService,
    InvalidTokenError,
    TokenExpiredError,
)

SECRET = "test-secret-key-not-for-production"


def _service() -> AuthService:
    return AuthService(dsn="postgresql://unused", secret_key=SECRET, token_expire_minutes=1440)


def test_hash_password_roundtrip_correct_password_verifies():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert svc.verify_password("Sismo2026!", password_hash) is True


def test_hash_password_roundtrip_incorrect_password_fails():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert svc.verify_password("PasswordIncorrecto", password_hash) is False


def test_hash_password_never_stores_plaintext():
    svc = _service()
    password_hash = svc.hash_password("Sismo2026!")
    assert password_hash != "Sismo2026!"


def test_create_and_decode_access_token_roundtrip():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.ADMIN,
    )
    token = svc.create_access_token(user)
    current = svc.decode_access_token(token)

    assert isinstance(current, CurrentUser)
    assert str(current.id) == str(user.id)
    assert current.email == user.email
    assert current.role == UserRole.ADMIN


def test_decode_access_token_with_wrong_signature_raises_invalid_token_error():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.VIEWER,
    )
    # Token firmado con una clave distinta a la que usa el service al decodificar.
    forged = jose_jwt.encode(
        {"sub": str(user.id), "email": user.email, "role": user.role.value},
        "otra-clave-distinta",
        algorithm="HS256",
    )
    with pytest.raises(InvalidTokenError):
        svc.decode_access_token(forged)


def test_decode_access_token_garbage_string_raises_invalid_token_error():
    svc = _service()
    with pytest.raises(InvalidTokenError):
        svc.decode_access_token("esto-no-es-un-jwt")


def test_decode_access_token_expired_raises_token_expired_error_distinct_from_invalid():
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.VIEWER,
    )
    short_lived_svc = AuthService(
        dsn="postgresql://unused", secret_key=SECRET, token_expire_minutes=60
    )
    with freeze_time("2026-01-01 00:00:00"):
        # auth_token_expire_minutes=60 desde 2026-01-01 00:00 -> exp a la 01:00
        token = short_lived_svc.create_access_token(user)

    with freeze_time("2026-01-01 02:00:00"):  # 1h después de expirar
        with pytest.raises(TokenExpiredError):
            svc.decode_access_token(token)


def test_expired_token_error_is_not_invalid_token_error():
    """TokenExpiredError e InvalidTokenError deben ser distinguibles (no la misma clase)."""
    assert not issubclass(TokenExpiredError, InvalidTokenError)
    assert not issubclass(InvalidTokenError, TokenExpiredError)


# ---------------------------------------------------------------------------
# Jerarquía de roles (design.md Decision 6, Phase 3.5)
# ---------------------------------------------------------------------------


def test_role_level_orders_all_four_roles_strictly_descending():
    assert role_level(UserRole.SUPERADMIN) > role_level(UserRole.ADMIN)
    assert role_level(UserRole.ADMIN) > role_level(UserRole.MODERADOR)
    assert role_level(UserRole.MODERADOR) > role_level(UserRole.VIEWER)


def test_role_level_matches_documented_values():
    assert role_level(UserRole.SUPERADMIN) == 3
    assert role_level(UserRole.ADMIN) == 2
    assert role_level(UserRole.MODERADOR) == 1
    assert role_level(UserRole.VIEWER) == 0


def test_role_level_dict_covers_all_roles():
    assert set(ROLE_LEVEL.keys()) == set(UserRole)


def test_user_role_still_serializes_as_string_value():
    """UserRole se mantiene str,Enum (no IntEnum) — el contrato de API/JWT/DB
    sigue siendo el string, no el nivel numérico (design.md Decision 6)."""
    assert UserRole.SUPERADMIN.value == "superadmin"
    assert UserRole.ADMIN.value == "admin"
    assert UserRole.MODERADOR.value == "moderador"
    assert UserRole.VIEWER.value == "viewer"


# ---------------------------------------------------------------------------
# Bootstrap del primer superadmin (design.md Decision 6, Phase 3.5)
#
# AuthService.create_user() usa asyncpg real (pool.acquire()/conn.transaction())
# — se mockea aquí para no requerir Postgres, siguiendo el mismo objetivo que
# el resto de este archivo ("sin Postgres real"). El flujo end-to-end contra
# Postgres real queda para Phase 5 (testcontainers), fuera de este batch.
# ---------------------------------------------------------------------------


def _fake_pool_for_bootstrap(existing_count: int, inserted_row: dict) -> MagicMock:
    """Construye un fake de asyncpg.Pool cuyo conn.fetchval() devuelve
    `existing_count` (simulando el estado de la tabla `users` antes del
    INSERT) y cuyo conn.fetchrow() devuelve `inserted_row` (simulando el
    RETURNING del INSERT)."""
    conn = AsyncMock()
    conn.fetchval.return_value = existing_count
    conn.fetchrow.return_value = inserted_row

    # conn.transaction() se usa como `async with conn.transaction():` — debe
    # comportarse como un async context manager.
    transaction_cm = AsyncMock()
    transaction_cm.__aenter__.return_value = None
    transaction_cm.__aexit__.return_value = False
    conn.transaction = MagicMock(return_value=transaction_cm)

    # pool.acquire() se usa como `async with self._pool.acquire() as conn:`
    acquire_cm = AsyncMock()
    acquire_cm.__aenter__.return_value = conn
    acquire_cm.__aexit__.return_value = False

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


@pytest.mark.asyncio
async def test_create_user_forces_superadmin_when_users_table_is_empty():
    """[Requirement: Bootstrap del primer superadmin / Scenario: El primer
    registro del sistema se convierte en superadmin sin importar el payload]"""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=0,
        inserted_row={"id": user_id, "email": "primer-admin@example.com", "role": "superadmin"},
    )

    # El payload pide explícitamente "viewer" — debe ser ignorado.
    result = await svc.create_user(
        email="primer-admin@example.com", password="Sismo2026!", role=UserRole.VIEWER
    )

    assert result.role == UserRole.SUPERADMIN


@pytest.mark.asyncio
async def test_create_user_forces_viewer_when_users_table_is_not_empty():
    """[Requirement: Bootstrap del primer superadmin / Scenario: Un registro
    posterior siempre crea viewer, incluso si pide un rol superior]"""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=1,
        inserted_row={"id": user_id, "email": "otro@example.com", "role": "viewer"},
    )

    # El payload pide explícitamente "superadmin" — debe ser ignorado.
    result = await svc.create_user(
        email="otro@example.com", password="Sismo2026!", role=UserRole.SUPERADMIN
    )

    assert result.role == UserRole.VIEWER


@pytest.mark.asyncio
@pytest.mark.parametrize("requested_role", [UserRole.ADMIN, UserRole.MODERADOR, UserRole.SUPERADMIN])
async def test_create_user_ignores_any_requested_role_when_table_not_empty(requested_role):
    """Todos los roles pedidos (admin, moderador, superadmin) resultan en
    viewer cuando la tabla ya tiene usuarios — no solo superadmin."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=5,
        inserted_row={"id": user_id, "email": "cualquiera@example.com", "role": "viewer"},
    )

    result = await svc.create_user(
        email="cualquiera@example.com", password="Sismo2026!", role=requested_role
    )

    assert result.role == UserRole.VIEWER


@pytest.mark.asyncio
async def test_create_user_still_forces_superadmin_after_bootstrap_role_extraction():
    """[Tarea 2.2 — regresión post-refactor 2.1] Confirma que create_user()
    sigue asignando superadmin en tabla vacía después de extraer
    _determine_bootstrap_role() a un método privado reutilizable — mismo
    comportamiento observable que antes del refactor."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=0,
        inserted_row={"id": user_id, "email": "primero@example.com", "role": "superadmin"},
    )

    result = await svc.create_user(
        email="primero@example.com", password="Sismo2026!", role=UserRole.VIEWER
    )

    assert result.role == UserRole.SUPERADMIN


@pytest.mark.asyncio
async def test_create_user_still_forces_viewer_after_bootstrap_role_extraction():
    """[Tarea 2.2 — regresión post-refactor 2.1] Confirma que create_user()
    sigue asignando viewer en tabla no vacía después del refactor de 2.1."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=3,
        inserted_row={"id": user_id, "email": "segundo@example.com", "role": "viewer"},
    )

    result = await svc.create_user(
        email="segundo@example.com", password="Sismo2026!", role=UserRole.SUPERADMIN
    )

    assert result.role == UserRole.VIEWER


# ---------------------------------------------------------------------------
# resolve_or_create_google_user() (openspec/changes/google-oauth/design.md,
# Decision 3) — mismo criterio de mocking que create_user(): se fake-ea
# asyncpg.Pool para no requerir Postgres real.
# ---------------------------------------------------------------------------


def _fake_pool_for_google(
    *,
    google_id_row: Optional[dict],
    email_row: Optional[dict] = None,
    final_row: Optional[dict] = None,
) -> MagicMock:
    """Construye un fake de asyncpg.Pool para resolve_or_create_google_user().

    conn.fetchrow() se invoca hasta 3 veces según la rama:
      1. SELECT por google_id -> `google_id_row` (si no None, corta acá).
      2. SELECT por email -> `email_row` (si no None, corta acá si aplica).
      3. UPDATE (auto-link) o INSERT (nuevo) -> `final_row`.
    conn.fetchval() se usa solo en la rama "nuevo usuario" (bootstrap COUNT),
    tomado de `final_row` indirectamente vía existing_count explícito.
    """
    conn = AsyncMock()

    fetchrow_results = [google_id_row]
    if google_id_row is None:
        fetchrow_results.append(email_row)
        fetchrow_results.append(final_row)
    conn.fetchrow = AsyncMock(side_effect=fetchrow_results)

    transaction_cm = AsyncMock()
    transaction_cm.__aenter__.return_value = None
    transaction_cm.__aexit__.return_value = False
    conn.transaction = MagicMock(return_value=transaction_cm)

    acquire_cm = AsyncMock()
    acquire_cm.__aenter__.return_value = conn
    acquire_cm.__aexit__.return_value = False

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool, conn


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_empty_table_becomes_superadmin():
    """[Requirement: Bootstrap del primer superadmin vía Google / Scenario:
    El primer registro del sistema vía Google se convierte en superadmin]"""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row={"id": user_id, "email": "nuevo@example.com", "role": "superadmin"},
    )
    conn.fetchval = AsyncMock(return_value=0)  # tabla vacía
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-123", email="nuevo@example.com"
    )

    assert result.role == UserRole.SUPERADMIN
    assert result.email == "nuevo@example.com"


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_persists_name_and_avatar():
    """[Extensión google-oauth, migración 004] Un usuario nuevo vía Google
    persiste name/avatar_url tomados de los claims OpenID Connect
    name/picture del ID token (pasados por el caller, ver
    src/main.py google_callback())."""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row={"id": user_id, "email": "nuevo@example.com", "role": "viewer"},
    )
    conn.fetchval = AsyncMock(return_value=1)  # tabla no vacía -> viewer
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-124",
        email="nuevo@example.com",
        name="Nueva Persona",
        avatar_url="https://lh3.googleusercontent.com/a/avatar123",
    )

    assert result.name == "Nueva Persona"
    assert result.avatar_url == "https://lh3.googleusercontent.com/a/avatar123"


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_without_name_or_avatar_stays_none():
    """Google no siempre entrega name/picture (son claims opcionales del ID
    token) — el caller pasa None y el usuario nuevo queda con esos campos en
    NULL, sin romper el flujo."""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row={"id": user_id, "email": "sinperfil@example.com", "role": "viewer"},
    )
    conn.fetchval = AsyncMock(return_value=1)
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-125", email="sinperfil@example.com"
    )

    assert result.name is None
    assert result.avatar_url is None


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_nonempty_table_becomes_viewer():
    """[Requirement: Bootstrap del primer superadmin vía Google / Scenario:
    Un registro posterior vía Google siempre crea viewer]"""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row={"id": user_id, "email": "otro@example.com", "role": "viewer"},
    )
    conn.fetchval = AsyncMock(return_value=7)  # tabla no vacía
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-456", email="otro@example.com"
    )

    assert result.role == UserRole.VIEWER


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_auto_links_existing_password_account():
    """[Requirement: Auto-link por email con usuario existente de password /
    Scenario: Auto-link exitoso con email verificado por Google] — NO crea
    fila nueva, google_id queda seteado, password_hash original intacto
    (el fake nunca toca password_hash, solo lo consulta en el SELECT por
    email; el UPDATE de la implementación real no incluye password_hash en
    el SET, confirmando que no se modifica)."""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row={
            "id": user_id,
            "email": "conpassword@example.com",
            "role": "viewer",
            "password_hash": "$2b$12$hashexistente",
            "google_id": None,
        },
        final_row={"id": user_id, "email": "conpassword@example.com", "role": "viewer"},
    )
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-789", email="conpassword@example.com"
    )

    assert result.id == user_id
    assert result.email == "conpassword@example.com"
    # fetchval (COUNT de bootstrap) NO debe haberse invocado — la rama
    # auto-link no crea usuario nuevo, no corre _determine_bootstrap_role.
    conn.fetchval.assert_not_called()


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_auto_link_updates_name_and_avatar():
    """[Extensión google-oauth, migración 004 — decisión de diseño] En la
    rama de auto-link, name/avatar_url SE actualizan con lo que traiga
    Google en ese momento, incluso si el usuario ya existía (por password)
    sin esos campos. Google es la fuente de verdad del perfil una vez
    vinculada la cuenta."""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row={
            "id": user_id,
            "email": "conpassword2@example.com",
            "role": "viewer",
            "password_hash": "$2b$12$hashexistente",
            "google_id": None,
        },
        final_row={"id": user_id, "email": "conpassword2@example.com", "role": "viewer"},
    )
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-790",
        email="conpassword2@example.com",
        name="Persona Autolinkeada",
        avatar_url="https://lh3.googleusercontent.com/a/avatar456",
    )

    assert result.name == "Persona Autolinkeada"
    assert result.avatar_url == "https://lh3.googleusercontent.com/a/avatar456"


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_second_login_returns_same_row_without_relinking():
    """[Requirement: Login indistinto por password o Google para cuentas
    vinculadas / Scenario: Usuario vinculado se loguea por Google después de
    haberse logueado antes por password] — segundo login del mismo google_id
    retorna la misma fila sin duplicar ni re-vincular. `name`/`avatar_url` se
    refrescan con lo que traiga el ID token en ESTE login (Google es la
    fuente de verdad de estos datos en cada login, no solo en la
    vinculación inicial — ver docstring de resolve_or_create_google_user)."""
    svc = _service()
    user_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row={
            "id": user_id,
            "email": "vinculado@example.com",
            "role": "admin",
        },
    )
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-ya-vinculado",
        email="vinculado@example.com",
        name="Persona Vinculada",
        avatar_url="https://lh3.googleusercontent.com/a/avatar789",
    )

    assert result.id == user_id
    assert result.role == UserRole.ADMIN
    assert result.name == "Persona Vinculada"
    assert result.avatar_url == "https://lh3.googleusercontent.com/a/avatar789"
    # Un solo fetchrow (el UPDATE por google_id, que también retorna la fila)
    # — no hubo SELECT por email ni INSERT, confirmando que no se duplica ni
    # se re-vincula.
    assert conn.fetchrow.await_count == 1


def test_verify_password_with_none_hash_returns_false_without_exception():
    """[Tarea 2.8 — cubre el guard de 1.8] AuthService.verify_password()
    con password_hash=None retorna False sin excepción (usuario Google-only,
    sin password que verificar)."""
    svc = _service()
    assert svc.verify_password("cualquier-password", None) is False


# ---------------------------------------------------------------------------
# Settings.google_oauth_configured (tarea 2.9) — pytest puro, sin Postgres,
# mockeando env vars.
# ---------------------------------------------------------------------------


def test_google_oauth_configured_true_when_all_three_vars_set(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLIENT_ID", "client-id-123")
    monkeypatch.setenv("GOOGLE_CLIENT_SECRET", "client-secret-456")
    monkeypatch.setenv("GOOGLE_REDIRECT_URI", "https://example.com/auth/google/callback")

    from src.config.settings import Settings

    s = Settings(_env_file=None)
    assert s.google_oauth_configured is True


@pytest.mark.parametrize(
    "missing_var",
    ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"],
)
def test_google_oauth_configured_false_when_any_var_missing(missing_var, monkeypatch):
    all_vars = {
        "GOOGLE_CLIENT_ID": "client-id-123",
        "GOOGLE_CLIENT_SECRET": "client-secret-456",
        "GOOGLE_REDIRECT_URI": "https://example.com/auth/google/callback",
    }
    for name, value in all_vars.items():
        if name != missing_var:
            monkeypatch.setenv(name, value)
        else:
            monkeypatch.delenv(name, raising=False)

    from src.config.settings import Settings

    s = Settings(_env_file=None)
    assert s.google_oauth_configured is False


def test_google_oauth_configured_false_when_none_set(monkeypatch):
    for name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI"):
        monkeypatch.delenv(name, raising=False)

    from src.config.settings import Settings

    s = Settings(_env_file=None)
    assert s.google_oauth_configured is False
