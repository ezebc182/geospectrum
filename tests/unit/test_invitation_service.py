"""Tests de InvitationService CONTRA POSTGRES REAL (email-invitations, Fase 4.1).

Por qué base real y no mocks: es la lección documentada del proyecto — los
mocks de asyncpg validan que se llame al pool, no que la query corra. Dos bugs
de SQL de este mismo repo pasaron con mocks en verde. Acá se ejercitan cosas
que un mock no puede contestar: que el CHECK del rol exista, que el estado
derivado (`CASE WHEN ... expires_at <= now()`) coincida con el predicado de
vigencia, que el UNIQUE de token_hash esté, y que el advisory lock serialice
dos creates concurrentes del mismo email.

Harness: fixtures `db_pool` de tests/conftest.py (Postgres 16 vía
testcontainers, migraciones 001-007 aplicadas). asyncio_mode=auto, así que no
hace falta marcar cada test.
"""

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest

from src.models.invitation import InvitationStatus
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import EmailAlreadyRegisteredError
from src.services.invitation_service import (
    CannotInviteHigherRoleError,
    InvitationAlreadyAcceptedError,
    InvitationAlreadyExistsError,
    InvitationNotFoundError,
    InvitationNotPendingError,
    InvitationService,
)

EXPIRE_DAYS = 7


@pytest.fixture
def service(db_pool):
    return InvitationService(pool=db_pool, expire_days=EXPIRE_DAYS)


async def _make_user(db_pool, email: str, role: UserRole) -> CurrentUser:
    """Crea una fila real en `users` y devuelve el CurrentUser correspondiente.

    Necesario porque `invited_by` es una FK contra users(id): un uuid4()
    inventado violaría la constraint — exactamente el tipo de detalle que un
    mock nunca revela.
    """
    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO users (email, password_hash, role) VALUES ($1, $2, $3) "
            "RETURNING id, email, role",
            email,
            "$2b$12$hash-irrelevante-para-estos-tests",
            role.value,
        )
    return CurrentUser(id=row["id"], email=row["email"], role=UserRole(row["role"]))


@pytest.fixture
async def admin(db_pool):
    return await _make_user(db_pool, "admin@example.com", UserRole.ADMIN)


@pytest.fixture
async def superadmin(db_pool):
    return await _make_user(db_pool, "superadmin@example.com", UserRole.SUPERADMIN)


async def _expire_invitation(db_pool, invitation_id) -> None:
    """Empuja expires_at al pasado — simula el paso del tiempo sin freezegun.

    freeze_time no sirve acá: la vigencia se evalúa con el `now()` de Postgres
    (design.md Decision 1 — un solo reloj para listado y consumo), que no se
    ve afectado por el reloj de Python.
    """
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = $1",
            invitation_id,
        )


# ---------------------------------------------------------------------------
# create_invitation
# ---------------------------------------------------------------------------


async def test_create_invitation_persists_hash_and_never_the_plaintext_token(
    service, db_pool, admin
):
    """[Requirement: Token de invitación almacenado solo como hash / Scenario:
    La base no contiene el token en claro] — el claro se devuelve UNA vez, la
    fila guarda su sha256, y NINGUNA columna de texto de la fila contiene el
    token."""
    invitation = await service.create_invitation(
        email="invitada@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow("SELECT * FROM invitations WHERE id = $1", invitation.id)

    expected_hash = hashlib.sha256(invitation.token.encode()).hexdigest()
    assert row["token_hash"] == expected_hash
    assert row["token_hash"] != invitation.token
    # Recorre TODA la fila: ninguna columna (ni email, ni una hipotética
    # columna nueva) puede contener el token en claro.
    for column, value in dict(row).items():
        assert invitation.token not in str(value), f"token en claro filtrado en {column}"


async def test_create_invitation_returns_pending_status_and_future_expiry(service, admin):
    """La invitación nace pendiente y con expiración a `expire_days` en el
    futuro (Decision 9 — vigencia configurable, evaluada en lectura)."""
    invitation = await service.create_invitation(
        email="nueva@example.com", role=UserRole.MODERADOR, invited_by=admin
    )

    assert invitation.status is InvitationStatus.PENDING
    assert invitation.role is UserRole.MODERADOR
    assert invitation.invited_by == admin.id
    assert invitation.email_sent_at is None
    assert invitation.accepted_at is None
    delta = invitation.expires_at - datetime.now(timezone.utc)
    # Margen amplio: sólo interesa que sea ~EXPIRE_DAYS, no el segundo exacto.
    assert timedelta(days=EXPIRE_DAYS - 1) < delta <= timedelta(days=EXPIRE_DAYS)


async def test_create_invitation_defaults_locale_to_es(service, db_pool, admin):
    """Sin `locale` explícito la invitación nace en español — mismo default
    que la columna (migración 010) y que el payload del endpoint."""
    invitation = await service.create_invitation(
        email="castellana@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    assert invitation.locale == "es"
    async with db_pool.acquire() as conn:
        stored = await conn.fetchval("SELECT locale FROM invitations WHERE id = $1", invitation.id)
    assert stored == "es"


async def test_create_invitation_persists_locale_en(service, db_pool, admin):
    """El idioma elegido al invitar se PERSISTE (columna `locale`, migración
    010): es lo que después lee la route de envío y la página /invite."""
    invitation = await service.create_invitation(
        email="english@example.com", role=UserRole.VIEWER, invited_by=admin, locale="en"
    )

    assert invitation.locale == "en"
    async with db_pool.acquire() as conn:
        stored = await conn.fetchval("SELECT locale FROM invitations WHERE id = $1", invitation.id)
    assert stored == "en"


async def test_admin_cannot_invite_superadmin(service, db_pool, admin):
    """[Requirement: Creación de invitación / Scenario: Un admin no puede
    invitar con rol superadmin] — guard de escalación: sin esto un admin se
    fabrica un superadmin por interpósita invitación. El rechazo ocurre ANTES
    de tocar la base: no queda ninguna fila."""
    with pytest.raises(CannotInviteHigherRoleError):
        await service.create_invitation(
            email="escalada@example.com", role=UserRole.SUPERADMIN, invited_by=admin
        )

    async with db_pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM invitations")
    assert count == 0


async def test_superadmin_can_invite_superadmin(service, superadmin):
    """LA EXCEPCIÓN de la decisión 9, y sigue verde SIN UNA LÍNEA MODIFICADA
    tras el endurecimiento a `>=`.

    Un superadmin sí puede invitar a otro superadmin: es la única puerta que
    queda para nombrar un segundo superadmin por la aplicación (el bootstrap
    sólo dispara con la tabla `users` vacía y el cambio de rol está bloqueado
    por el guard dedicado). Crear un par sí; degradar un par, nunca.
    """
    invitation = await service.create_invitation(
        email="otro-super@example.com", role=UserRole.SUPERADMIN, invited_by=superadmin
    )

    assert invitation.role is UserRole.SUPERADMIN


async def test_admin_cannot_invite_own_level(service, db_pool, admin):
    """[Scenario: Un admin YA NO puede invitar a otro admin] — decisión 8, el
    caso INVERTIDO.

    Va desdoblado del parametrize de abajo a propósito: el caso límite "propio
    nivel" es el ÚNICO que cambia de resultado respecto de producción, y
    diluido entre otros dos roles que siguen dando 201 nadie lo lee. Este
    rechazo es la evidencia de que el cambio de comportamiento es deliberado.

    Cerraba el bypass: un admin al que se le prohíbe promover a alguien a
    admin lograba lo mismo invitando una cuenta nueva con rol admin.
    """
    with pytest.raises(CannotInviteHigherRoleError):
        await service.create_invitation(
            email="invitado-admin@example.com", role=UserRole.ADMIN, invited_by=admin
        )

    async with db_pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM invitations")
    assert count == 0


@pytest.mark.parametrize("role", [UserRole.MODERADOR, UserRole.VIEWER])
async def test_admin_can_still_invite_below_its_own_level(service, admin, role):
    """[Scenario: Un admin sigue pudiendo invitar moderadores y viewers] —
    no-regresión: son niveles ESTRICTAMENTE menores y no cambian.

    Prefijo "invitado-": sin él chocaría con las cuentas reales de los
    fixtures y fallaría por email ya registrado.
    """
    invitation = await service.create_invitation(
        email=f"invitado-{role.value}@example.com", role=role, invited_by=admin
    )
    assert invitation.role is role


async def test_create_invitation_rejects_email_that_already_has_account(service, db_pool, admin):
    """[Requirement: Creación de invitación / Scenario: Invitación rechazada
    si el email ya tiene cuenta] — 409 lógico. El match es case-insensitive:
    la cuenta existe como `admin@example.com` y se invita `ADMIN@EXAMPLE.COM`."""
    with pytest.raises(EmailAlreadyRegisteredError):
        await service.create_invitation(
            email="ADMIN@EXAMPLE.COM", role=UserRole.VIEWER, invited_by=admin
        )

    async with db_pool.acquire() as conn:
        count = await conn.fetchval("SELECT COUNT(*) FROM invitations")
    assert count == 0


async def test_create_invitation_rejects_duplicate_pending_case_insensitive(service, admin):
    """[Requirement: Creación de invitación / Scenario: Invitación rechazada
    si ya existe una pendiente no expirada] — y el match ignora mayúsculas:
    `Duplicada@Example.com` colisiona con `duplicada@example.com`."""
    await service.create_invitation(
        email="duplicada@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    with pytest.raises(InvitationAlreadyExistsError):
        await service.create_invitation(
            email="Duplicada@Example.com", role=UserRole.VIEWER, invited_by=admin
        )


async def test_create_invitation_allowed_again_after_previous_one_expired(service, db_pool, admin):
    """La unicidad es de PENDIENTE Y VIGENTE, no de email: cuando la anterior
    expiró, crear una nueva debe funcionar. Es exactamente el caso que un
    índice parcial UNIQUE no podría expresar (`now()` no es inmutable —
    design.md Decision 1) y por eso el guard vive en el servicio."""
    first = await service.create_invitation(
        email="revive@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await _expire_invitation(db_pool, first.id)

    second = await service.create_invitation(
        email="revive@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    assert second.id != first.id
    assert second.token != first.token


async def test_create_invitation_allowed_again_after_previous_one_revoked(service, admin):
    """Mismo criterio: una revocada tampoco bloquea (no está pendiente)."""
    first = await service.create_invitation(
        email="revocada-y-nueva@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await service.revoke_invitation(first.id)

    # El rol de la segunda sólo tiene que ser DISTINTO del de la primera, para
    # que el assert pruebe que se creó una invitación nueva y no se reusó la
    # revocada. Era ADMIN y pasó a MODERADOR por la decisión 8: un admin ya no
    # invita a su propio nivel, y este test no es sobre el guard de escalación.
    second = await service.create_invitation(
        email="revocada-y-nueva@example.com", role=UserRole.MODERADOR, invited_by=admin
    )

    assert second.role is UserRole.MODERADOR


async def test_two_concurrent_creates_for_same_email_produce_exactly_one_pending(
    service, db_pool, admin
):
    """El advisory lock transaccional en create_invitation() es la ÚNICA
    garantía de "una sola pendiente vigente por email" (no hay índice parcial
    posible). Sin él, bajo READ COMMITTED ambas transacciones verían "no hay
    pendiente" e insertarían las dos.

    Un mock jamás detecta esto: no hay concurrencia que simular sobre un
    AsyncMock."""
    results = await asyncio.gather(
        service.create_invitation(
            email="carrera@example.com", role=UserRole.VIEWER, invited_by=admin
        ),
        service.create_invitation(
            email="carrera@example.com", role=UserRole.VIEWER, invited_by=admin
        ),
        return_exceptions=True,
    )

    ok = [r for r in results if not isinstance(r, Exception)]
    rejected = [r for r in results if isinstance(r, InvitationAlreadyExistsError)]
    assert len(ok) == 1, f"esperaba exactamente un ganador, hubo {len(ok)}"
    assert len(rejected) == 1

    async with db_pool.acquire() as conn:
        count = await conn.fetchval(
            "SELECT COUNT(*) FROM invitations WHERE lower(email) = 'carrera@example.com'"
        )
    assert count == 1


# ---------------------------------------------------------------------------
# revoke_invitation
# ---------------------------------------------------------------------------


async def test_revoke_pending_invitation_marks_it_revoked_and_kills_the_token(service, admin):
    """[Requirement: Revocación de invitación / Scenario: Revocar una
    invitación pendiente] — tras revocar, el listado la muestra `revoked` y su
    token deja de validar (410 vía InvitationNotPendingError)."""
    invitation = await service.create_invitation(
        email="a-revocar@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    await service.revoke_invitation(invitation.id)

    listed = {i.id: i for i in await service.list_invitations()}
    assert listed[invitation.id].status is InvitationStatus.REVOKED
    with pytest.raises(InvitationNotPendingError):
        await service.validate_token(invitation.token)


async def test_revoke_accepted_invitation_raises_conflict(service, db_pool, admin):
    """[Requirement: Revocación] Revocar una ya aceptada es 409: no des-crea
    al usuario, así que un no-op silencioso sería engañoso (Decision 3)."""
    invitation = await service.create_invitation(
        email="aceptada@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET accepted_at = now() WHERE id = $1", invitation.id
        )

    with pytest.raises(InvitationAlreadyAcceptedError):
        await service.revoke_invitation(invitation.id)


async def test_revoke_unknown_invitation_raises_not_found(service):
    with pytest.raises(InvitationNotFoundError):
        await service.revoke_invitation(uuid4())


async def test_revoke_is_idempotent_and_preserves_original_timestamp(service, db_pool, admin):
    """Revocar dos veces no falla y NO pisa el timestamp original (COALESCE):
    la fecha de baja sigue siendo la de la primera revocación."""
    invitation = await service.create_invitation(
        email="doble-revoke@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await service.revoke_invitation(invitation.id)
    async with db_pool.acquire() as conn:
        first_revoked_at = await conn.fetchval(
            "SELECT revoked_at FROM invitations WHERE id = $1", invitation.id
        )

    await service.revoke_invitation(invitation.id)

    async with db_pool.acquire() as conn:
        second_revoked_at = await conn.fetchval(
            "SELECT revoked_at FROM invitations WHERE id = $1", invitation.id
        )
    assert second_revoked_at == first_revoked_at


# ---------------------------------------------------------------------------
# resend_invitation
# ---------------------------------------------------------------------------


async def test_resend_generates_new_token_and_kills_the_previous_link(service, admin):
    """[Requirement: Reenvío / Scenario: Reenviar invalida el link anterior] —
    el hash se PISA en la misma fila, así que el token viejo queda muerto en el
    mismo acto."""
    original = await service.create_invitation(
        email="reenvio@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    resent = await service.resend_invitation(original.id)

    assert resent.id == original.id
    assert resent.token != original.token
    # El token nuevo valida; el viejo ya no existe en la base.
    assert (await service.validate_token(resent.token)).id == original.id
    with pytest.raises(InvitationNotFoundError):
        await service.validate_token(original.token)


async def test_resend_resets_email_sent_at_to_null(service, admin):
    """El badge "email sin confirmar" debe volver: el reenvío genera un link
    NUEVO que todavía no se mandó (Decision 4)."""
    invitation = await service.create_invitation(
        email="resetea-envio@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await service.mark_email_sent(invitation.id)

    resent = await service.resend_invitation(invitation.id)

    assert resent.email_sent_at is None


async def test_resend_preserves_the_locale(service, admin):
    """El reenvío regenera token y expiración pero CONSERVA el idioma: el
    destinatario es el mismo y su idioma no cambió."""
    invitation = await service.create_invitation(
        email="resend-en@example.com", role=UserRole.VIEWER, invited_by=admin, locale="en"
    )

    resent = await service.resend_invitation(invitation.id)

    assert resent.locale == "en"


async def test_resend_revives_an_expired_invitation(service, db_pool, admin):
    """[Requirement: Reenvío / Scenario: Reenviar una invitación expirada la
    revive con token nuevo] — vuelve a `pending` con expiración futura."""
    invitation = await service.create_invitation(
        email="expirada-revive@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await _expire_invitation(db_pool, invitation.id)
    listed = {i.id: i for i in await service.list_invitations()}
    assert listed[invitation.id].status is InvitationStatus.EXPIRED

    resent = await service.resend_invitation(invitation.id)

    assert resent.status is InvitationStatus.PENDING
    assert resent.expires_at > datetime.now(timezone.utc)
    assert (await service.validate_token(resent.token)).id == invitation.id


async def test_resend_accepted_invitation_raises_conflict(service, db_pool, admin):
    invitation = await service.create_invitation(
        email="ya-usada@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET accepted_at = now() WHERE id = $1", invitation.id
        )

    with pytest.raises(InvitationAlreadyAcceptedError):
        await service.resend_invitation(invitation.id)


async def test_resend_revoked_invitation_raises_not_pending(service, admin):
    invitation = await service.create_invitation(
        email="revocada-no-reenvia@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await service.revoke_invitation(invitation.id)

    with pytest.raises(InvitationNotPendingError):
        await service.resend_invitation(invitation.id)


async def test_resend_unknown_invitation_raises_not_found(service):
    with pytest.raises(InvitationNotFoundError):
        await service.resend_invitation(uuid4())


# ---------------------------------------------------------------------------
# validate_token
# ---------------------------------------------------------------------------


async def test_validate_pending_token_returns_email_and_role(service, admin):
    """[Requirement: Validación pública / Scenario: Token válido devuelve
    email y rol]."""
    invitation = await service.create_invitation(
        email="valida@example.com", role=UserRole.MODERADOR, invited_by=admin
    )

    public = await service.validate_token(invitation.token)

    assert public.email == "valida@example.com"
    assert public.role is UserRole.MODERADOR
    assert public.locale == "es"
    assert public.status is InvitationStatus.PENDING


async def test_validate_unknown_token_raises_not_found(service):
    """404: el token no corresponde a ninguna fila (link inventado/corrupto)."""
    with pytest.raises(InvitationNotFoundError):
        await service.validate_token("token-que-no-existe-en-ningun-lado")


async def test_validate_expired_token_raises_not_pending(service, db_pool, admin):
    """410 Gone: la invitación EXISTE pero ya no sirve. 404 vs 410 se
    distinguen a propósito (design.md Decision 3, que gana sobre la spec):
    con 256 bits de entropía no hay enumeración posible y la UX de "link
    inválido" vs "vencido, pedí un reenvío" lo vale."""
    invitation = await service.create_invitation(
        email="vencida@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await _expire_invitation(db_pool, invitation.id)

    with pytest.raises(InvitationNotPendingError):
        await service.validate_token(invitation.token)


async def test_validate_revoked_token_raises_not_pending(service, admin):
    invitation = await service.create_invitation(
        email="revocada-validate@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    await service.revoke_invitation(invitation.id)

    with pytest.raises(InvitationNotPendingError):
        await service.validate_token(invitation.token)


async def test_validate_accepted_token_raises_not_pending(service, db_pool, admin):
    invitation = await service.create_invitation(
        email="aceptada-validate@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    async with db_pool.acquire() as conn:
        await conn.execute(
            "UPDATE invitations SET accepted_at = now() WHERE id = $1", invitation.id
        )

    with pytest.raises(InvitationNotPendingError):
        await service.validate_token(invitation.token)


async def test_n_validations_do_not_consume_the_invitation(service, db_pool, admin):
    """[Requirement: Validación pública / Scenario: La validación no consume]
    — validar N veces deja la invitación exactamente igual de pendiente. El
    consumo es exclusivo del registro (AuthService._consume_pending_invitation)."""
    invitation = await service.create_invitation(
        email="idempotente@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    for _ in range(5):
        public = await service.validate_token(invitation.token)
        assert public.status is InvitationStatus.PENDING

    async with db_pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT accepted_at, accepted_by, revoked_at FROM invitations WHERE id = $1",
            invitation.id,
        )
    assert row["accepted_at"] is None
    assert row["accepted_by"] is None
    assert row["revoked_at"] is None


# ---------------------------------------------------------------------------
# mark_email_sent
# ---------------------------------------------------------------------------


async def test_mark_email_sent_sets_the_timestamp(service, admin):
    invitation = await service.create_invitation(
        email="envio@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    assert invitation.email_sent_at is None

    await service.mark_email_sent(invitation.id)

    listed = {i.id: i for i in await service.list_invitations()}
    assert listed[invitation.id].email_sent_at is not None


async def test_mark_email_sent_unknown_invitation_raises_not_found(service):
    """El "UPDATE 0" debe traducirse a 404 — un mock de execute() devolvería
    un Mock truthy y este caso pasaría inadvertido."""
    with pytest.raises(InvitationNotFoundError):
        await service.mark_email_sent(uuid4())


# ---------------------------------------------------------------------------
# list_invitations
# ---------------------------------------------------------------------------


async def test_list_reflects_the_four_derived_states(service, db_pool, admin):
    """[Requirement: Listado / Scenario: El listado refleja los cuatro
    estados] — pending/accepted/revoked/expired derivados de los timestamps
    en la QUERY (sin columna `status`), y las pendientes primero."""
    pending = await service.create_invitation(
        email="p@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    accepted = await service.create_invitation(
        email="a@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    revoked = await service.create_invitation(
        email="r@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    expired = await service.create_invitation(
        email="e@example.com", role=UserRole.VIEWER, invited_by=admin
    )
    async with db_pool.acquire() as conn:
        await conn.execute("UPDATE invitations SET accepted_at = now() WHERE id = $1", accepted.id)
    await service.revoke_invitation(revoked.id)
    await _expire_invitation(db_pool, expired.id)

    listed = await service.list_invitations()
    by_id = {i.id: i for i in listed}

    assert by_id[pending.id].status is InvitationStatus.PENDING
    assert by_id[accepted.id].status is InvitationStatus.ACCEPTED
    assert by_id[revoked.id].status is InvitationStatus.REVOKED
    assert by_id[expired.id].status is InvitationStatus.EXPIRED
    # Las pendientes van primero (cola de trabajo del admin).
    assert listed[0].status is InvitationStatus.PENDING


async def test_list_never_exposes_tokens(service, admin):
    """[Requirement: Token solo como hash / Scenario: El listado no expone
    tokens] — garantía por construcción del tipo (InvitationPublic no declara
    `token` ni `token_hash`), confirmada sobre el objeto serializado."""
    invitation = await service.create_invitation(
        email="sin-token@example.com", role=UserRole.VIEWER, invited_by=admin
    )

    listed = await service.list_invitations()

    for item in listed:
        dumped = item.model_dump()
        assert "token" not in dumped
        assert "token_hash" not in dumped
        assert invitation.token not in str(dumped)


async def test_list_on_empty_table_returns_empty_list(service):
    assert await service.list_invitations() == []
