"""Tests unitarios para AuthService: hashing y JWT (sin Postgres real)."""

from datetime import datetime, timedelta, timezone
from typing import Optional
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import pyotp
import pytest
from freezegun import freeze_time
from jose import jwt as jose_jwt

from src.models.user import (
    CurrentUser,
    ROLE_LEVEL,
    UserProfileUpdate,
    UserPublic,
    UserRole,
    role_level,
)
from src.services.auth_service import (
    AuthService,
    EmailAlreadyRegisteredError,
    InvalidInvitationError,
    InvalidTokenError,
    InvalidTotpCodeError,
    InvitationEmailMismatchError,
    InvitationRequiredError,
    LastSuperadminError,
    Login2FAAttemptLimiter,
    MAX_TOTP_LOGIN_ATTEMPTS,
    PENDING_PREDICATE_SQL,
    TokenExpiredError,
    TooManyTotpAttemptsError,
    TotpAlreadyEnabledError,
    TotpNotAvailableForGoogleOnlyUserError,
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


def test_create_access_token_pending_2fa_produces_pre_auth_payload_with_short_expiry():
    """[Tarea 2.11] `create_access_token(user, pending_2fa=True)` produce un
    token cuyo payload decodificado tiene `pending_2fa=True`, `typ=pre_auth`,
    y una expiración ~2 minutos en el futuro (no la expiración estándar de
    1440 minutos configurada en `_service()`)."""
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.ADMIN,
    )
    with freeze_time("2026-01-01 00:00:00"):
        token = svc.create_access_token(user, pending_2fa=True)
        payload = svc.decode_token_payload(token)

    assert payload["sub"] == str(user.id)
    assert payload["pending_2fa"] is True
    assert payload["typ"] == "pre_auth"
    # Expiración a ~2 minutos, NO a 1440 minutos (expiración estándar).
    expire = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
    issued_at = datetime.fromtimestamp(payload["iat"], tz=timezone.utc)
    assert (expire - issued_at) == timedelta(minutes=2)


def test_create_access_token_without_pending_2fa_flag_keeps_pre_existing_shape():
    """[Tarea 2.11] `create_access_token(user)` (sin el flag, default False)
    sigue produciendo el shape idéntico al pre-existente: sin el claim
    `pending_2fa`, sin `typ`, con `email`/`role` presentes."""
    svc = _service()
    user = UserPublic(
        id="3f9a2b1c-1111-2222-3333-444455556666",
        email="ana@example.com",
        role=UserRole.ADMIN,
    )
    token = svc.create_access_token(user)
    payload = svc.decode_token_payload(token)

    assert "pending_2fa" not in payload
    assert "typ" not in payload
    assert payload["email"] == user.email
    assert payload["role"] == user.role.value


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
async def test_create_user_requires_invitation_when_users_table_is_not_empty():
    """Cierre invitation-only (email-invitations, Decision 5): con la tabla
    NO vacía y sin token de invitación, el registro se RECHAZA — reemplaza
    al contrato anterior ("registro posterior crea viewer"), que era
    exactamente el auto-provisioning que permitía entrar sin invitación.
    El rol pedido (superadmin) sigue sin tener ningún efecto."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=1,
        inserted_row={"id": user_id, "email": "otro@example.com", "role": "viewer"},
    )

    with pytest.raises(InvitationRequiredError):
        await svc.create_user(
            email="otro@example.com", password="Sismo2026!", role=UserRole.SUPERADMIN
        )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "requested_role", [UserRole.ADMIN, UserRole.MODERADOR, UserRole.SUPERADMIN]
)
async def test_create_user_rejects_any_requested_role_without_invitation(requested_role):
    """Ningún rol pedido (admin, moderador, superadmin) abre la puerta: con
    la tabla no vacía y sin invitación, TODOS los registros se rechazan —
    versión invitation-only del viejo "todos resultan en viewer"."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=5,
        inserted_row={"id": user_id, "email": "cualquiera@example.com", "role": "viewer"},
    )

    with pytest.raises(InvitationRequiredError):
        await svc.create_user(
            email="cualquiera@example.com", password="Sismo2026!", role=requested_role
        )


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
async def test_create_user_still_rejects_after_bootstrap_role_extraction():
    """[Tarea 2.2 — regresión post-refactor 2.1, actualizado por el cierre
    invitation-only] En tabla no vacía y sin token, create_user() rechaza —
    la extracción de _determine_bootstrap_role() sigue decidiendo que NO es
    bootstrap, y eso ahora significa invitación obligatoria."""
    svc = _service()
    user_id = uuid4()
    svc._pool = _fake_pool_for_bootstrap(
        existing_count=3,
        inserted_row={"id": user_id, "email": "segundo@example.com", "role": "viewer"},
    )

    with pytest.raises(InvitationRequiredError):
        await svc.create_user(
            email="segundo@example.com", password="Sismo2026!", role=UserRole.SUPERADMIN
        )


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
      1. SELECT por google_id -> `google_id_row`.
      2a. Si matcheó: UPDATE de refresco de name/avatar_url -> `final_row`
          (o el propio `google_id_row` si no se pasó `final_row`).
      2b. Si no matcheó: SELECT por email -> `email_row`, y luego
          UPDATE (auto-link) o INSERT (nuevo) -> `final_row`.

    (user-management, tarea 1.9) La rama "ya vinculado" pasó de UN
    `UPDATE ... RETURNING` a un `SELECT` + `UPDATE` separados, para poder
    aplicar el guard de cuenta desactivada ENTRE la resolución y la escritura.
    Por eso ahora consume dos fetchrow en vez de uno.

    `deactivated_at` se inyecta con default None (cuenta ACTIVA) en las filas
    resueltas que no lo traen: el guard nuevo lo lee y un dict sin la clave
    reventaría con KeyError. Los tests que quieran simular una cuenta
    desactivada lo pasan explícito — aunque la cobertura real de ese camino
    vive en tests/unit/test_user_management.py, contra Postgres de verdad.

    conn.fetchval() se usa solo en la rama "nuevo usuario" (bootstrap COUNT),
    tomado de `final_row` indirectamente vía existing_count explícito.
    """
    conn = AsyncMock()

    def _with_active_default(row):
        if row is None or "deactivated_at" in row:
            return row
        return {**row, "deactivated_at": None}

    google_id_row = _with_active_default(google_id_row)
    email_row = _with_active_default(email_row)

    if google_id_row is not None:
        # SELECT por google_id + UPDATE de refresco de perfil.
        fetchrow_results = [google_id_row, final_row if final_row is not None else google_id_row]
    else:
        fetchrow_results = [google_id_row, email_row, final_row]
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
        final_row={"id": user_id, "email": "nuevo@example.com", "role": "superadmin"},
    )
    # Tabla VACÍA -> bootstrap: acá se testea la persistencia de perfil, no
    # el gate de invitación (que sólo aplica cuando no es bootstrap).
    conn.fetchval = AsyncMock(return_value=0)
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
        final_row={"id": user_id, "email": "sinperfil@example.com", "role": "superadmin"},
    )
    # Tabla vacía -> bootstrap, mismo criterio que el test de arriba.
    conn.fetchval = AsyncMock(return_value=0)
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-125", email="sinperfil@example.com"
    )

    assert result.name is None
    assert result.avatar_url is None


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_requires_invitation():
    """Cierre invitation-only (email-invitations, Decision 5): una cuenta de
    Google SIN usuario existente ni invitación vigente NO entra — reemplaza
    al contrato anterior ("registro posterior vía Google crea viewer"), que
    era el auto-provisioning del incidente del 2026-08-06. El tercer
    fetchrow (None) es el UPDATE de consumo que no matchea invitación."""
    svc = _service()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row=None,  # UPDATE invitations ... RETURNING -> sin invitación
    )
    conn.fetchval = AsyncMock(return_value=7)  # tabla no vacía
    svc._pool = pool

    with pytest.raises(InvitationRequiredError):
        await svc.resolve_or_create_google_user(
            google_id="google-sub-456", email="otro@example.com"
        )


@pytest.mark.asyncio
async def test_resolve_or_create_google_user_new_user_consumes_invitation_role():
    """Camino feliz del gate Google: hay invitación pendiente para el email
    (consumida por match case-insensitive) y el usuario nuevo hereda el ROL
    de la invitación, no el viewer de bootstrap."""
    svc = _service()
    user_id = uuid4()
    invitation_id = uuid4()
    pool, conn = _fake_pool_for_google(
        google_id_row=None,
        email_row=None,
        final_row=None,
    )
    # Secuencia real de fetchrow en la rama nuevo-usuario con invitación:
    # UPDATE por google_id -> None; SELECT por email -> None;
    # UPDATE invitations (consumo) -> fila de invitación; INSERT users -> fila.
    conn.fetchrow = AsyncMock(
        side_effect=[
            None,
            None,
            {"id": invitation_id, "email": "invitada@example.com", "role": "moderador"},
            {"id": user_id, "email": "invitada@example.com", "role": "moderador"},
        ]
    )
    conn.fetchval = AsyncMock(return_value=7)  # tabla no vacía
    svc._pool = pool

    result = await svc.resolve_or_create_google_user(
        google_id="google-sub-789", email="invitada@example.com"
    )

    assert result.role == UserRole.MODERADOR
    # accepted_by se setea con el id del usuario recién creado.
    conn.execute.assert_awaited_once()


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
    # DOS fetchrow y ni uno más: el SELECT por google_id (que resuelve al
    # usuario) y el UPDATE que refresca name/avatar_url. No hubo SELECT por
    # email ni INSERT, confirmando que no se duplica ni se re-vincula.
    #
    # Eran uno solo hasta user-management (tarea 1.9): la rama "ya vinculado"
    # se partió en SELECT + UPDATE para poder rechazar una cuenta desactivada
    # ANTES de escribirle la fila. El invariante que este test protege (no se
    # toca la rama de email ni la de creación) no cambió.
    assert conn.fetchrow.await_count == 2


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


# ---------------------------------------------------------------------------
# account-settings (migración 005) — Phase 2: Backend core (AuthService)
#
# Mismo criterio de mocking que el resto del archivo: fake de asyncpg.Pool,
# sin Postgres real. `conn.transaction()`/`pool.acquire()` se simulan como
# async context managers; `conn.fetch()` (plural, retorna lista de filas)
# se agrega para consume_backup_code()/delete_account(), que no estaba
# cubierto por los helpers pre-existentes (que solo mockeaban fetchrow/
# fetchval).
# ---------------------------------------------------------------------------


def _fake_conn(
    *,
    fetchrow_results: Optional[list] = None,
    fetchval_results: Optional[list] = None,
    fetch_results: Optional[list] = None,
) -> MagicMock:
    """Fake de asyncpg.Connection cuyo fetchrow()/fetchval()/fetch() devuelven,
    en orden de invocación, los valores de las listas dadas (side_effect).
    execute() no hace nada (no se valida su SQL en estos tests, solo el
    efecto observable sobre fetchrow/fetch subsiguientes)."""
    conn = AsyncMock()
    if fetchrow_results is not None:
        conn.fetchrow = AsyncMock(side_effect=fetchrow_results)
    if fetchval_results is not None:
        conn.fetchval = AsyncMock(side_effect=fetchval_results)
    if fetch_results is not None:
        conn.fetch = AsyncMock(side_effect=fetch_results)
    conn.execute = AsyncMock(return_value=None)

    transaction_cm = AsyncMock()
    transaction_cm.__aenter__.return_value = None
    transaction_cm.__aexit__.return_value = False
    conn.transaction = MagicMock(return_value=transaction_cm)
    return conn


def _fake_pool_with_conn(conn: MagicMock) -> MagicMock:
    acquire_cm = AsyncMock()
    acquire_cm.__aenter__.return_value = conn
    acquire_cm.__aexit__.return_value = False

    pool = MagicMock()
    pool.acquire = MagicMock(return_value=acquire_cm)
    return pool


# --- get_profile()/update_profile() -----------------------------------------


@pytest.mark.asyncio
async def test_get_profile_with_all_fields_completed_returns_them():
    """[Requirement: Consulta del perfil extendido propio / Scenario: Usuario
    autenticado consulta su perfil con todos los campos completos]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": "Ana Gómez",
                "address": "Av. Siempre Viva 742",
                "phone": "+54 9 11 5555-5555",
                "totp_enabled": False,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    profile = await svc.get_profile(user_id)

    assert profile.full_name == "Ana Gómez"
    assert profile.address == "Av. Siempre Viva 742"
    assert profile.phone == "+54 9 11 5555-5555"
    assert profile.totp_enabled is False


@pytest.mark.asyncio
async def test_get_profile_never_completed_returns_all_none_without_error():
    """[Requirement: Consulta del perfil extendido propio / Scenario: Usuario
    autenticado consulta su perfil sin haberlo completado nunca]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": None,
                "address": None,
                "phone": None,
                "totp_enabled": False,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    profile = await svc.get_profile(user_id)

    assert profile.full_name is None
    assert profile.address is None
    assert profile.phone is None
    assert profile.totp_enabled is False


@pytest.mark.asyncio
async def test_get_profile_with_totp_enabled_true_returns_it():
    """[Fix puntual post-Phase 4] `totp_enabled` viaja en `true` cuando el
    usuario tiene 2FA activo — cubre el gap de contrato que forzaba al
    frontend a pegarle a GET /account/export solo para leer este flag."""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": None,
                "address": None,
                "phone": None,
                "totp_enabled": True,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    profile = await svc.get_profile(user_id)

    assert profile.totp_enabled is True


@pytest.mark.asyncio
async def test_update_profile_completes_all_fields_first_time():
    """[Requirement: Edición del perfil extendido propio / Scenario: Usuario
    completa su perfil por primera vez con todos los campos]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": "Ana Gómez",
                "address": "Av. Siempre Viva 742",
                "phone": "+54 9 11 5555-5555",
                "totp_enabled": False,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    update = UserProfileUpdate(
        full_name="Ana Gómez", address="Av. Siempre Viva 742", phone="+54 9 11 5555-5555"
    )
    profile = await svc.update_profile(user_id, update)

    assert profile.full_name == "Ana Gómez"
    assert profile.address == "Av. Siempre Viva 742"
    assert profile.phone == "+54 9 11 5555-5555"
    assert profile.totp_enabled is False


@pytest.mark.asyncio
async def test_update_profile_partial_edit_leaves_rest_untouched():
    """[Requirement: Edición del perfil extendido propio / Scenario: Usuario
    edita parcialmente su perfil dejando el resto sin tocar]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": "Ana Gómez",
                "address": "Av. Siempre Viva 742",
                "phone": "+54 9 11 4444-4444",
                "totp_enabled": False,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    update = UserProfileUpdate(phone="+54 9 11 4444-4444")
    profile = await svc.update_profile(user_id, update)

    assert profile.phone == "+54 9 11 4444-4444"
    # El SET debe referenciar solo `phone` (+ updated_at), no full_name/
    # address -- la cláusula RETURNING siempre menciona las tres columnas
    # (para poder devolver el UserProfile completo), así que se inspecciona
    # específicamente la porción SET, no la query entera.
    executed_sql = conn.fetchrow.call_args_list[0][0][0]
    set_clause = executed_sql.split("WHERE")[0]
    assert "phone = " in set_clause
    assert "full_name = " not in set_clause
    assert "address = " not in set_clause


@pytest.mark.asyncio
async def test_update_profile_empty_update_is_noop_without_error():
    """[Requirement: Edición del perfil extendido propio / Scenario: Perfil
    se puede dejar completamente vacío sin error]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {
                "full_name": None,
                "address": None,
                "phone": None,
                "totp_enabled": False,
                "locale": None,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    update = UserProfileUpdate()  # nada seteado -> exclude_unset={} vacío
    profile = await svc.update_profile(user_id, update)

    assert profile.full_name is None
    assert profile.address is None
    assert profile.phone is None
    assert profile.totp_enabled is False
    # No debe haber ejecutado ningún UPDATE (no-op observable): el único
    # fetchrow invocado es el de get_profile() (fallback), no un UPDATE.
    conn.execute.assert_not_called()


def test_user_profile_update_has_no_role_email_or_password_fields():
    """[Requirement: Edición del perfil extendido propio / Scenario: Intento
    de modificar role o email vía este endpoint es ignorado o rechazado] —
    confirmado a nivel de tipos: UserProfileUpdate no declara esos campos,
    por lo que ningún caller puede colarlos a través de update_profile()."""
    fields = set(UserProfileUpdate.model_fields.keys())
    assert "role" not in fields
    assert "email" not in fields
    assert "password_hash" not in fields
    assert fields == {"full_name", "address", "phone", "locale"}


# --- enable_totp() -----------------------------------------------------------


@pytest.mark.asyncio
async def test_enable_totp_with_password_user_returns_uri_and_ten_backup_codes():
    """[Requirement: Activación de 2FA TOTP restringida a usuarios con
    password propio / Scenario: Usuario con password activa 2FA
    exitosamente]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {"password_hash": "$2b$12$hash", "totp_enabled": False, "email": "ana@example.com"}
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    otpauth_uri, backup_codes = await svc.enable_totp(user_id)

    assert otpauth_uri.startswith("otpauth://totp/")
    assert "ana%40example.com" in otpauth_uri or "ana@example.com" in otpauth_uri
    assert len(backup_codes) == 10
    for code in backup_codes:
        assert len(code) == 9  # "XXXX-XXXX"
        assert code[4] == "-"


@pytest.mark.asyncio
async def test_enable_totp_google_only_user_raises_and_persists_nothing():
    """[Requirement: Activación de 2FA TOTP restringida a usuarios con
    password propio / Scenario: Usuario 100% Google sin password es
    rechazado al intentar activar 2FA]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {"password_hash": None, "totp_enabled": False, "email": "google@example.com"}
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    with pytest.raises(TotpNotAvailableForGoogleOnlyUserError):
        await svc.enable_totp(user_id)

    # No debe haber ejecutado ningún UPDATE/INSERT/DELETE posterior al
    # SELECT inicial -- el rechazo ocurre ANTES de cualquier escritura.
    conn.execute.assert_not_called()


@pytest.mark.asyncio
async def test_enable_totp_already_enabled_raises_without_reset():
    """[Tarea 2.16] Usuario con totp_enabled=true que llama enable_totp() de
    nuevo -> TotpAlreadyEnabledError (re-setup sin disable previo)."""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {"password_hash": "$2b$12$hash", "totp_enabled": True, "email": "ana@example.com"}
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    with pytest.raises(TotpAlreadyEnabledError):
        await svc.enable_totp(user_id)

    conn.execute.assert_not_called()


@pytest.mark.asyncio
async def test_enable_totp_second_call_before_verify_invalidates_previous_backup_codes():
    """[Tarea 2.20] enable_totp() -> enable_totp() de nuevo ANTES de verificar
    (totp_enabled sigue false) -- la segunda llamada SÍ debe suceder, y el
    DELETE de user_backup_codes invalida los códigos del primer setup."""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[
            {"password_hash": "$2b$12$hash", "totp_enabled": False, "email": "ana@example.com"}
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    # Segunda llamada (independiente, mismo fake -- simula que totp_enabled
    # sigue false porque nunca se llamó verify_totp_setup()).
    otpauth_uri, backup_codes = await svc.enable_totp(user_id)

    assert len(backup_codes) == 10
    # DELETE FROM user_backup_codes fue invocado (invalida el setup previo).
    delete_calls = [call for call in conn.execute.call_args_list if "DELETE" in call[0][0]]
    assert len(delete_calls) == 1


# --- verify_totp_setup() ------------------------------------------------------


@pytest.mark.asyncio
async def test_verify_totp_setup_valid_code_enables_totp():
    """[Requirement: Verificación del código TOTP en el setup / Scenario:
    Código TOTP válido en el setup habilita 2FA]"""
    svc = _service()
    user_id = uuid4()
    secret = pyotp.random_base32()
    valid_code = pyotp.TOTP(secret).now()
    conn = _fake_conn(fetchrow_results=[{"totp_secret": secret}])
    svc._pool = _fake_pool_with_conn(conn)

    await svc.verify_totp_setup(user_id, valid_code)

    conn.execute.assert_called_once()
    executed_sql = conn.execute.call_args[0][0]
    assert "totp_enabled = true" in executed_sql


@pytest.mark.asyncio
async def test_verify_totp_setup_invalid_code_raises_and_does_not_enable():
    """[Requirement: Verificación del código TOTP en el setup / Scenario:
    Código TOTP inválido en el setup no habilita 2FA]"""
    svc = _service()
    user_id = uuid4()
    secret = pyotp.random_base32()
    conn = _fake_conn(fetchrow_results=[{"totp_secret": secret}])
    svc._pool = _fake_pool_with_conn(conn)

    with pytest.raises(InvalidTotpCodeError):
        await svc.verify_totp_setup(user_id, "000000")

    conn.execute.assert_not_called()


# --- disable_totp() ------------------------------------------------------------


@pytest.mark.asyncio
async def test_disable_totp_enabled_user_clears_secret_flag_and_backup_codes():
    """[Requirement: Deshabilitación de 2FA / Scenario: Usuario autenticado
    deshabilita su 2FA exitosamente]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn()
    svc._pool = _fake_pool_with_conn(conn)

    await svc.disable_totp(user_id)

    assert conn.execute.call_count == 2
    update_sql = conn.execute.call_args_list[0][0][0]
    delete_sql = conn.execute.call_args_list[1][0][0]
    assert "totp_secret = NULL" in update_sql
    assert "totp_enabled = false" in update_sql
    assert "DELETE FROM user_backup_codes" in delete_sql


@pytest.mark.asyncio
async def test_disable_totp_already_disabled_is_idempotent_no_exception():
    """[Tarea 2.23] disable_totp() sobre un usuario ya totp_enabled=false no
    lanza excepción (idempotencia)."""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn()
    svc._pool = _fake_pool_with_conn(conn)

    await svc.disable_totp(user_id)  # no debe lanzar


# --- consume_backup_code() ----------------------------------------------------


@pytest.mark.asyncio
async def test_consume_backup_code_valid_unused_code_returns_true_and_marks_used():
    """[Requirement: Uso de backup codes como alternativa al código TOTP en
    el login / Scenario: Login exitoso usando un backup code válido en vez
    del código TOTP] -- insumo directo vía consume_backup_code() unitario."""
    svc = _service()
    user_id = uuid4()
    code = "ABCD-1234"
    code_hash = svc.hash_password(code)
    row_id = uuid4()
    conn = _fake_conn(fetch_results=[[{"id": row_id, "code_hash": code_hash}]])
    svc._pool = _fake_pool_with_conn(conn)

    result = await svc.consume_backup_code(user_id, code)

    assert result is True
    conn.execute.assert_called_once()
    executed_sql, executed_args = conn.execute.call_args[0][0], conn.execute.call_args[0][1:]
    assert "used_at = now()" in executed_sql
    assert executed_args == (row_id,)


@pytest.mark.asyncio
async def test_consume_backup_code_already_used_code_cannot_be_reused():
    """[Requirement: Uso de backup codes como alternativa al código TOTP en
    el login / Scenario: Un backup code ya usado no puede reutilizarse] --
    la fila ya usada no aparece en el resultado (`WHERE used_at IS NULL`
    la excluye), por lo que consume_backup_code() no la encuentra."""
    svc = _service()
    user_id = uuid4()
    code = "ABCD-1234"
    # Simula que el filtro WHERE used_at IS NULL ya excluyó la fila usada:
    # el SELECT no devuelve ninguna fila candidata.
    conn = _fake_conn(fetch_results=[[]])
    svc._pool = _fake_pool_with_conn(conn)

    result = await svc.consume_backup_code(user_id, code)

    assert result is False
    conn.execute.assert_not_called()


# --- verify_totp_or_backup_code() ---------------------------------------------


@pytest.mark.asyncio
async def test_verify_totp_or_backup_code_valid_totp_does_not_consume_backup_code():
    """Código TOTP válido vigente -> retorna True sin tocar backup codes."""
    svc = _service()
    user_id = uuid4()
    secret = pyotp.random_base32()
    valid_code = pyotp.TOTP(secret).now()
    conn = _fake_conn(fetchrow_results=[{"totp_secret": secret}])
    svc._pool = _fake_pool_with_conn(conn)

    result = await svc.verify_totp_or_backup_code(user_id, valid_code)

    assert result is True
    conn.fetch.assert_not_called()


@pytest.mark.asyncio
async def test_verify_totp_or_backup_code_falls_back_to_backup_code_and_consumes_it():
    """Código que no matchea como TOTP pero sí como backup code -> retorna
    True Y el backup code queda consumido (delega a consume_backup_code)."""
    svc = _service()
    user_id = uuid4()
    secret = pyotp.random_base32()
    code = "ABCD-1234"
    code_hash = svc.hash_password(code)
    row_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[{"totp_secret": secret}],
        fetch_results=[[{"id": row_id, "code_hash": code_hash}]],
    )
    svc._pool = _fake_pool_with_conn(conn)

    result = await svc.verify_totp_or_backup_code(user_id, code)

    assert result is True
    conn.execute.assert_called_once()  # marcó el backup code como usado


@pytest.mark.asyncio
async def test_verify_totp_or_backup_code_invalid_both_returns_false_no_mutation():
    """Código inválido tanto como TOTP como backup code -> False, ninguna
    fila de user_backup_codes se modifica."""
    svc = _service()
    user_id = uuid4()
    secret = pyotp.random_base32()
    conn = _fake_conn(fetchrow_results=[{"totp_secret": secret}], fetch_results=[[]])
    svc._pool = _fake_pool_with_conn(conn)

    result = await svc.verify_totp_or_backup_code(user_id, "000000")

    assert result is False
    conn.execute.assert_not_called()


# --- export_user_data() -------------------------------------------------------


@pytest.mark.asyncio
async def test_export_user_data_returns_valid_json_shape_with_profile_and_account():
    """[Requirement: Exportación de los propios datos de cuenta / Scenario:
    Usuario autenticado exporta sus propios datos]"""
    svc = _service()
    user_id = uuid4()
    now = datetime.now(timezone.utc)
    conn = _fake_conn(
        fetchrow_results=[
            {
                "id": user_id,
                "email": "ana@example.com",
                "role": "viewer",
                "google_id": None,
                "name": None,
                "avatar_url": None,
                "created_at": now,
                "updated_at": now,
                "full_name": "Ana Gómez",
                "address": "Av. Siempre Viva 742",
                "phone": None,
                "has_password": True,
                "totp_enabled": False,
                "linked_google_account": False,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    export = await svc.export_user_data(user_id)

    assert export.account["email"] == "ana@example.com"
    assert export.account["role"] == "viewer"
    assert export.profile.full_name == "Ana Gómez"
    assert export.security["has_password"] is True


@pytest.mark.asyncio
async def test_export_user_data_never_includes_password_hash_or_totp_secret_or_code_hash():
    """[Requirement: Exportación de los propios datos de cuenta] -- assert
    explícito recorriendo el dict serializado, no solo confiar en el shape
    declarado por AccountExport."""
    svc = _service()
    user_id = uuid4()
    now = datetime.now(timezone.utc)
    conn = _fake_conn(
        fetchrow_results=[
            {
                "id": user_id,
                "email": "ana@example.com",
                "role": "viewer",
                "google_id": None,
                "name": None,
                "avatar_url": None,
                "created_at": now,
                "updated_at": now,
                "full_name": None,
                "address": None,
                "phone": None,
                "has_password": True,
                "totp_enabled": True,
                "linked_google_account": False,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    export = await svc.export_user_data(user_id)

    # [Fix puntual] export.profile.totp_enabled debe coincidir con
    # export.security["totp_enabled"] -- antes de este fix, profile.totp_enabled
    # quedaba en el default False de UserProfile aunque el usuario tuviera 2FA
    # activo (totp_enabled=True en la fila mockeada arriba), una inconsistencia
    # de datos pura porque ambos valores salen de la MISMA fila de `users`.
    assert export.profile.totp_enabled is True
    assert export.profile.totp_enabled == export.security["totp_enabled"]

    serialized = export.model_dump()

    def _walk(obj):
        if isinstance(obj, dict):
            for k, v in obj.items():
                assert k not in ("password_hash", "totp_secret", "code_hash")
                _walk(v)
        elif isinstance(obj, (list, tuple)):
            for item in obj:
                _walk(item)

    _walk(serialized)
    # Confirmación adicional: el SELECT ejecutado nunca pide esas columnas.
    executed_sql = conn.fetchrow.call_args[0][0]
    assert "password_hash IS NOT NULL" in executed_sql  # sí se pide el booleano derivado
    assert "SELECT password_hash," not in executed_sql
    assert "totp_secret" not in executed_sql
    assert "code_hash" not in executed_sql


@pytest.mark.asyncio
async def test_export_user_data_of_user_a_never_includes_user_b_values():
    """[Requirement: Exportación de los propios datos de cuenta / Scenario:
    El export nunca incluye datos de otro usuario]"""
    svc = _service()
    user_a_id = uuid4()
    now = datetime.now(timezone.utc)
    conn = _fake_conn(
        fetchrow_results=[
            {
                "id": user_a_id,
                "email": "usuario_a@example.com",
                "role": "viewer",
                "google_id": None,
                "name": None,
                "avatar_url": None,
                "created_at": now,
                "updated_at": now,
                "full_name": "Usuario A",
                "address": "Direccion A",
                "phone": "111",
                "has_password": True,
                "totp_enabled": False,
                "linked_google_account": False,
            }
        ]
    )
    svc._pool = _fake_pool_with_conn(conn)

    export = await svc.export_user_data(user_a_id)

    assert export.account["email"] == "usuario_a@example.com"
    assert "usuario_b" not in str(export.model_dump()).lower()
    # La query fue parametrizada con el user_id de usuario_a -- confirma que
    # no hay forma de que la fila de otro usuario aparezca en este resultado.
    executed_args = conn.fetchrow.call_args[0][1:]
    assert executed_args == (user_a_id,)


# --- delete_account() ----------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_account_non_superadmin_deletes_successfully():
    """[Requirement: Eliminación de la propia cuenta / Scenario: Usuario
    no-superadmin-único elimina su propia cuenta exitosamente]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(fetchrow_results=[{"role": "viewer"}])
    svc._pool = _fake_pool_with_conn(conn)

    await svc.delete_account(user_id)

    conn.execute.assert_called_once()
    executed_sql, executed_args = conn.execute.call_args[0][0], conn.execute.call_args[0][1:]
    assert "DELETE FROM users" in executed_sql
    assert executed_args == (user_id,)
    # No debe haber consultado el COUNT de superadmins (no es superadmin).
    conn.fetch.assert_not_called()


@pytest.mark.asyncio
async def test_delete_account_last_superadmin_raises_and_row_remains():
    """[Requirement: Eliminación de la propia cuenta / Scenario: El último
    superadmin del sistema no puede eliminar su propia cuenta]"""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[{"role": "superadmin"}],
        fetch_results=[[{"id": user_id}]],  # un único superadmin
    )
    svc._pool = _fake_pool_with_conn(conn)

    with pytest.raises(LastSuperadminError):
        await svc.delete_account(user_id)

    conn.execute.assert_not_called()  # ningún DELETE ejecutado


@pytest.mark.asyncio
async def test_delete_account_non_unique_superadmin_deletes_successfully():
    """[Requirement: Eliminación de la propia cuenta / Scenario: Un
    superadmin que no es el único puede eliminar su propia cuenta]"""
    svc = _service()
    user_id = uuid4()
    other_superadmin_id = uuid4()
    conn = _fake_conn(
        fetchrow_results=[{"role": "superadmin"}],
        fetch_results=[[{"id": user_id}, {"id": other_superadmin_id}]],  # dos superadmins
    )
    svc._pool = _fake_pool_with_conn(conn)

    await svc.delete_account(user_id)

    conn.execute.assert_called_once()
    executed_sql = conn.execute.call_args[0][0]
    assert "DELETE FROM users" in executed_sql


@pytest.mark.asyncio
async def test_delete_account_nonexistent_user_is_idempotent_noop():
    """[Tarea 2.40] delete_account() sobre un user_id que ya no existe
    (row is None) no lanza excepción -- no-op idempotente."""
    svc = _service()
    user_id = uuid4()
    conn = _fake_conn(fetchrow_results=[None])
    svc._pool = _fake_pool_with_conn(conn)

    await svc.delete_account(user_id)  # no debe lanzar

    conn.execute.assert_not_called()


@pytest.mark.asyncio
async def test_delete_account_concurrent_last_two_superadmins_exactly_one_succeeds():
    """[Tarea 2.39] Test de concurrencia contra Postgres real (no mockeado):
    con exactamente dos superadmins en la base, disparar delete_account()
    para ambos concurrentemente y confirmar que exactamente UNO completa el
    DELETE y el otro recibe LastSuperadminError -- nunca ambos completan
    (dejaría 0 superadmins) ni ambos son rechazados. Verifica en runtime que
    el SELECT ... FOR UPDATE (no un COUNT plano) serializa la condición de
    carrera.

    Requiere Postgres real (perfil `storage`, contenedor `timescaledb`,
    puerto 5433) -- se skippea si no está disponible (ej. macOS sin Docker
    corriendo), documentado como test de infraestructura, no de lógica pura.
    """
    import os

    import asyncio

    dsn = os.environ.get(
        "TEST_DATABASE_URL", "postgresql://seismic:changeme@localhost:5433/seismic"
    )
    svc = AuthService(dsn=dsn, secret_key=SECRET, token_expire_minutes=1440)
    try:
        await svc.connect()
        async with svc._pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except Exception as exc:  # pragma: no cover - entorno sin Postgres disponible
        pytest.skip(f"Postgres real no disponible para test de concurrencia: {exc}")

    user_a = uuid4()
    user_b = uuid4()
    # Neutralizar temporalmente cualquier OTRO superadmin preexistente en la
    # base de test (ej. de una verificación manual de Phase 1) — el
    # experimento necesita EXACTAMENTE dos superadmins (user_a, user_b) para
    # que la invariante bajo prueba ("nunca 0 superadmins") sea observable;
    # con un tercero preexistente, ambos deletes serían legítimamente
    # exitosos y el test no probaría nada. Se restauran sus roles al final.
    async with svc._pool.acquire() as conn:
        other_superadmins = await conn.fetch("SELECT id, role FROM users WHERE role = 'superadmin'")
        other_superadmin_ids = [row["id"] for row in other_superadmins]
        if other_superadmin_ids:
            await conn.execute(
                "UPDATE users SET role = 'viewer' WHERE id = ANY($1::uuid[])",
                other_superadmin_ids,
            )

    try:
        async with svc._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES "
                "($1, $2, 'x', 'superadmin'), ($3, $4, 'x', 'superadmin')",
                user_a,
                f"{user_a}@concurrency-test.example.com",
                user_b,
                f"{user_b}@concurrency-test.example.com",
            )

        results = await asyncio.gather(
            svc.delete_account(user_a), svc.delete_account(user_b), return_exceptions=True
        )

        successes = [r for r in results if r is None]
        failures = [r for r in results if isinstance(r, LastSuperadminError)]
        assert len(successes) == 1
        assert len(failures) == 1
    finally:
        async with svc._pool.acquire() as conn:
            await conn.execute("DELETE FROM users WHERE id = ANY($1::uuid[])", [user_a, user_b])
            if other_superadmin_ids:
                await conn.execute(
                    "UPDATE users SET role = 'superadmin' WHERE id = ANY($1::uuid[])",
                    other_superadmin_ids,
                )
        await svc.close()


# ---------------------------------------------------------------------------
# Phase 5.1 — Flujo de 2FA de punta a punta contra Postgres real, sustituyendo
# el escaneo manual de QR con un authenticator físico (Google Authenticator /
# Authy) por la generación programática de un código TOTP válido con pyotp a
# partir del MISMO secreto embebido en el otpauth_uri devuelto por
# enable_totp() -- Google Authenticator/Authy internamente no hacen nada más
# que esto (HOTP/TOTP RFC 6238 estándar: derivar un código de 6 dígitos del
# secreto compartido + el timestamp actual), por lo que este test verifica el
# mismo contrato observable ("el código que un authenticator generaría es
# aceptado") sin depender de un dispositivo físico ni de interacción humana.
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_full_2fa_flow_with_pyotp_generated_code_equivalent_to_real_authenticator():
    """[Tarea 5.1] Sustituye la verificación manual con authenticator real:
    enable_totp() real (Postgres real) entrega un otpauth_uri; se extrae el
    secreto de ese URI (mismo dato que un authenticator real leería al
    escanear el QR, ya que el QR simplemente codifica este URI como imagen) y
    se genera un código TOTP válido con pyotp.TOTP(secret).now() -- IDÉNTICO
    al cálculo que haría Google Authenticator/Authy internamente. Ese código
    se envía a verify_totp_setup() (setup) y luego, simulando un login
    posterior con 2FA ya habilitado, a verify_totp_or_backup_code() (login
    step) -- ambos contra Postgres real, sin mocks de conexión.

    Requiere Postgres real (perfil `storage`, contenedor `timescaledb`,
    puerto 5433) -- se skippea si no está disponible, mismo criterio que
    test_delete_account_concurrent_last_two_superadmins_exactly_one_succeeds.
    """
    import os
    from urllib.parse import parse_qs, urlparse

    dsn = os.environ.get(
        "TEST_DATABASE_URL", "postgresql://seismic:changeme@localhost:5433/seismic"
    )
    svc = AuthService(dsn=dsn, secret_key=SECRET, token_expire_minutes=1440)
    try:
        await svc.connect()
        async with svc._pool.acquire() as conn:
            await conn.execute("SELECT 1")
    except Exception as exc:  # pragma: no cover - entorno sin Postgres disponible
        pytest.skip(f"Postgres real no disponible para test de flujo 2FA: {exc}")

    user_id = uuid4()
    try:
        async with svc._pool.acquire() as conn:
            await conn.execute(
                "INSERT INTO users (id, email, password_hash, role) VALUES ($1, $2, $3, 'viewer')",
                user_id,
                f"{user_id}@e2e-2fa-test.example.com",
                svc.hash_password("Sismo2026!"),
            )

        # --- Paso 1: setup (equivalente a "escanear el QR") -----------------
        otpauth_uri, backup_codes = await svc.enable_totp(user_id)
        assert len(backup_codes) == 10

        # El QR no es más que este mismo otpauth_uri codificado como imagen;
        # un authenticator real extrae el parámetro `secret` de esta URL al
        # escanearlo -- acá se hace explícitamente lo mismo por código.
        secret = parse_qs(urlparse(otpauth_uri).query)["secret"][0]

        # --- Paso 2: código generado "por el authenticator" (pyotp == RFC 6238,
        # el mismo algoritmo que corre dentro de Google Authenticator/Authy) --
        code_from_authenticator = pyotp.TOTP(secret).now()

        # --- Paso 3: verificación del setup con ese código ------------------
        await svc.verify_totp_setup(user_id, code_from_authenticator)

        async with svc._pool.acquire() as conn:
            row = await conn.fetchrow("SELECT totp_enabled FROM users WHERE id = $1", user_id)
        assert row["totp_enabled"] is True

        # --- Paso 4: login posterior de punta a punta con ese mismo TOTP ----
        # (nueva lectura del código -- el generador es determinístico por
        # ventana de tiempo, así que puede repetirse dentro de la misma
        # ventana de 30s sin problema real de reutilización en este test).
        login_code = pyotp.TOTP(secret).now()
        accepted = await svc.verify_totp_or_backup_code(user_id, login_code)
        assert accepted is True
    finally:
        async with svc._pool.acquire() as conn:
            await conn.execute("DELETE FROM users WHERE id = $1", user_id)
        await svc.close()


# =============================================================================
# Login2FAAttemptLimiter (account-settings, fix post-verify) — rate-limiting
# de POST /auth/2fa/login-verify.
#
# Fake Redis in-memory mínimo (dict + TTL simulado) en vez de un mock/testcontainer
# real: la lógica bajo prueba acá es puramente el conteo/lockout (INCR + EXPIRE +
# GET + DELETE), no el comportamiento real de Redis -- eso ya lo cubren los tests
# de integración existentes contra Redis real (tests/integration/test_redis_pubsub_bus.py).
# Reservamos testcontainers para el flujo end-to-end del endpoint, no para esta
# unidad aislada.
# =============================================================================


class _FakeRedis:
    """Suficiente para Login2FAAttemptLimiter: get/incr/expire/delete sobre un
    dict en memoria. NO simula expiración real por tiempo -- alcanza para
    verificar la lógica de conteo/lockout/reset, no el TTL en sí."""

    def __init__(self):
        self._store: dict[str, int] = {}

    async def get(self, key: str):
        value = self._store.get(key)
        return str(value) if value is not None else None

    async def incr(self, key: str) -> int:
        self._store[key] = self._store.get(key, 0) + 1
        return self._store[key]

    async def expire(self, key: str, ttl: int) -> None:
        pass  # No-op: el TTL real lo garantiza Redis, no esta unidad.

    async def delete(self, key: str) -> None:
        self._store.pop(key, None)


@pytest.mark.asyncio
async def test_totp_login_limiter_first_attempts_under_limit_are_not_locked():
    """(a) Los primeros intentos fallidos (por debajo de MAX_TOTP_LOGIN_ATTEMPTS)
    no deben bloquear -- check_not_locked() no lanza, y el caller sigue
    fallando con 401 genérico por código incorrecto (no por rate-limit)."""
    limiter = Login2FAAttemptLimiter(_FakeRedis())
    user_id = uuid4()

    for _ in range(MAX_TOTP_LOGIN_ATTEMPTS - 1):
        await limiter.check_not_locked(user_id)  # no debe lanzar
        await limiter.register_failure(user_id)

    # Aún no llegó al límite -- el intento MAX_TOTP_LOGIN_ATTEMPTS-ésimo
    # todavía debe poder evaluarse.
    await limiter.check_not_locked(user_id)


@pytest.mark.asyncio
async def test_totp_login_limiter_locks_after_max_attempts_even_with_correct_code():
    """(b) Tras superar MAX_TOTP_LOGIN_ATTEMPTS intentos fallidos, incluso un
    código CORRECTO debe ser rechazado -- check_not_locked() lanza
    TooManyTotpAttemptsError ANTES de que el caller llegue a evaluar el
    código, forzando reiniciar el login desde POST /auth/login."""
    limiter = Login2FAAttemptLimiter(_FakeRedis())
    user_id = uuid4()

    for _ in range(MAX_TOTP_LOGIN_ATTEMPTS):
        await limiter.check_not_locked(user_id)
        await limiter.register_failure(user_id)

    # El límite ya se alcanzó -- da igual que el próximo código sea válido,
    # check_not_locked() debe rechazar ANTES de intentar verificarlo.
    with pytest.raises(TooManyTotpAttemptsError):
        await limiter.check_not_locked(user_id)


@pytest.mark.asyncio
async def test_totp_login_limiter_reset_clears_lockout_for_new_login():
    """(c) reset() (invocado por un login exitoso o por un nuevo
    POST /auth/login) limpia el contador -- un usuario previamente bloqueado
    puede volver a intentar tras el reset, sin esperar el TTL."""
    limiter = Login2FAAttemptLimiter(_FakeRedis())
    user_id = uuid4()

    for _ in range(MAX_TOTP_LOGIN_ATTEMPTS):
        await limiter.check_not_locked(user_id)
        await limiter.register_failure(user_id)

    with pytest.raises(TooManyTotpAttemptsError):
        await limiter.check_not_locked(user_id)

    await limiter.reset(user_id)

    # Post-reset: el contador volvió a cero, check_not_locked() ya no lanza.
    await limiter.check_not_locked(user_id)


@pytest.mark.asyncio
async def test_totp_login_limiter_tracks_users_independently():
    """El contador es por user_id (`sub` del pre-auth token) -- los intentos
    fallidos de un usuario no afectan el presupuesto de otro."""
    limiter = Login2FAAttemptLimiter(_FakeRedis())
    user_a = uuid4()
    user_b = uuid4()

    for _ in range(MAX_TOTP_LOGIN_ATTEMPTS):
        await limiter.register_failure(user_a)

    with pytest.raises(TooManyTotpAttemptsError):
        await limiter.check_not_locked(user_a)

    # user_b nunca falló -- no debe estar bloqueado por los fallos de user_a.
    await limiter.check_not_locked(user_b)


# =============================================================================
# email-invitations, Fase 4.2 y 4.3 — CONSUMO, CONCURRENCIA y NO-LOCKOUT
# CONTRA POSTGRES REAL (fixture `db_pool` de tests/conftest.py).
#
# Todo lo de ARRIBA en este archivo usa fakes de asyncpg. Esta sección NO, y
# es deliberado: el consumo single-use de una invitación es un invariante de
# CONCURRENCIA — "dos registros simultáneos con el mismo token y sólo uno
# gana" no se puede afirmar contra un AsyncMock, que no serializa nada y
# devolvería la misma fila a las dos corrutinas. Es la lección documentada del
# proyecto (dos bugs de SQL pasaron con mocks en verde) aplicada al caso donde
# más importa: el gate que decide quién entra al sistema.
# =============================================================================

import asyncio  # noqa: E402
import hashlib as _hashlib  # noqa: E402

from src.services.invitation_service import (  # noqa: E402
    InvitationService,
    insert_invitation_row,
)


@pytest.fixture
def db_service(db_pool):
    """AuthService con el pool REAL inyectado (patrón `pool=` de AOI-1: el
    servicio no es dueño del pool, lo cierra el fixture)."""
    return AuthService(
        dsn="postgresql://unused",
        secret_key=SECRET,
        token_expire_minutes=1440,
        pool=db_pool,
    )


async def _seed_user(db_pool, email: str, role: UserRole = UserRole.ADMIN):
    """Fila real en `users` — necesaria para que la tabla no esté vacía (si no,
    todo registro caería en la rama bootstrap y el gate de invitación ni
    correría) y para poder usarla como `invited_by` (FK real)."""
    async with db_pool.acquire() as conn:
        return await conn.fetchrow(
            "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) "
            "RETURNING id, email, role",
            email,
            "$2b$12$hash-irrelevante",
            role.value,
        )


async def _seed_invitation(db_pool, email: str, role: UserRole, invited_by=None):
    """Invitación real usando el MISMO helper que usa producción
    (insert_invitation_row) — así el test no puede divergir de cómo nace una
    invitación de verdad. Devuelve (id, token en claro)."""
    async with db_pool.acquire() as conn:
        async with conn.transaction():
            row, token = await insert_invitation_row(
                conn, email=email, role=role, invited_by=invited_by, expire_days=7
            )
    return row["id"], token


# --- 4.2 Consumo por token (camino password) --------------------------------


async def test_db_register_with_valid_token_inherits_invited_role(db_service, db_pool):
    """[Requirement: Consumo single-use / Scenario: Registro exitoso con
    invitación hereda el rol invitado] — el rol sale de la INVITACIÓN, no del
    payload ni del viewer de bootstrap."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "invitada@example.com", UserRole.MODERADOR, admin["id"]
    )

    user = await db_service.create_user(
        email="invitada@example.com",
        password="Sismo2026!",
        role=UserRole.VIEWER,
        invitation_token=token,
    )

    assert user.role is UserRole.MODERADOR
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by FROM invitations WHERE id = $1", invitation_id
        )
    assert row["accepted_at"] is not None
    assert row["accepted_by"] == user.id


async def test_db_register_payload_role_cannot_override_invitation_role(db_service, db_pool):
    """[Scenario: El payload no puede pisar el rol] — se pide superadmin y se
    obtiene el viewer de la invitación."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    _, token = await _seed_invitation(db_pool, "humilde@example.com", UserRole.VIEWER, admin["id"])

    user = await db_service.create_user(
        email="humilde@example.com",
        password="Sismo2026!",
        role=UserRole.SUPERADMIN,
        invitation_token=token,
    )

    assert user.role is UserRole.VIEWER


async def test_db_register_without_token_raises_invitation_required(db_service, db_pool):
    """Tabla no vacía y sin token: rechazo, y NINGÚN usuario creado."""
    await _seed_user(db_pool, "existente@example.com", UserRole.ADMIN)

    with pytest.raises(InvitationRequiredError):
        await db_service.create_user(
            email="colada@example.com", password="Sismo2026!", role=UserRole.VIEWER
        )

    async with db_pool.acquire() as conn:
        exists = await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE email = 'colada@example.com'"
        )
    assert exists == 0


async def test_db_register_with_unknown_token_raises_invalid_invitation(db_service, db_pool):
    await _seed_user(db_pool, "existente@example.com", UserRole.ADMIN)

    with pytest.raises(InvalidInvitationError):
        await db_service.create_user(
            email="colada@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token="token-inexistente",
        )


async def test_db_register_with_expired_token_raises_invalid_invitation(db_service, db_pool):
    """Una invitación vencida no sirve — el predicado `expires_at > now()` se
    evalúa con el reloj de Postgres, no con el de Python."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "tarde@example.com", UserRole.VIEWER, admin["id"]
    )
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1",
            invitation_id,
        )

    with pytest.raises(InvalidInvitationError):
        await db_service.create_user(
            email="tarde@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        )


async def test_db_register_with_email_mismatch_does_not_burn_the_invitation(db_service, db_pool):
    """[Scenario: Registro rechazado si el email no coincide] — el mismatch se
    detecta DESPUÉS del UPDATE de consumo, pero el rollback de la transacción
    lo revierte: la invitación sigue pendiente y el invitado real puede usarla.

    Este es el caso estrella de "por qué base real": con un mock, el UPDATE de
    consumo nunca se deshace porque nunca ocurrió — el test pasaría igual con
    una implementación que SÍ quema la invitación."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "duenia@example.com", UserRole.ADMIN, admin["id"]
    )

    with pytest.raises(InvitationEmailMismatchError):
        await db_service.create_user(
            email="usurpador@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        )

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by FROM invitations WHERE id = $1", invitation_id
        )
    assert row["accepted_at"] is None, "la invitación quedó quemada por un intento ajeno"
    assert row["accepted_by"] is None

    # Y el invitado real todavía puede usarla.
    user = await db_service.create_user(
        email="duenia@example.com",
        password="Sismo2026!",
        role=UserRole.VIEWER,
        invitation_token=token,
    )
    assert user.role is UserRole.ADMIN


async def test_db_register_email_match_is_case_insensitive(db_service, db_pool):
    """La invitación es a UNA persona identificada por su email; la caja de las
    letras no debe cambiar eso."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    _, token = await _seed_invitation(
        db_pool, "MayUsculas@Example.com", UserRole.MODERADOR, admin["id"]
    )

    user = await db_service.create_user(
        email="mayusculas@example.com",
        password="Sismo2026!",
        role=UserRole.VIEWER,
        invitation_token=token,
    )

    assert user.role is UserRole.MODERADOR


async def test_db_bootstrap_without_token_is_preserved(db_service, db_pool):
    """[Scenario: No-lockout (3) bootstrap] — con `users` VACÍA el registro sin
    token sigue funcionando y crea un superadmin. Es la válvula de escape de
    dev/staging/DR: sin ella, una base recién creada quedaría sin forma de
    entrar (nadie puede invitar porque no hay nadie)."""
    async with db_pool.acquire() as conn:
        assert await conn.fetchval("SELECT COUNT(*) FROM users") == 0

    user = await db_service.create_user(
        email="primero@example.com", password="Sismo2026!", role=UserRole.VIEWER
    )

    assert user.role is UserRole.SUPERADMIN


async def test_db_failure_after_consumption_rolls_back_the_invitation(db_service, db_pool):
    """[Scenario: Fallo posterior en la transacción no quema la invitación] —
    se fuerza el fallo con un email ya registrado (UniqueViolation en el INSERT
    de `users`, DESPUÉS del UPDATE de consumo). La atomicidad debe dejar la
    invitación intacta."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    # El email de la invitación YA tiene cuenta: el UPDATE de consumo matchea
    # (es por token) pero el INSERT de users viola el UNIQUE de email.
    await _seed_user(db_pool, "colision@example.com", UserRole.VIEWER)
    invitation_id, token = await _seed_invitation(
        db_pool, "colision@example.com", UserRole.ADMIN, admin["id"]
    )

    with pytest.raises(EmailAlreadyRegisteredError):
        await db_service.create_user(
            email="colision@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        )

    async with db_pool.acquire() as conn:
        accepted_at = await conn.fetchval(
            "SELECT accepted_at FROM invitations WHERE id = $1", invitation_id
        )
    assert accepted_at is None, "el rollback no revirtió el consumo de la invitación"


# --- 4.2 CONCURRENCIA -------------------------------------------------------


async def test_db_two_concurrent_registers_with_same_token_exactly_one_wins(db_service, db_pool):
    """[Scenario: Dos registros concurrentes — solo uno gana] — EL test que
    justifica toda esta sección.

    Dos `create_user()` en paralelo con el MISMO token: el `UPDATE ... WHERE
    accepted_at IS NULL ... RETURNING` serializa sobre la fila (la segunda
    transacción espera el lock y, al reevaluar el predicado tras el commit de
    la primera, no matchea nada y recibe None). Resultado exigido: un solo
    usuario creado, una sola aceptación.

    Con mocks esto es inverificable: dos AsyncMock devuelven la misma fila a
    ambas corrutinas y el test pasaría con una implementación que crea DOS
    usuarios con el mismo token."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "disputada@example.com", UserRole.ADMIN, admin["id"]
    )

    results = await asyncio.gather(
        db_service.create_user(
            email="disputada@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        ),
        db_service.create_user(
            email="disputada@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        ),
        return_exceptions=True,
    )

    winners = [r for r in results if not isinstance(r, Exception)]
    losers = [r for r in results if isinstance(r, Exception)]
    assert len(winners) == 1, f"esperaba exactamente un ganador, hubo {len(winners)}"
    # El perdedor falla por invitación no consumible o por email duplicado —
    # ambas son rechazos legítimos; lo inaceptable sería que ganaran los dos.
    assert isinstance(losers[0], (InvalidInvitationError, EmailAlreadyRegisteredError))

    async with db_pool.acquire() as conn:
        user_count = await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE email = 'disputada@example.com'"
        )
        accepted_by = await conn.fetchval(
            "SELECT accepted_by FROM invitations WHERE id = $1", invitation_id
        )
    assert user_count == 1, "se crearon dos usuarios con la misma invitación"
    assert accepted_by == winners[0].id


async def test_db_password_and_google_in_parallel_create_exactly_one_account(db_service, db_pool):
    """[Scenario: Aceptación por password y por Google en paralelo] — la misma
    invitación atacada por los DOS caminos de consumo a la vez (por token y por
    email).

    El invariante que importa —y que se verifica acá— es: UNA sola cuenta y UNA
    sola aceptación de la invitación. NO se exige que uno de los dos calls
    falle: verificado contra la base real, el orden habitual es que el camino
    password consuma la invitación y commitee, y el de Google caiga entonces en
    la rama de AUTO-LINK (la cuenta ya existe con password y sin google_id), que
    por contrato NO toca `invitations` y devuelve la MISMA fila con el google_id
    seteado. Dos "éxitos" que resuelven a la misma identidad es el
    comportamiento correcto, no un doble consumo.

    Asserts sobre la BASE, no sobre los valores de retorno: es la única forma de
    distinguir "auto-link sobre la misma fila" de "dos cuentas creadas" — y un
    mock no puede contestar ninguna de las dos."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "ambos@example.com", UserRole.MODERADOR, admin["id"]
    )

    results = await asyncio.gather(
        db_service.create_user(
            email="ambos@example.com",
            password="Sismo2026!",
            role=UserRole.VIEWER,
            invitation_token=token,
        ),
        db_service.resolve_or_create_google_user(
            google_id="google-sub-carrera", email="ambos@example.com"
        ),
        return_exceptions=True,
    )

    winners = [r for r in results if not isinstance(r, Exception)]
    assert winners, f"ningún camino prosperó: {results}"
    # Todos los que prosperaron resuelven a la MISMA identidad.
    assert len({w.id for w in winners}) == 1
    assert all(w.role is UserRole.MODERADOR for w in winners)

    async with db_pool.acquire() as conn:
        user_count = await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE lower(email) = 'ambos@example.com'"
        )
        accepted_by = await conn.fetchval(
            "SELECT accepted_by FROM invitations WHERE id = $1 AND accepted_at IS NOT NULL",
            invitation_id,
        )
        total_accepted = await conn.fetchval(
            "SELECT COUNT(*) FROM invitations WHERE accepted_at IS NOT NULL"
        )
    assert user_count == 1, "los dos caminos crearon cuentas separadas"
    assert total_accepted == 1, "la invitación se consumió más de una vez"
    assert accepted_by == winners[0].id


# --- 4.3 Regresión de NO-LOCKOUT (Google) -----------------------------------


async def test_db_google_already_linked_user_never_touches_invitations(db_service, db_pool):
    """[Scenario: No-lockout (2)] — un usuario YA vinculado por google_id entra
    igual que siempre, y la invitación pendiente que exista para su email queda
    INTACTA (la rama 1 se evalúa primero y no toca `invitations`).

    "No ejecuta ninguna query sobre invitations" se verifica por su efecto
    observable —la invitación sigue pendiente y sin accepted_by— que es lo que
    de verdad importa: si la rama tocara la tabla, la quemaría."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    async with db_pool.acquire() as conn:
        existing = await conn.fetchrow(
            "INSERT INTO users (email, password_hash, role, google_id) "
            "VALUES ($1, NULL, $2, $3) RETURNING id",
            "vinculado@example.com",
            UserRole.ADMIN.value,
            "google-sub-ya-vinculado",
        )
    # Invitación pendiente para el MISMO email — trampa deliberada.
    invitation_id, _ = await _seed_invitation(
        db_pool, "vinculado@example.com", UserRole.VIEWER, admin["id"]
    )

    user = await db_service.resolve_or_create_google_user(
        google_id="google-sub-ya-vinculado", email="vinculado@example.com"
    )

    assert user.id == existing["id"]
    assert user.role is UserRole.ADMIN, "el login existente perdió su rol"
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by FROM invitations WHERE id = $1", invitation_id
        )
    assert row["accepted_at"] is None, "la rama 'ya vinculado' consumió una invitación"
    assert row["accepted_by"] is None


async def test_db_google_auto_link_never_touches_invitations(db_service, db_pool):
    """[Scenario: No-lockout (2), mitad auto-link] — un usuario de password que
    entra por primera vez con Google se auto-vincula SIN consumir invitación y
    conservando su rol. Existencia de cuenta PRIMERO, invitación después."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    existing = await _seed_user(db_pool, "conpassword@example.com", UserRole.MODERADOR)
    invitation_id, _ = await _seed_invitation(
        db_pool, "conpassword@example.com", UserRole.VIEWER, admin["id"]
    )

    user = await db_service.resolve_or_create_google_user(
        google_id="google-sub-autolink", email="conpassword@example.com"
    )

    assert user.id == existing["id"], "se creó una fila nueva en vez de auto-linkear"
    assert user.role is UserRole.MODERADOR, "el auto-link degradó el rol al de la invitación"
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by FROM invitations WHERE id = $1", invitation_id
        )
        google_id = await conn.fetchval("SELECT google_id FROM users WHERE id = $1", existing["id"])
    assert row["accepted_at"] is None, "la rama auto-link consumió una invitación"
    assert google_id == "google-sub-autolink"


async def test_db_google_new_user_with_invitation_inherits_role_case_insensitive(
    db_service, db_pool
):
    """[MODIFIED: Google con invitación pendiente crea la cuenta con el rol
    invitado] — consumo por EMAIL (sin token, Decision 5) y con match
    case-insensitive: la invitación es a `INVITADA@Example.com` y Google
    entrega `invitada@example.com`."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, _ = await _seed_invitation(
        db_pool, "INVITADA@Example.com", UserRole.ADMIN, admin["id"]
    )

    user = await db_service.resolve_or_create_google_user(
        google_id="google-sub-nueva", email="invitada@example.com"
    )

    assert user.role is UserRole.ADMIN
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by FROM invitations WHERE id = $1", invitation_id
        )
    assert row["accepted_at"] is not None
    assert row["accepted_by"] == user.id


async def test_db_google_new_user_without_invitation_is_rejected(db_service, db_pool):
    """[MODIFIED: Google sin invitación es rechazado] — el agujero de
    auto-provisioning que motivó todo el change: cualquier cuenta de Google
    entraba como viewer. Ahora no se crea NADA."""
    await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)

    with pytest.raises(InvitationRequiredError):
        await db_service.resolve_or_create_google_user(
            google_id="google-sub-desconocida", email="cualquiera@example.com"
        )

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE email = 'cualquiera@example.com'"
        )
    assert count == 0


async def test_db_google_new_user_with_expired_invitation_is_rejected(db_service, db_pool):
    """[MODIFIED: Google con invitación expirada es rechazado] — una invitación
    vencida no alcanza para entrar."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, _ = await _seed_invitation(
        db_pool, "vencida@example.com", UserRole.ADMIN, admin["id"]
    )
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1",
            invitation_id,
        )

    with pytest.raises(InvitationRequiredError):
        await db_service.resolve_or_create_google_user(
            google_id="google-sub-vencida", email="vencida@example.com"
        )


async def test_db_google_bootstrap_on_empty_table_still_works(db_service, db_pool):
    """[Scenario: No-lockout (4)] — con `users` vacía, el primer login de
    Google sigue creando el superadmin sin invitación."""
    user = await db_service.resolve_or_create_google_user(
        google_id="google-sub-primero", email="primero@example.com"
    )

    assert user.role is UserRole.SUPERADMIN


# --- onboarding contra base real (Decision 6) -------------------------------


async def test_db_new_user_has_null_onboarding_and_complete_is_idempotent(db_service, db_pool):
    """[Scenario: Completar onboarding persiste y es idempotente] — un usuario
    nuevo nace con onboarding pendiente (NULL) y la SEGUNDA llamada a
    complete_onboarding() no pisa el timestamp de la primera (el predicado
    `AND onboarding_completed_at IS NULL` del UPDATE es lo que lo garantiza;
    un mock de execute() no distinguiría)."""
    user = await _seed_user(db_pool, "onboarding@example.com", UserRole.VIEWER)

    assert await db_service.get_onboarding_status(user["id"]) is None

    await db_service.complete_onboarding(user["id"])
    first = await db_service.get_onboarding_status(user["id"])
    assert first is not None

    await db_service.complete_onboarding(user["id"])
    second = await db_service.get_onboarding_status(user["id"])
    assert second == first, "la segunda llamada pisó el timestamp original"


async def test_db_consume_pending_invitation_hashes_the_token_it_receives(db_pool):
    """La primitiva de consumo busca por sha256 del token, nunca por el claro:
    se inserta una invitación y se confirma que el hash de la base es el del
    token con el que el consumo matchea."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    invitation_id, token = await _seed_invitation(
        db_pool, "hash@example.com", UserRole.VIEWER, admin["id"]
    )

    async with db_pool.acquire() as conn:
        stored_hash = await conn.fetchval(
            "SELECT token_hash FROM invitations WHERE id = $1", invitation_id
        )
        async with conn.transaction():
            consumed = await AuthService._consume_pending_invitation(conn, token=token)

    assert stored_hash == _hashlib.sha256(token.encode()).hexdigest()
    assert consumed is not None
    assert consumed["id"] == invitation_id


# --- Riesgo anotado en Fase 2: approve de beta vs create de admin -----------


async def test_db_insert_invitation_row_serializes_concurrent_callers(db_pool):
    """REGRESIÓN del gap cerrado tras la Fase 4.

    El agujero original: `insert_invitation_row()` no tomaba el advisory lock
    (lo tomaba solo `create_invitation()` justo antes de llamarlo), así que el
    approve de beta-signups — que usa el helper dentro de SU transacción, la
    del FOR UPDATE sobre beta_signups — podía correr en paralelo con un create
    de admin: ambos veían "no hay pendiente" e insertaban, dejando DOS
    invitaciones vigentes para el mismo email.

    El lock se movió ADENTRO del helper, que es la única puerta por la que
    nace una invitación. Este test verifica la serialización: la segunda
    transacción no puede insertar hasta que la primera commitea, así que su
    chequeo de pendiente (hecho DESPUÉS de tomar el lock, como en el approve
    corregido) ya ve la fila de la primera y no duplica."""
    admin = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    email = "beta@example.com"

    async def approve_path(delay: float) -> bool:
        """Emula el approve de main.py: lock → chequeo de pendiente → insert."""
        await asyncio.sleep(delay)
        async with db_pool.acquire() as conn:
            async with conn.transaction():
                await conn.execute("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", email)
                pending = await conn.fetchval(
                    f"SELECT id FROM invitations WHERE lower(email) = lower($1) "
                    f"AND {PENDING_PREDICATE_SQL}",
                    email,
                )
                if pending is not None:
                    return False
                await insert_invitation_row(
                    conn,
                    email=email,
                    role=UserRole.VIEWER,
                    invited_by=admin["id"],
                    expire_days=7,
                )
                return True

    inserted = await asyncio.gather(approve_path(0), approve_path(0))

    async with db_pool.acquire() as conn:
        pending_count = await conn.fetchval(
            f"SELECT COUNT(*) FROM invitations WHERE lower(email) = lower($1) "
            f"AND {PENDING_PREDICATE_SQL}",
            email,
        )
    # Exactamente un camino inserta; el otro encuentra la pendiente ya vigente.
    assert sum(inserted) == 1
    assert pending_count == 1


async def test_db_create_invitation_serializes_concurrent_creates(db_pool):
    """El otro camino de creación, `create_invitation()`, bajo la misma
    carrera: exactamente una pendiente. Junto al test anterior cubre las dos
    puertas de entrada — el lock ahora vive en el helper compartido, y
    tomarlo de nuevo acá es inocuo (es reentrante por transacción)."""
    admin_row = await _seed_user(db_pool, "admin@example.com", UserRole.ADMIN)
    admin = CurrentUser(id=admin_row["id"], email=admin_row["email"], role=UserRole.ADMIN)
    service = InvitationService(pool=db_pool, expire_days=7)

    results = await asyncio.gather(
        service.create_invitation(
            email="protegido@example.com", role=UserRole.VIEWER, invited_by=admin
        ),
        service.create_invitation(
            email="protegido@example.com", role=UserRole.VIEWER, invited_by=admin
        ),
        return_exceptions=True,
    )

    ok = [r for r in results if not isinstance(r, Exception)]
    assert len(ok) == 1
    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            f"SELECT COUNT(*) FROM invitations WHERE lower(email) = 'protegido@example.com' "
            f"AND {PENDING_PREDICATE_SQL}"
        )
    assert count == 1
