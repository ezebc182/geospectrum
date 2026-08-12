"""
Servicio de invitaciones (email-invitations, design.md Decision 2).

CRUD admin de invitaciones: crear, listar, revocar, reenviar, validar y
confirmar envío de email. El CONSUMO de la invitación (marcarla aceptada al
crear el usuario) NO vive acá: es atómico con el INSERT de `users` y por eso
pertenece a la transacción de AuthService (_consume_pending_invitation) — la
regla que decide es "quién es dueño de la transacción".

Pool inyectado y PRESTADO (mismo patrón que AreaService): lo crea y lo
cierra el lifespan() de src/main.py, este servicio nunca lo cierra.

Sin ciclo de imports: este módulo no importa auth_service (sólo modelos).
auth_service y main.py importan de acá el predicado compartido, las
excepciones y el helper de INSERT.
"""

from __future__ import annotations

import hashlib
import secrets
from typing import Optional
from uuid import UUID

import asyncpg

from src.models.invitation import InvitationPublic, InvitationStatus, InvitationWithToken
from src.models.user import CurrentUser, UserRole, role_level

# Invitación consumible: no aceptada, no revocada, no vencida. Se interpola
# como fragmento SQL constante (NUNCA con datos del usuario) dentro de los
# UPDATE de consumo en auth_service y de las queries de este servicio. Un
# solo lugar define el predicado; si mañana cambia la semántica de vigencia,
# cambia acá y nada más.
PENDING_PREDICATE_SQL = "accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()"

# Estado derivado (design.md Decision 1: timestamps, sin columna `status`).
# Evaluado EN LA QUERY, no en Python: la expiración se decide con el now()
# de Postgres — el mismo reloj que usa PENDING_PREDICATE_SQL — así listado y
# consumo nunca pueden discrepar por desfase de relojes app/base.
_STATUS_SQL = """
    CASE
        WHEN revoked_at IS NOT NULL THEN 'revoked'
        WHEN accepted_at IS NOT NULL THEN 'accepted'
        WHEN expires_at <= now() THEN 'expired'
        ELSE 'pending'
    END
"""

# Columnas expuestas hacia InvitationPublic. token_hash NUNCA está acá — el
# modelo no lo declara y la query no lo lee (garantía doble).
_SELECT_COLUMNS = f"""
    id, email, role, {_STATUS_SQL} AS status,
    invited_by, created_at, expires_at, accepted_at, email_sent_at
"""


# ---------------------------------------------------------------------------
# Excepciones — clases planas, sin HTTP (mismo patrón que auth_service:
# el endpoint las traduce a su código según la matriz de Decision 3).
# ---------------------------------------------------------------------------


class InvitationRequiredError(Exception):
    """Registro invitation-only (Decision 5): se intentó crear un usuario
    sin una invitación pendiente y vigente. Aplica a los DOS caminos de
    creación — password (consume por token) y Google (consume por email
    verificado) — salvo el bootstrap del primer usuario. (Movida acá desde
    auth_service en la Fase 2: la definición vive con el dominio de
    invitaciones; auth_service la re-exporta para sus callers.)"""


class InvalidInvitationError(Exception):
    """El token de invitación presentado no corresponde a ninguna invitación
    consumible (inexistente, expirada, revocada o ya aceptada), o el email
    del payload no coincide con el de la invitación. El endpoint de register
    la traduce a 410/422 (Decision 3)."""


class InvitationEmailMismatchError(InvalidInvitationError):
    """El token de invitación es válido pero el email del payload de register
    no coincide (case-insensitive) con el email invitado — el rol está atado
    al email invitado, no al portador del link. Subclase de
    InvalidInvitationError a propósito: un handler genérico la trata como
    "invitación inválida", pero el endpoint de register la distingue PRIMERO
    para responder 422 en vez de 410 (Decision 3 / tarea 3.2)."""


class InvitationNotFoundError(Exception):
    """No existe invitación con ese id (o con ese token, en validate) -> 404."""


class InvitationNotPendingError(Exception):
    """La invitación existe pero no está pendiente y vigente (expirada,
    revocada o aceptada). validate la traduce a 410 Gone; resend sobre una
    revocada la traduce a 409."""


class InvitationAlreadyExistsError(Exception):
    """Ya existe una invitación pendiente y vigente para ese email -> 409
    (el camino correcto es reenviar o revocar, no duplicar)."""


class InvitationAlreadyAcceptedError(Exception):
    """Se intentó revocar o reenviar una invitación ya consumida -> 409.
    Revocar una invitación aceptada no des-crea al usuario: rechazo
    explícito, no un no-op engañoso (Decision 3)."""


class CannotInviteHigherRoleError(Exception):
    """Guard de escalación: nadie invita a un rol de nivel superior al
    propio (un admin no se fabrica un superadmin por interpósita
    invitación) -> 403."""


# ---------------------------------------------------------------------------
# Helpers compartidos
# ---------------------------------------------------------------------------


def _new_token() -> tuple[str, str]:
    """Genera (token en claro, sha256 hex). token_urlsafe(32) = 256 bits de
    entropía: SHA-256 sin salt alcanza y bcrypt sería un error acá (design.md
    Decision 1 — el hash determinístico es lo que permite el lookup indexado
    por token_hash; la fuerza bruta sobre 256 bits es inviable)."""
    token = secrets.token_urlsafe(32)
    return token, hashlib.sha256(token.encode()).hexdigest()


def _row_to_public(row: asyncpg.Record) -> InvitationPublic:
    return InvitationPublic(
        id=row["id"],
        email=row["email"],
        role=UserRole(row["role"]),
        status=InvitationStatus(row["status"]),
        invited_by=row["invited_by"],
        created_at=row["created_at"],
        expires_at=row["expires_at"],
        accepted_at=row["accepted_at"],
        email_sent_at=row["email_sent_at"],
    )


async def insert_invitation_row(
    conn: asyncpg.Connection,
    *,
    email: str,
    role: UserRole,
    invited_by: Optional[UUID],
    expire_days: int,
) -> tuple[asyncpg.Record, str]:
    """INSERT de una invitación dentro de la transacción del CALLER.

    Única fuente de verdad de "cómo nace una invitación" (token en claro +
    sha256 persistido + expiración): la usan create_invitation() abajo Y el
    approve de beta-signups en main.py, que necesita crear la invitación
    dentro de SU propia transacción (FOR UPDATE sobre beta_signups) — por eso
    recibe la conn y no toma el pool del servicio.

    NO chequea unicidad de pendiente vigente ni email-ya-registrado: esos
    guards son del caller (create_invitation los aplica; el approve de beta
    ya verifica la pendiente vigente con su propia semántica idempotente).

    SÍ toma el advisory lock por email: acá adentro y no en el caller, porque
    es la única puerta por la que nace una invitación. Con el lock en
    create_invitation() nada más, un approve de beta y un create de admin
    simultáneos sobre el mismo email dejaban DOS pendientes vigentes (el
    chequeo de "no hay pendiente" de cada uno corría antes del INSERT del
    otro bajo READ COMMITTED). El lock es reentrante por transacción, así que
    tomarlo de nuevo desde create_invitation() no bloquea.

    Retorna (fila insertada con las columnas públicas, token en claro).
    """
    await conn.execute("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", email)
    token, token_hash = _new_token()
    row = await conn.fetchrow(
        f"""
        INSERT INTO invitations (email, role, token_hash, invited_by, expires_at)
        VALUES ($1, $2, $3, $4, now() + make_interval(days => $5))
        RETURNING {_SELECT_COLUMNS}
        """,
        email,
        role.value,
        token_hash,
        invited_by,
        expire_days,
    )
    return row, token


class InvitationService:
    """CRUD admin sobre la tabla `invitations` (migración 007)."""

    def __init__(self, pool: asyncpg.Pool, expire_days: int) -> None:
        """
        Args:
            pool: pool de asyncpg creado por el lifespan. PRESTADO — este
                servicio no lo crea ni lo cierra (ver AreaService y la
                bandera _owns_pool de AuthService).
            expire_days: vigencia de cada token (settings.invitation_expire_days,
                Decision 9 — default 7, evaluada en lectura, sin worker).
        """
        self._pool = pool
        self._expire_days = expire_days

    # -------------------------------------------------------------------
    # Escritura
    # -------------------------------------------------------------------

    async def create_invitation(
        self, email: str, role: UserRole, invited_by: CurrentUser
    ) -> InvitationWithToken:
        """Crea una invitación y retorna el token en claro — la ÚNICA vez.

        Guard de escalación ANTES de tocar la base: nadie invita un rol de
        nivel superior al propio (role_level, jerarquía existente).

        Los chequeos de "email ya registrado" y "pendiente vigente duplicada"
        y el INSERT corren en UNA transacción serializada por un advisory
        lock transaccional sobre el email normalizado: la unicidad de
        pendiente vigente NO puede ser un índice parcial (su predicado
        necesitaría `expires_at > now()` y los índices exigen expresiones
        inmutables — design.md Decision 1), así que la garantía vive acá.
        Sin el lock, dos creates concurrentes para el mismo email verían
        ambos "no hay pendiente" (READ COMMITTED) e insertarían dos.

        Raises:
            CannotInviteHigherRoleError: rol invitado > rol del invitador (403)
            EmailAlreadyRegisteredError: el email ya tiene cuenta en users (409)
            InvitationAlreadyExistsError: ya hay pendiente vigente (409)
        """
        # Import local, no módulo-level: auth_service importa de ESTE módulo
        # (PENDING_PREDICATE_SQL, InvitationRequiredError), un import
        # top-level en la otra dirección sería un ciclo. La excepción se
        # REUTILIZA (design.md Decision 3) para que "email ya registrado"
        # sea el mismo 409 acá y en el register.
        from src.services.auth_service import EmailAlreadyRegisteredError

        if role_level(role) > role_level(invited_by.role):
            raise CannotInviteHigherRoleError(
                f"{invited_by.role.value} cannot invite role {role.value}"
            )

        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # Serializa creates concurrentes del MISMO email (se libera
                # solo al commit/rollback). hashtext: el lock key es int, no
                # string. Emails distintos no se bloquean entre sí.
                await conn.execute("SELECT pg_advisory_xact_lock(hashtext(lower($1)))", email)

                existing_user = await conn.fetchval(
                    "SELECT id FROM users WHERE lower(email) = lower($1)", email
                )
                if existing_user is not None:
                    raise EmailAlreadyRegisteredError(email)

                pending = await conn.fetchval(
                    f"SELECT id FROM invitations "
                    f"WHERE lower(email) = lower($1) AND {PENDING_PREDICATE_SQL}",
                    email,
                )
                if pending is not None:
                    raise InvitationAlreadyExistsError(email)

                row, token = await insert_invitation_row(
                    conn,
                    email=email,
                    role=role,
                    invited_by=invited_by.id,
                    expire_days=self._expire_days,
                )

        return InvitationWithToken(**_row_to_public(row).model_dump(), token=token)

    async def revoke_invitation(self, invitation_id: UUID) -> None:
        """Revoca una invitación no aceptada (setea revoked_at).

        Idempotente sobre una ya revocada (COALESCE preserva el timestamp
        original). Una expirada también puede revocarse — inofensivo y deja
        explícito en el listado que el admin la dio de baja.

        Raises:
            InvitationNotFoundError: no existe (404)
            InvitationAlreadyAcceptedError: ya consumida (409)
        """
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                # FOR UPDATE: el guard de "no aceptada" y el UPDATE deben ser
                # atómicos frente a un consumo concurrente de la invitación.
                row = await conn.fetchrow(
                    "SELECT accepted_at FROM invitations WHERE id = $1 FOR UPDATE",
                    invitation_id,
                )
                if row is None:
                    raise InvitationNotFoundError(str(invitation_id))
                if row["accepted_at"] is not None:
                    raise InvitationAlreadyAcceptedError(str(invitation_id))

                await conn.execute(
                    "UPDATE invitations SET revoked_at = COALESCE(revoked_at, now()) "
                    "WHERE id = $1",
                    invitation_id,
                )

    async def resend_invitation(self, invitation_id: UUID) -> InvitationWithToken:
        """Regenera token + expiración y resetea email_sent_at a NULL.

        El hash anterior se PISA en la misma fila: el link viejo queda muerto
        en el mismo acto. Una invitación EXPIRADA revive (vuelve a pending
        con expiración futura) — [Scenario: Reenviar una invitación expirada
        la revive con token nuevo]; una aceptada o revocada no se reenvía.

        Raises:
            InvitationNotFoundError: no existe (404)
            InvitationAlreadyAcceptedError: ya consumida (409)
            InvitationNotPendingError: revocada (409)
        """
        token, token_hash = _new_token()
        async with self._pool.acquire() as conn:
            async with conn.transaction():
                row = await conn.fetchrow(
                    "SELECT accepted_at, revoked_at FROM invitations " "WHERE id = $1 FOR UPDATE",
                    invitation_id,
                )
                if row is None:
                    raise InvitationNotFoundError(str(invitation_id))
                if row["accepted_at"] is not None:
                    raise InvitationAlreadyAcceptedError(str(invitation_id))
                if row["revoked_at"] is not None:
                    raise InvitationNotPendingError(str(invitation_id))

                updated = await conn.fetchrow(
                    f"""
                    UPDATE invitations
                    SET token_hash = $1,
                        expires_at = now() + make_interval(days => $2),
                        email_sent_at = NULL
                    WHERE id = $3
                    RETURNING {_SELECT_COLUMNS}
                    """,
                    token_hash,
                    self._expire_days,
                    invitation_id,
                )

        return InvitationWithToken(**_row_to_public(updated).model_dump(), token=token)

    async def mark_email_sent(self, invitation_id: UUID) -> None:
        """Setea email_sent_at = now() (confirmación de envío, Decision 4).

        La invoca la route de Next tras un envío exitoso de Resend, con la
        cookie del admin — no es un reporte anónimo falsificable. Se pisa en
        cada confirmación a propósito: refleja el ÚLTIMO envío (un resend
        resetea a NULL y un nuevo envío vuelve a confirmarlo).

        Raises:
            InvitationNotFoundError: no existe (404)
        """
        async with self._pool.acquire() as conn:
            result = await conn.execute(
                "UPDATE invitations SET email_sent_at = now() WHERE id = $1",
                invitation_id,
            )
        if result == "UPDATE 0":
            raise InvitationNotFoundError(str(invitation_id))

    # -------------------------------------------------------------------
    # Lectura
    # -------------------------------------------------------------------

    async def list_invitations(self) -> list[InvitationPublic]:
        """Todas las invitaciones con estado derivado evaluado en la query.

        Pendientes primero (es la cola de trabajo del admin), más nuevas
        arriba — mismo criterio que el listado de beta_signups.
        """
        async with self._pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT {_SELECT_COLUMNS}
                FROM invitations
                ORDER BY ({_STATUS_SQL} = 'pending') DESC, created_at DESC
                """
            )
        return [_row_to_public(r) for r in rows]

    async def validate_token(self, token: str) -> InvitationPublic:
        """Valida un token en claro SIN consumirlo: validar N veces deja la
        invitación igual de pendiente (el consumo es exclusivo del registro,
        AuthService._consume_pending_invitation).

        Las dos causas de rechazo son excepciones DISTINTAS a propósito
        (Decision 3): el endpoint traduce "no existe" a 404 y "existe pero no
        pendiente" a 410 — con 256 bits de entropía no hay riesgo real de
        enumeración y la UX de "link inválido" vs "vencido, pedí un reenvío"
        lo vale.

        Raises:
            InvitationNotFoundError: token desconocido (404)
            InvitationNotPendingError: expirada/revocada/aceptada (410)
        """
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        async with self._pool.acquire() as conn:
            row = await conn.fetchrow(
                f"SELECT {_SELECT_COLUMNS} FROM invitations WHERE token_hash = $1",
                token_hash,
            )
        if row is None:
            raise InvitationNotFoundError("unknown invitation token")

        public = _row_to_public(row)
        if public.status is not InvitationStatus.PENDING:
            raise InvitationNotPendingError(public.status.value)
        return public
