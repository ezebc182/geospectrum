"""Tests de desactivación/reactivación de cuentas CONTRA POSTGRES REAL
(user-management, tarea 1.16).

Por qué base real y no mocks: es la lección documentada del proyecto — los
mocks de asyncpg validan que se llame al pool, no que la query corra. Acá se
ejercita justamente lo que un mock no puede contestar: que la columna
`deactivated_at` de la migración 012 exista, que el `SELECT ... FOR UPDATE`
serialice dos desactivaciones concurrentes, que `now()` se escriba de verdad y
que el timestamp original NO se pise en la segunda desactivación.

Harness: fixtures `db_pool` de tests/conftest.py (Postgres 16 vía
testcontainers, migraciones 001-012 aplicadas por glob alfabético).
asyncio_mode=auto, así que no hace falta marcar cada test.
"""

import asyncio
from uuid import uuid4

import pytest

from src.models.user import CurrentUser, UserRole
from src.services.auth_service import (
    AccountDeactivatedError,
    AuthService,
    CannotManageHigherOrEqualRoleError,
    CannotManageSelfError,
    InvitationRequiredError,
    UserAlreadyDeactivatedError,
    UserNotDeactivatedError,
    UserNotFoundError,
)

SECRET = "test-secret-irrelevante-para-estos-tests"


@pytest.fixture
def service(db_pool):
    """AuthService sobre el pool PRESTADO del fixture: `_owns_pool=False`, así
    que close() es no-op y el fixture sigue siendo el dueño del ciclo de vida.
    """
    return AuthService(
        dsn="postgresql://unused",
        secret_key=SECRET,
        token_expire_minutes=1440,
        pool=db_pool,
    )


async def _make_user(
    db_pool,
    email: str,
    role: UserRole,
    *,
    with_password: bool = True,
    google_id: str | None = None,
) -> CurrentUser:
    """Crea una fila real en `users` y devuelve su CurrentUser."""
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO users (email, password_hash, role, google_id) "
            "VALUES ($1, $2, $3, $4) RETURNING id, email, role",
            email,
            "$2b$12$hash-irrelevante-para-estos-tests" if with_password else None,
            role.value,
            google_id,
        )
    return CurrentUser(id=row["id"], email=row["email"], role=UserRole(row["role"]))


async def _deactivated_at(db_pool, user_id):
    async with db_pool.acquire() as conn:
        return await conn.fetchval("SELECT deactivated_at FROM users WHERE id = $1", user_id)


async def _column(db_pool, user_id, column: str):
    async with db_pool.acquire() as conn:
        return await conn.fetchval(f"SELECT {column} FROM users WHERE id = $1", user_id)


@pytest.fixture
async def superadmin(db_pool):
    return await _make_user(db_pool, "superadmin@example.com", UserRole.SUPERADMIN)


@pytest.fixture
async def admin(db_pool):
    return await _make_user(db_pool, "admin@example.com", UserRole.ADMIN)


@pytest.fixture
async def viewer(db_pool):
    return await _make_user(db_pool, "viewer@example.com", UserRole.VIEWER)


# ---------------------------------------------------------------------------
# Transiciones de estado
# ---------------------------------------------------------------------------


async def test_deactivate_sets_timestamp_and_leaves_the_rest_of_the_row_intact(
    service, db_pool, admin, viewer
):
    """[Scenario: Desactivar una cuenta activa] Es un SOFT-delete: la única
    columna que cambia es `deactivated_at`."""
    before = {
        column: await _column(db_pool, viewer.id, column)
        for column in ("email", "role", "password_hash", "google_id", "created_at")
    }

    await service.deactivate_user(admin, viewer.id)

    assert await _deactivated_at(db_pool, viewer.id) is not None
    for column, value in before.items():
        assert await _column(db_pool, viewer.id, column) == value


async def test_reactivate_returns_the_timestamp_to_null(service, db_pool, admin, viewer):
    """[Requirement: Reactivación de cuenta] El estado vuelve a ser
    indistinguible del original."""
    await service.deactivate_user(admin, viewer.id)
    assert await _deactivated_at(db_pool, viewer.id) is not None

    await service.reactivate_user(admin, viewer.id)

    assert await _deactivated_at(db_pool, viewer.id) is None


async def test_double_deactivate_is_rejected_and_preserves_the_original_timestamp(
    service, db_pool, admin, viewer
):
    """[Scenario: Desactivar una cuenta ya desactivada es rechazado
    explícitamente] Rechazo explícito, no un no-op engañoso — y el timestamp
    de la PRIMERA desactivación no se pisa con un now() nuevo."""
    await service.deactivate_user(admin, viewer.id)
    original = await _deactivated_at(db_pool, viewer.id)

    with pytest.raises(UserAlreadyDeactivatedError):
        await service.deactivate_user(admin, viewer.id)

    assert await _deactivated_at(db_pool, viewer.id) == original


async def test_reactivate_an_active_account_is_rejected(service, admin, viewer):
    """[Scenario: Reactivar una cuenta activa] Simetría con el 409 de
    desactivar dos veces."""
    with pytest.raises(UserNotDeactivatedError):
        await service.reactivate_user(admin, viewer.id)


async def test_deactivate_unknown_user_raises_not_found(service, admin):
    """[Scenario: Desactivar un usuario inexistente]"""
    with pytest.raises(UserNotFoundError):
        await service.deactivate_user(admin, uuid4())


async def test_reactivate_unknown_user_raises_not_found(service, admin):
    with pytest.raises(UserNotFoundError):
        await service.reactivate_user(admin, uuid4())


# ---------------------------------------------------------------------------
# Guards de jerarquía y de auto-desactivación
# ---------------------------------------------------------------------------


async def test_nobody_can_deactivate_themselves_not_even_a_superadmin(service, db_pool, superadmin):
    """[Scenario: Nadie puede desactivarse a sí mismo] El superadmin es el rol
    más alto: ningún guard de jerarquía lo frena, y aun así el guard de self
    lo rechaza. La cuenta sigue activa."""
    with pytest.raises(CannotManageSelfError):
        await service.deactivate_user(superadmin, superadmin.id)

    assert await _deactivated_at(db_pool, superadmin.id) is None


async def test_self_guard_runs_before_the_not_found_guard(service, admin):
    """El orden importa (design.md Decision 6): un actor autenticado SIEMPRE
    existe, así que si el id coincide con el suyo la causa real es "te estás
    desactivando a vos mismo", nunca "no existe"."""
    with pytest.raises(CannotManageSelfError):
        await service.deactivate_user(admin, admin.id)


async def test_admin_cannot_deactivate_another_admin(service, db_pool, admin):
    """[Scenario: Un admin no puede desactivar a otro admin ni a un
    superadmin] Nivel IGUAL también está prohibido: la comparación es
    estricta."""
    other_admin = await _make_user(db_pool, "otro-admin@example.com", UserRole.ADMIN)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.deactivate_user(admin, other_admin.id)

    assert await _deactivated_at(db_pool, other_admin.id) is None


async def test_admin_cannot_deactivate_a_superadmin(service, db_pool, admin, superadmin):
    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.deactivate_user(admin, superadmin.id)

    assert await _deactivated_at(db_pool, superadmin.id) is None


async def test_superadmin_can_deactivate_an_admin(service, db_pool, superadmin, admin):
    """[Scenario: Un superadmin puede desactivar a un admin] Nivel
    estrictamente menor: pasa."""
    await service.deactivate_user(superadmin, admin.id)

    assert await _deactivated_at(db_pool, admin.id) is not None


async def test_reactivate_applies_the_same_hierarchy_guard(service, db_pool, admin, superadmin):
    """Reactivar no es una puerta trasera: los mismos guards que desactivar."""
    async with db_pool.acquire() as conn:
        await conn.execute("UPDATE users SET deactivated_at = now() WHERE id = $1", superadmin.id)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.reactivate_user(admin, superadmin.id)

    assert await _deactivated_at(db_pool, superadmin.id) is not None


async def test_hierarchy_guard_runs_before_the_state_guard(service, db_pool, admin):
    """Un admin no puede saber, por la respuesta, si otro admin está
    desactivado o no: el 403 de jerarquía se evalúa ANTES que el 409 de
    estado."""
    other_admin = await _make_user(db_pool, "admin-desactivado@example.com", UserRole.ADMIN)
    async with db_pool.acquire() as conn:
        await conn.execute("UPDATE users SET deactivated_at = now() WHERE id = $1", other_admin.id)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.deactivate_user(admin, other_admin.id)


# ---------------------------------------------------------------------------
# Contrato de NO-LOCKOUT: es imposible dejar el sistema sin superadmin activo
# ---------------------------------------------------------------------------


async def test_a_superadmin_is_unreachable_by_every_actor(service, db_pool, superadmin):
    """El contrato de no-lockout, verificado por construcción: NINGÚN rol
    puede desactivar a un superadmin.

    - viewer/moderador/admin: nivel menor -> guard de jerarquía (403).
    - otro superadmin: nivel IGUAL -> también guard de jerarquía (403).
    - él mismo: guard de self (409).

    Como nadie puede desactivar a un superadmin, el sistema NUNCA puede
    quedarse sin superadmin activo, y el guard de "último superadmin" que sí
    hace falta en delete_account() acá es innecesario por construcción."""
    actors = [
        await _make_user(db_pool, "v@example.com", UserRole.VIEWER),
        await _make_user(db_pool, "m@example.com", UserRole.MODERADOR),
        await _make_user(db_pool, "a@example.com", UserRole.ADMIN),
        await _make_user(db_pool, "s2@example.com", UserRole.SUPERADMIN),
    ]

    for actor in actors:
        with pytest.raises(CannotManageHigherOrEqualRoleError):
            await service.deactivate_user(actor, superadmin.id)

    with pytest.raises(CannotManageSelfError):
        await service.deactivate_user(superadmin, superadmin.id)

    assert await _deactivated_at(db_pool, superadmin.id) is None


async def test_the_only_superadmin_survives_a_full_deactivation_sweep(service, db_pool, superadmin):
    """Versión "ataque": un superadmin comprometido intenta desactivar a TODO
    el mundo. Puede voltear a los de nivel menor, pero no a sí mismo — el
    sistema conserva al menos un superadmin activo."""
    victims = [
        await _make_user(db_pool, "v1@example.com", UserRole.VIEWER),
        await _make_user(db_pool, "m1@example.com", UserRole.MODERADOR),
        await _make_user(db_pool, "a1@example.com", UserRole.ADMIN),
    ]
    for victim in victims:
        await service.deactivate_user(superadmin, victim.id)

    with pytest.raises(CannotManageSelfError):
        await service.deactivate_user(superadmin, superadmin.id)

    async with db_pool.acquire() as conn:
        active_superadmins = await conn.fetchval(
            "SELECT COUNT(*) FROM users WHERE role = 'superadmin' AND deactivated_at IS NULL"
        )
    assert active_superadmins >= 1


# ---------------------------------------------------------------------------
# Concurrencia: el SELECT ... FOR UPDATE serializa dos desactivaciones
# ---------------------------------------------------------------------------


async def test_two_concurrent_deactivations_leave_exactly_one_winner(
    service, db_pool, superadmin, admin, viewer
):
    """Dos admins desactivan al MISMO usuario a la vez. El `FOR UPDATE` sobre
    la fila objetivo serializa las transacciones: la segunda ve el timestamp
    que escribió la primera y sale con UserAlreadyDeactivatedError, en vez de
    pisarlo. Un mock de asyncpg jamás detectaría esto."""
    results = await asyncio.gather(
        service.deactivate_user(admin, viewer.id),
        service.deactivate_user(superadmin, viewer.id),
        return_exceptions=True,
    )

    failures = [r for r in results if isinstance(r, Exception)]
    successes = [r for r in results if not isinstance(r, Exception)]
    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], UserAlreadyDeactivatedError)
    assert await _deactivated_at(db_pool, viewer.id) is not None


# ---------------------------------------------------------------------------
# is_user_active
# ---------------------------------------------------------------------------


async def test_is_user_active_true_for_an_active_account(service, viewer):
    assert await service.is_user_active(viewer.id) is True


async def test_is_user_active_false_for_a_deactivated_account(service, admin, viewer):
    await service.deactivate_user(admin, viewer.id)

    assert await service.is_user_active(viewer.id) is False


async def test_is_user_active_false_for_a_nonexistent_row(service):
    """[Scenario: JWT válido de una cuenta borrada también muere] Fila
    inexistente NO es un error: es False, que produce el mismo 401 genérico."""
    assert await service.is_user_active(uuid4()) is False


async def test_is_user_active_true_again_after_reactivation(service, admin, viewer):
    await service.deactivate_user(admin, viewer.id)
    await service.reactivate_user(admin, viewer.id)

    assert await service.is_user_active(viewer.id) is True


# ---------------------------------------------------------------------------
# role-management (tarea 2.5) — get_user_auth_state(): estado + ROL en una
# sola query, contra Postgres real.
#
# Los cuatro tests de is_user_active de arriba son ADEMÁS la no-regresión de
# la reimplementación: ese método ahora delega en éste y sigue devolviendo
# exactamente lo mismo en los cuatro casos.
# ---------------------------------------------------------------------------


async def test_get_user_auth_state_returns_active_and_the_real_role(service, viewer):
    """[Requirement: El rol efectivo se revalida contra la base en cada
    request] Cuenta activa: `is_active=True` y el rol que dice la fila."""
    state = await service.get_user_auth_state(viewer.id)

    assert state.is_active is True
    assert state.role is UserRole.VIEWER


@pytest.mark.parametrize(
    "role",
    [UserRole.SUPERADMIN, UserRole.ADMIN, UserRole.MODERADOR, UserRole.VIEWER],
)
async def test_get_user_auth_state_reads_every_role_from_the_row(service, db_pool, role):
    """El rol sale de la BASE, sin defaults ni traducciones: los cuatro
    valores del enum viajan de ida y vuelta."""
    user = await _make_user(db_pool, f"state-{role.value}@example.com", role)

    state = await service.get_user_auth_state(user.id)

    assert state.role is role


async def test_get_user_auth_state_keeps_the_role_on_a_deactivated_account(service, admin, viewer):
    """Una cuenta desactivada sigue teniendo rol: `is_active=False` pero el rol
    IGUAL presente. `role=None` significa "la fila no existe" y NADA más — si
    acá viniera None, el contrato del tipo estaría mintiendo."""
    await service.deactivate_user(admin, viewer.id)

    state = await service.get_user_auth_state(viewer.id)

    assert state.is_active is False
    assert state.role is UserRole.VIEWER


async def test_get_user_auth_state_returns_false_and_none_for_a_nonexistent_row(service):
    """[AC 2.2] Fila inexistente ⇒ `UserAuthState(is_active=False, role=None)`.
    No es un error y no hay rol de relleno: un `UserRole.VIEWER` acá sería un
    rol REAL inventado por el lector para una cuenta que no existe."""
    state = await service.get_user_auth_state(uuid4())

    assert state.is_active is False
    assert state.role is None


async def test_get_user_auth_state_is_frozen(service, viewer):
    """`frozen=True`: nadie muta el estado de autorización en el camino
    caliente."""
    state = await service.get_user_auth_state(viewer.id)

    with pytest.raises(Exception):
        state.role = UserRole.SUPERADMIN  # type: ignore[misc]


async def test_change_of_role_in_the_database_is_visible_immediately(service, db_pool, viewer):
    """El lector NO cachea: un UPDATE del rol se ve en la lectura siguiente.
    Es la base de que un cambio de rol sea efectivo en el request siguiente y
    no a las 24 h de vida del token."""
    assert (await service.get_user_auth_state(viewer.id)).role is UserRole.VIEWER

    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE users SET role = $2 WHERE id = $1", viewer.id, UserRole.MODERADOR.value
        )

    assert (await service.get_user_auth_state(viewer.id)).role is UserRole.MODERADOR


async def test_is_user_active_agrees_with_get_user_auth_state(service, admin, viewer):
    """No-regresión de la reimplementación: `is_user_active()` y el
    `is_active` del método nuevo no pueden divergir, porque el primero delega
    en el segundo. Se afirma en los tres estados posibles."""
    missing_id = uuid4()

    for user_id in (viewer.id, missing_id):
        assert (
            await service.is_user_active(user_id)
            == (await service.get_user_auth_state(user_id)).is_active
        )

    await service.deactivate_user(admin, viewer.id)

    assert (
        await service.is_user_active(viewer.id)
        == (await service.get_user_auth_state(viewer.id)).is_active
    )


# ---------------------------------------------------------------------------
# list_users
# ---------------------------------------------------------------------------


async def test_list_users_returns_everyone_with_state_and_origin(
    service, db_pool, admin, superadmin
):
    """[Scenario: Un admin lista los usuarios] Todos los usuarios (incluidos
    superadmins y el propio actor), con `deactivated_at` y el origen
    derivado."""
    google_only = await _make_user(
        db_pool,
        "google@example.com",
        UserRole.VIEWER,
        with_password=False,
        google_id="google-sub-123",
    )
    password_only = await _make_user(db_pool, "pass@example.com", UserRole.VIEWER)
    await service.deactivate_user(admin, password_only.id)

    users = await service.list_users()

    by_email = {user.email: user for user in users}
    assert {admin.email, superadmin.email, google_only.email, password_only.email} <= set(by_email)

    assert by_email["google@example.com"].has_google is True
    assert by_email["google@example.com"].has_password is False
    assert by_email["pass@example.com"].has_google is False
    assert by_email["pass@example.com"].has_password is True

    assert by_email["pass@example.com"].deactivated_at is not None
    assert by_email["google@example.com"].deactivated_at is None


async def test_list_users_cannot_leak_secrets_by_construction(service, db_pool, viewer):
    """[Requirement: Listado de usuarios] `UserListItem` no puede expresar
    password_hash ni totp_secret — la garantía es de diseño de tipos, no de
    un filtro en runtime."""
    users = await service.list_users()

    assert users
    for user in users:
        dumped = user.model_dump()
        assert "password_hash" not in dumped
        assert "totp_secret" not in dumped
        assert "google_id" not in dumped


async def test_list_users_is_ordered_by_creation_date_descending(service, db_pool):
    """Orden estable y útil para el admin: el alta más reciente primero."""
    async with db_pool.acquire() as conn:
        for i, email in enumerate(("viejo@example.com", "medio@example.com", "nuevo@example.com")):
            await conn.execute(
                "INSERT INTO users (email, password_hash, role, created_at) "
                "VALUES ($1, $2, 'viewer', now() - ($3 || ' days')::interval)",
                email,
                "$2b$12$hash",
                str(3 - i),
            )

    users = await service.list_users()

    emails = [user.email for user in users]
    assert emails.index("nuevo@example.com") < emails.index("medio@example.com")
    assert emails.index("medio@example.com") < emails.index("viejo@example.com")


# ---------------------------------------------------------------------------
# Camino Google: el guard vive DENTRO de resolve_or_create_google_user()
# ---------------------------------------------------------------------------


async def test_google_login_of_a_deactivated_linked_account_raises_without_writing(
    service, db_pool, admin
):
    """[Scenario: Google login de cuenta desactivada] La cuenta ya está
    vinculada por google_id. El guard corre ANTES del refresco de
    name/avatar_url: la fila NO se modifica."""
    linked = await _make_user(
        db_pool,
        "linked@example.com",
        UserRole.VIEWER,
        with_password=False,
        google_id="google-sub-linked",
    )
    await service.deactivate_user(admin, linked.id)

    with pytest.raises(AccountDeactivatedError):
        await service.resolve_or_create_google_user(
            google_id="google-sub-linked",
            email="linked@example.com",
            name="Nombre Nuevo",
            avatar_url="https://example.com/nuevo.png",
        )

    assert await _column(db_pool, linked.id, "name") is None
    assert await _column(db_pool, linked.id, "avatar_url") is None


async def test_google_auto_link_does_not_apply_to_a_deactivated_account(service, db_pool, admin):
    """[Scenario: Auto-link no se aplica a cuentas desactivadas] Cuenta creada
    por password (sin google_id) y desactivada: tras el intento, `google_id`
    sigue en NULL."""
    password_user = await _make_user(db_pool, "autolink@example.com", UserRole.VIEWER)
    await service.deactivate_user(admin, password_user.id)

    with pytest.raises(AccountDeactivatedError):
        await service.resolve_or_create_google_user(
            google_id="google-sub-autolink",
            email="autolink@example.com",
        )

    assert await _column(db_pool, password_user.id, "google_id") is None


async def test_google_login_of_an_active_linked_account_still_refreshes_profile(service, db_pool):
    """No-regresión del refactor SELECT+UPDATE de la rama "ya vinculado": una
    cuenta ACTIVA sigue sincronizando name/avatar_url en cada login."""
    linked = await _make_user(
        db_pool,
        "activo@example.com",
        UserRole.VIEWER,
        with_password=False,
        google_id="google-sub-activo",
    )

    result = await service.resolve_or_create_google_user(
        google_id="google-sub-activo",
        email="activo@example.com",
        name="Nombre Fresco",
        avatar_url="https://example.com/fresco.png",
    )

    assert result.id == linked.id
    assert await _column(db_pool, linked.id, "name") == "Nombre Fresco"
    assert await _column(db_pool, linked.id, "avatar_url") == "https://example.com/fresco.png"


async def test_google_signup_of_a_brand_new_user_still_requires_an_invitation(service, viewer):
    """No-regresión del cierre invitation-only: el guard nuevo de cuenta
    desactivada no debe haber corrido la rama de usuario nuevo (la tabla NO
    está vacía gracias al fixture `viewer`, así que no aplica bootstrap)."""
    with pytest.raises(InvitationRequiredError):
        await service.resolve_or_create_google_user(
            google_id="google-sub-desconocido",
            email="desconocido@example.com",
        )
