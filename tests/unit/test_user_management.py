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
    CannotAssignHigherOrEqualRoleError,
    CannotChangeSuperadminRoleError,
    CannotManageHigherOrEqualRoleError,
    CannotManageSelfError,
    InvitationRequiredError,
    UserAlreadyDeactivatedError,
    UserAlreadyHasRoleError,
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
# role-management (tareas 3.5 y 3.6) — change_user_role(): los SEIS guards, su
# ORDEN y la concurrencia, contra Postgres real.
#
# El orden se testea con casos que violan DOS guards a la vez: si sólo se
# afirmara el status/la excepción de casos que violan uno solo, reordenarlos no
# rompería nada y el oráculo de existencia (404 vs 403) se abriría en silencio.
# ---------------------------------------------------------------------------


async def _role_of(db_pool, user_id) -> UserRole:
    return UserRole(await _column(db_pool, user_id, "role"))


async def test_change_role_writes_the_role_and_leaves_the_rest_of_the_row_intact(
    service, db_pool, admin, viewer
):
    """[Scenario: Un admin promueve a un viewer a moderador] El UPDATE toca UNA
    columna: todo lo demás (incluido `deactivated_at`) queda como estaba."""
    before = {
        column: await _column(db_pool, viewer.id, column)
        for column in (
            "email",
            "password_hash",
            "google_id",
            "created_at",
            "deactivated_at",
        )
    }

    await service.change_user_role(admin, viewer.id, UserRole.MODERADOR)

    assert await _role_of(db_pool, viewer.id) is UserRole.MODERADOR
    for column, value in before.items():
        assert await _column(db_pool, viewer.id, column) == value


async def test_superadmin_can_demote_an_admin(service, db_pool, superadmin, admin):
    """[Scenario: Un superadmin degrada a un admin a viewer]"""
    await service.change_user_role(superadmin, admin.id, UserRole.VIEWER)

    assert await _role_of(db_pool, admin.id) is UserRole.VIEWER


async def test_changing_the_role_of_a_deactivated_account_is_valid(service, db_pool, admin, viewer):
    """[Scenario: Cambiar el rol de una cuenta desactivada es válido] El rol
    cambia y la cuenta SIGUE desactivada, con su timestamp original."""
    await service.deactivate_user(admin, viewer.id)
    original = await _deactivated_at(db_pool, viewer.id)

    await service.change_user_role(admin, viewer.id, UserRole.MODERADOR)

    assert await _role_of(db_pool, viewer.id) is UserRole.MODERADOR
    assert await _deactivated_at(db_pool, viewer.id) == original


# --- Guard 1 (self) y su precedencia ---------------------------------------


async def test_nobody_can_change_their_own_role_not_even_a_superadmin(service, db_pool, superadmin):
    """[Scenario: Nadie puede cambiarse el rol a sí mismo] El rol más alto del
    sistema: ningún guard de jerarquía lo frena y aun así no puede."""
    with pytest.raises(CannotManageSelfError):
        await service.change_user_role(superadmin, superadmin.id, UserRole.VIEWER)

    assert await _role_of(db_pool, superadmin.id) is UserRole.SUPERADMIN


async def test_self_guard_wins_over_the_requested_role_guard(service, db_pool, admin):
    """[Scenario: El orden de los guards no se altera] Un admin pidiendo
    `superadmin` para SÍ MISMO viola self (1) y jerarquía-sobre-rol-pedido (5)
    a la vez. Gana el self: 409, no 403."""
    with pytest.raises(CannotManageSelfError):
        await service.change_user_role(admin, admin.id, UserRole.SUPERADMIN)

    assert await _role_of(db_pool, admin.id) is UserRole.ADMIN


# --- Guard 2 (404) y su precedencia sobre el rol pedido ---------------------


async def test_change_role_of_an_unknown_user_raises_not_found(service, admin):
    """[Scenario: Usuario inexistente]"""
    with pytest.raises(UserNotFoundError):
        await service.change_user_role(admin, uuid4(), UserRole.VIEWER)


async def test_not_found_wins_over_the_requested_role_guard(service, admin):
    """El guard 5 NO se subió al principio, y esto lo clava: un target
    INEXISTENTE con un rol pedido que además viola la jerarquía sale 404, no
    403. Si alguien "optimiza" validando el rol pedido antes de ir a la base,
    la diferencia entre 403 y 404 se vuelve un oráculo de existencia y este
    test muere."""
    with pytest.raises(UserNotFoundError):
        await service.change_user_role(admin, uuid4(), UserRole.SUPERADMIN)


# --- Guard 3 (jerarquía sobre el rol ACTUAL del target) --------------------


async def test_admin_cannot_change_the_role_of_another_admin(service, db_pool, admin):
    """[Scenario: Un admin no puede cambiarle el rol a otro admin] Nivel IGUAL
    también está prohibido."""
    other_admin = await _make_user(db_pool, "otro-admin@example.com", UserRole.ADMIN)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.change_user_role(admin, other_admin.id, UserRole.VIEWER)

    assert await _role_of(db_pool, other_admin.id) is UserRole.ADMIN


async def test_the_noop_409_does_not_leak_to_an_actor_without_permission(service, db_pool, admin):
    """[Scenario: El 409 de no-op no se filtra a quien no tiene permiso] Otro
    admin al que se le pide el rol que YA tiene: el guard 3 (403) corre antes
    que el 6 (409), así que el actor ni se entera del estado del objetivo."""
    other_admin = await _make_user(db_pool, "admin-noop@example.com", UserRole.ADMIN)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.change_user_role(admin, other_admin.id, UserRole.ADMIN)


# --- Guard 4 (superadmin intocable) — DEDICADO, no emergente ---------------


async def test_a_superadmin_role_is_unreachable_by_every_actor(service, db_pool, superadmin):
    """[Scenario: Un admin tampoco puede tocar a un superadmin] Barrido de los
    cuatro roles contra un superadmin: nadie le cambia el rol."""
    actors = [
        await _make_user(db_pool, "rv@example.com", UserRole.VIEWER),
        await _make_user(db_pool, "rm@example.com", UserRole.MODERADOR),
        await _make_user(db_pool, "ra@example.com", UserRole.ADMIN),
    ]

    for actor in actors:
        with pytest.raises(CannotManageHigherOrEqualRoleError):
            await service.change_user_role(actor, superadmin.id, UserRole.VIEWER)

    assert await _role_of(db_pool, superadmin.id) is UserRole.SUPERADMIN


async def test_a_superadmin_cannot_demote_another_superadmin(service, db_pool, superadmin):
    """[Scenario: Un superadmin no puede degradar a otro superadmin] Nivel
    IGUAL: hoy lo frena el guard 3, que corre primero. El 403 es el mismo; cuál
    guard lo produce se afirma en el test de abajo."""
    other_superadmin = await _make_user(db_pool, "s3@example.com", UserRole.SUPERADMIN)

    with pytest.raises(CannotManageHigherOrEqualRoleError):
        await service.change_user_role(superadmin, other_superadmin.id, UserRole.ADMIN)

    assert await _role_of(db_pool, other_superadmin.id) is UserRole.SUPERADMIN


async def test_the_superadmin_rejection_comes_from_the_dedicated_guard(
    service, db_pool, superadmin, monkeypatch
):
    """[Scenario: El rechazo viene del guard dedicado, no del general] EL test
    de la Decision 3, y el assert es sobre el TIPO de excepción.

    Para llegar al guard 4 hace falta un actor que PASE el guard 3, o sea de
    nivel estrictamente mayor a superadmin — algo que hoy no existe en
    `ROLE_LEVEL`. Se simula el futuro que la Decision 3 anticipa (alguien
    agrega un `OWNER: 4` al dict) parcheando `role_level` en el módulo del
    servicio para que el actor valga 4.

    Sin el guard dedicado, ese día el actor de nivel 4 degradaría superadmins
    SIN QUE FALLE NINGÚN TEST, porque los demás expresan la aritmética y no la
    regla. Este es el único que muere.
    """
    import src.services.auth_service as auth_module

    target = await _make_user(db_pool, "s4@example.com", UserRole.SUPERADMIN)
    actor = CurrentUser(id=uuid4(), email="owner@example.com", role=UserRole.SUPERADMIN)

    # Actor y target tienen el MISMO valor de enum, así que `role_level` no los
    # puede distinguir por argumento. El orden de evaluación de
    # `_load_manageable_target()` es `role_level(target) >= role_level(actor)`:
    # primero el target, después el actor. Se emula la secuencia — 3 para el
    # target, 4 para el actor — que es exactamente el mundo con un `OWNER: 4`.
    calls: list[UserRole] = []

    def _actor_outranks_superadmin(role: UserRole) -> int:
        calls.append(role)
        return 3 if len(calls) == 1 else 4

    monkeypatch.setattr(auth_module, "role_level", _actor_outranks_superadmin)

    with pytest.raises(CannotChangeSuperadminRoleError):
        await service.change_user_role(actor, target.id, UserRole.ADMIN)

    assert await _role_of(db_pool, target.id) is UserRole.SUPERADMIN


# --- Guard 5 (jerarquía sobre el rol SOLICITADO) ---------------------------


@pytest.mark.parametrize("requested", [UserRole.ADMIN, UserRole.SUPERADMIN])
async def test_admin_cannot_assign_its_own_level_or_higher(
    service, db_pool, admin, viewer, requested
):
    """[Scenario: Un admin no puede promover a nadie a admin] +
    [Scenario: ... ni a superadmin]. El guard mira el rol PEDIDO, no el del
    objetivo: el viewer es perfectamente gestionable."""
    with pytest.raises(CannotAssignHigherOrEqualRoleError):
        await service.change_user_role(admin, viewer.id, requested)

    assert await _role_of(db_pool, viewer.id) is UserRole.VIEWER


async def test_not_even_a_superadmin_can_create_another_superadmin_by_this_door(
    service, db_pool, superadmin, viewer
):
    """[Scenario: Ni siquiera un superadmin puede crear otro superadmin por
    esta vía] Nivel IGUAL al propio: 403, no un 204."""
    with pytest.raises(CannotAssignHigherOrEqualRoleError):
        await service.change_user_role(superadmin, viewer.id, UserRole.SUPERADMIN)

    assert await _role_of(db_pool, viewer.id) is UserRole.VIEWER


async def test_superadmin_can_assign_the_admin_role(service, db_pool, superadmin, viewer):
    """[Scenario: Un superadmin sí puede asignar el rol admin]"""
    await service.change_user_role(superadmin, viewer.id, UserRole.ADMIN)

    assert await _role_of(db_pool, viewer.id) is UserRole.ADMIN


# --- Guard 6 (no-op) --------------------------------------------------------


async def test_assigning_the_role_the_user_already_has_is_a_conflict(
    service, db_pool, superadmin, admin
):
    """[Scenario: Asignar el rol actual responde 409] Rechazo explícito, no un
    204 engañoso."""
    with pytest.raises(UserAlreadyHasRoleError):
        await service.change_user_role(superadmin, admin.id, UserRole.ADMIN)

    assert await _role_of(db_pool, admin.id) is UserRole.ADMIN


# --- Concurrencia: el FOR UPDATE serializa ---------------------------------


async def test_two_concurrent_role_changes_leave_exactly_one_winner(
    service, db_pool, superadmin, admin, viewer
):
    """[Requirement: Atomicidad del cambio de rol frente a concurrencia] Dos
    actores promueven al MISMO usuario al MISMO rol a la vez. El `FOR UPDATE`
    serializa: la segunda transacción lee el rol que escribió la primera y sale
    por el guard 6. Un mock de asyncpg jamás detectaría esto."""
    results = await asyncio.gather(
        service.change_user_role(admin, viewer.id, UserRole.MODERADOR),
        service.change_user_role(superadmin, viewer.id, UserRole.MODERADOR),
        return_exceptions=True,
    )

    failures = [r for r in results if isinstance(r, Exception)]
    successes = [r for r in results if not isinstance(r, Exception)]
    assert len(successes) == 1
    assert len(failures) == 1
    assert isinstance(failures[0], UserAlreadyHasRoleError)
    assert await _role_of(db_pool, viewer.id) is UserRole.MODERADOR


async def test_a_concurrent_change_does_not_skip_the_hierarchy_guard(
    service, db_pool, superadmin, admin, viewer
):
    """[Scenario: Un cambio concurrente no salta el guard de jerarquía] El
    superadmin promueve al viewer a admin mientras el admin intenta tocarlo.
    El guard del admin se evalúa sobre el rol leído BAJO LOCK: o llega antes
    (y gana) o llega después y ve `admin`, que es nivel igual al suyo ⇒ 403.
    Nunca las dos cosas."""
    results = await asyncio.gather(
        service.change_user_role(superadmin, viewer.id, UserRole.ADMIN),
        service.change_user_role(admin, viewer.id, UserRole.MODERADOR),
        return_exceptions=True,
    )

    superadmin_result, admin_result = results
    assert not isinstance(superadmin_result, Exception)
    final_role = await _role_of(db_pool, viewer.id)
    if isinstance(admin_result, Exception):
        # El admin llegó SEGUNDO: leyó `admin` bajo lock — el rol que acababa
        # de escribir el superadmin, no el `viewer` previo a la transacción — y
        # su guard 3 disparó. El estado final es el del superadmin.
        assert isinstance(admin_result, CannotManageHigherOrEqualRoleError)
        assert final_role is UserRole.ADMIN
    else:
        # El admin llegó PRIMERO (viewer → moderador, su guard 3 pasó porque
        # moderador < admin) y el superadmin escribió `admin` encima. Final
        # consistente con ese orden, sin lectura sucia en el medio.
        assert final_role is UserRole.ADMIN
    # En las dos ramas el estado final es el mismo porque el superadmin siempre
    # gana la última escritura: lo que el test verifica es que el guard del
    # admin se evaluó sobre el rol LEÍDO BAJO LOCK, nunca sobre uno stale — si
    # se evaluara antes de la transacción, el admin vería `viewer` siempre y
    # nunca saldría por CannotManageHigherOrEqualRoleError.


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
