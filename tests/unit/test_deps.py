"""Tests unitarios para src/api/deps.py: get_current_user y require_role.

Usa un FastAPI app mínimo montado solo en el test (sin tocar src/main.py,
que en este batch no gana ningún endpoint nuevo) y mockea AuthService para
no requerir Postgres real.
"""

import pytest
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from jose import jwt

from src.api.deps import SESSION_COOKIE_NAME, get_current_user, require_min_role, require_role
from src.models.user import CurrentUser, UserRole
from src.services.auth_service import (
    JWT_ALGORITHM,
    InvalidTokenError,
    TokenExpiredError,
    UserAuthState,
)

SUPERADMIN_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556665",
    email="root@example.com",
    role=UserRole.SUPERADMIN,
)
ADMIN_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556666",
    email="ana@example.com",
    role=UserRole.ADMIN,
)
MODERADOR_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556668",
    email="carla@example.com",
    role=UserRole.MODERADOR,
)
VIEWER_USER = CurrentUser(
    id="3f9a2b1c-1111-2222-3333-444455556667",
    email="bruno@example.com",
    role=UserRole.VIEWER,
)


class _FakeAuthService:
    """Sustituye AuthService.decode_access_token/decode_token_payload con
    comportamiento fijo por token.

    `decode_token_payload()` (tarea 3.1/3.2, account-settings): por default
    devuelve un payload "inocente" (`{}`, sin `pending_2fa`) para cualquier
    token registrado que resuelva a un `CurrentUser` válido — get_current_user()
    llama a este método ANTES de decode_access_token(), así que debe
    comportarse de forma consistente con los tokens ya registrados en
    `self._tokens` para no romper los tests de Phase 3.5 (roles) ya
    existentes. `payloads` permite overridear ese comportamiento por token
    para los tests nuevos de pending_2fa.

    `is_user_active()` (tarea 1.15, user-management): get_current_user() ahora
    hace un round-trip a la base tras decodificar el JWT (design.md Decision
    4), así que TODO fake de auth_service necesita el método. Por default
    devuelve True — el comportamiento de una cuenta activa, que es el que
    asumen todos los tests preexistentes de este archivo. `inactive_users`
    permite marcar ids concretos como desactivados/inexistentes para los tests
    nuevos, sin duplicar el armado de la app.

    `get_user_auth_state()` (tarea 2.6, role-management): get_current_user()
    dejó de llamar a `is_user_active()` y ahora usa este método, que devuelve
    estado + ROL en una sola query. `db_roles` permite que la base "diga" un
    rol DISTINTO al del claim del JWT — que es exactamente el caso que este
    change tiene que resolver. Sin override, el rol de la base coincide con el
    del token, o sea el comportamiento de todos los tests preexistentes.

    Los valores devueltos son CONCRETOS (`UserRole.VIEWER`, `True`/`False`),
    NUNCA `MagicMock`: el precedente del proyecto es feo — en `user-management`
    los `MagicMock` con atributos autogenerados rompieron 65 tests porque
    `deactivated_at` daba truthy.

    `is_user_active()` se conserva igual aunque get_current_user() ya no lo
    llame: sigue siendo parte de la superficie del servicio (firma intacta por
    decisión 7) y no hay razón para que el fake mienta sobre eso.
    """

    def __init__(
        self,
        tokens: dict,
        payloads: dict | None = None,
        inactive_users: set | None = None,
        db_roles: dict | None = None,
    ) -> None:
        self._tokens = tokens
        self._payloads = payloads or {}
        self._inactive_users = {str(user_id) for user_id in (inactive_users or set())}
        self._db_roles = {str(user_id): role for user_id, role in (db_roles or {}).items()}

    async def is_user_active(self, user_id) -> bool:
        return str(user_id) not in self._inactive_users

    async def get_user_auth_state(self, user_id) -> UserAuthState:
        is_active = str(user_id) not in self._inactive_users
        role = self._db_roles.get(str(user_id), self._role_from_token_claims(user_id))
        return UserAuthState(is_active=is_active, role=role)

    def _role_from_token_claims(self, user_id) -> UserRole | None:
        """Sin override explícito, la base "dice" lo mismo que el token.

        Devolver un rol fijo (VIEWER) acá rompería todos los tests
        preexistentes de require_role/require_min_role, que asumen que el rol
        del claim es el efectivo. La divergencia se pide EXPLÍCITAMENTE con
        `db_roles`, que es el punto del change.
        """
        for user in self._tokens.values():
            if isinstance(user, CurrentUser) and str(user.id) == str(user_id):
                return user.role
        return None

    def decode_token_payload(self, token: str) -> dict:
        if token in self._payloads:
            return self._payloads[token]
        result = self._tokens.get(token)
        if result is None:
            raise InvalidTokenError()
        if result == "expired":
            raise TokenExpiredError()
        return {}

    def decode_access_token(self, token: str) -> CurrentUser:
        result = self._tokens.get(token)
        if result is None:
            raise InvalidTokenError()
        if result == "expired":
            raise TokenExpiredError()
        return result


def _build_app(auth_service: _FakeAuthService) -> FastAPI:
    app = FastAPI()
    app.state.auth_service = auth_service

    @app.get("/protected")
    async def protected(current_user: CurrentUser = Depends(get_current_user)):
        return {"id": str(current_user.id), "role": current_user.role.value}

    @app.get("/admin-only")
    async def admin_only(current_user: CurrentUser = Depends(require_role(UserRole.ADMIN))):
        return {"id": str(current_user.id), "role": current_user.role.value}

    @app.get("/moderador-or-above")
    async def moderador_or_above(
        current_user: CurrentUser = Depends(require_min_role(UserRole.MODERADOR)),
    ):
        return {"id": str(current_user.id), "role": current_user.role.value}

    return app


@pytest.fixture
def client_with_valid_admin_token():
    fake_service = _FakeAuthService({"valid-admin-token": ADMIN_USER})
    app = _build_app(fake_service)
    return TestClient(app)


@pytest.fixture
def client_with_valid_viewer_token():
    fake_service = _FakeAuthService({"valid-viewer-token": VIEWER_USER})
    app = _build_app(fake_service)
    return TestClient(app)


@pytest.fixture
def client_with_all_role_tokens():
    """Un solo cliente con un token válido por cada uno de los 4 roles,
    para testear require_min_role sin repetir el armado de la app."""
    fake_service = _FakeAuthService(
        {
            "valid-superadmin-token": SUPERADMIN_USER,
            "valid-admin-token": ADMIN_USER,
            "valid-moderador-token": MODERADOR_USER,
            "valid-viewer-token": VIEWER_USER,
        }
    )
    app = _build_app(fake_service)
    return TestClient(app)


def test_get_current_user_without_cookie_returns_401():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/protected")

    assert response.status_code == 401
    assert "not authenticated" in response.json()["detail"]


def test_get_current_user_with_valid_cookie_returns_current_user(client_with_valid_admin_token):
    client_with_valid_admin_token.cookies.set(SESSION_COOKIE_NAME, "valid-admin-token")

    response = client_with_valid_admin_token.get("/protected")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == str(ADMIN_USER.id)
    assert body["role"] == "admin"


def test_get_current_user_with_corrupt_cookie_returns_401():
    fake_service = _FakeAuthService({})  # cualquier token no registrado -> InvalidTokenError
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "garbage-not-a-jwt")

    response = client.get("/protected")

    assert response.status_code == 401


def test_get_current_user_with_expired_token_returns_401():
    fake_service = _FakeAuthService({"expired-token": "expired"})
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "expired-token")

    response = client.get("/protected")

    assert response.status_code == 401


def test_require_role_allows_when_role_matches(client_with_valid_admin_token):
    client_with_valid_admin_token.cookies.set(SESSION_COOKIE_NAME, "valid-admin-token")

    response = client_with_valid_admin_token.get("/admin-only")

    assert response.status_code == 200


def test_require_role_rejects_with_403_when_role_does_not_match(client_with_valid_viewer_token):
    client_with_valid_viewer_token.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client_with_valid_viewer_token.get("/admin-only")

    assert response.status_code == 403
    assert "insufficient role" in response.json()["detail"]


def test_require_role_rejects_with_401_when_no_session():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/admin-only")

    assert response.status_code == 401


def test_require_role_rejects_superior_role_because_it_requires_exact_equality(
    client_with_all_role_tokens,
):
    """require_role exige IGUALDAD exacta, no jerarquía: un superadmin
    intentando pasar require_role(ADMIN) también recibe 403 (design.md
    Decision 6 — este es el caso que motiva require_min_role aparte)."""
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-superadmin-token")

    response = client_with_all_role_tokens.get("/admin-only")

    assert response.status_code == 403


# ---------------------------------------------------------------------------
# require_min_role — comparación por NIVEL, no por igualdad (Phase 3.5)
# ---------------------------------------------------------------------------


def test_require_min_role_allows_when_role_matches_minimum_exactly(client_with_all_role_tokens):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-moderador-token")

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 200


@pytest.mark.parametrize(
    "token",
    ["valid-admin-token", "valid-superadmin-token"],
)
def test_require_min_role_allows_roles_above_minimum(client_with_all_role_tokens, token):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, token)

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 200


def test_require_min_role_rejects_with_403_when_role_is_below_minimum(client_with_all_role_tokens):
    client_with_all_role_tokens.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client_with_all_role_tokens.get("/moderador-or-above")

    assert response.status_code == 403
    assert "insufficient role" in response.json()["detail"]


def test_require_min_role_rejects_with_401_when_no_session():
    fake_service = _FakeAuthService({})
    app = _build_app(fake_service)
    client = TestClient(app)

    response = client.get("/moderador-or-above")

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# account-settings (tarea 3.2) — get_current_user() rechaza tokens
# pending_2fa=true, incluso si llegan en la cookie `session`.
# ---------------------------------------------------------------------------


def test_get_current_user_rejects_pending_2fa_token_even_with_valid_signature():
    """[Tarea 3.2, design.md Decision 1] Un JWT válido en firma pero con
    `pending_2fa: true` (construido directamente vía jose.jwt.encode, no vía
    create_access_token — simula un token de pre-auth real emitido por
    POST /auth/login con 2FA pendiente) debe ser rechazado por
    get_current_user() con 401, nunca resolver un CurrentUser."""
    raw_token = jwt.encode(
        {"sub": str(VIEWER_USER.id), "pending_2fa": True, "typ": "pre_auth"},
        "irrelevant-secret-not-checked-by-fake-service",
        algorithm=JWT_ALGORITHM,
    )
    fake_service = _FakeAuthService(
        tokens={raw_token: VIEWER_USER},
        payloads={raw_token: {"sub": str(VIEWER_USER.id), "pending_2fa": True, "typ": "pre_auth"}},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, raw_token)

    response = client.get("/protected")

    assert response.status_code == 401
    assert "not authenticated" in response.json()["detail"]


def test_get_current_user_allows_token_without_pending_2fa_claim():
    """No-regresión explícita: un token cuyo payload NO tiene `pending_2fa`
    (el caso de todo token de sesión completa pre-existente) sigue
    resolviendo el CurrentUser con normalidad — el chequeo nuevo de 3.1 no
    debe romper el flujo ya cubierto por
    test_get_current_user_with_valid_cookie_returns_current_user."""
    fake_service = _FakeAuthService(
        tokens={"valid-viewer-token": VIEWER_USER},
        payloads={"valid-viewer-token": {"sub": str(VIEWER_USER.id)}},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client.get("/protected")

    assert response.status_code == 200


# ---------------------------------------------------------------------------
# user-management (tarea 1.15) — get_current_user() verifica contra la base
# que la cuenta siga existiendo y activa, en CADA request autenticado.
# ---------------------------------------------------------------------------


def test_get_current_user_rejects_deactivated_account_with_401():
    """[Requirement: Invalidación inmediata de sesiones ya emitidas /
    Scenario: Sesión viva muere al desactivar la cuenta] El JWT es válido en
    firma y no venció — lo único que cambió es el estado de la cuenta en la
    base, y eso alcanza para el 401."""
    fake_service = _FakeAuthService(
        tokens={"valid-viewer-token": VIEWER_USER},
        inactive_users={VIEWER_USER.id},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client.get("/protected")

    assert response.status_code == 401
    # 401 GENÉRICO: no distingue "cuenta desactivada" de "token vencido".
    assert "not authenticated" in response.json()["detail"]


def test_get_current_user_rejects_token_of_deleted_user_with_401():
    """[Scenario: JWT válido de una cuenta borrada también muere] Mismo
    chequeo, otro caso: la fila ya no existe (DELETE /account) e is_user_active
    devuelve False. Antes de este change ese JWT seguía siendo válido hasta
    24 h — agujero preexistente que este requirement cierra de regalo."""
    fake_service = _FakeAuthService(
        tokens={"deleted-user-token": ADMIN_USER},
        inactive_users={ADMIN_USER.id},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "deleted-user-token")

    response = client.get("/protected")

    assert response.status_code == 401


def test_require_min_role_rejects_deactivated_account_with_401_not_403():
    """El bloqueo por cuenta desactivada ocurre en get_current_user(), que
    corre ANTES del chequeo de rol: un admin desactivado recibe 401 (no
    autenticado), no 403 (rol insuficiente) — el rol ya ni se evalúa."""
    fake_service = _FakeAuthService(
        tokens={"valid-admin-token": ADMIN_USER},
        inactive_users={ADMIN_USER.id},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-admin-token")

    response = client.get("/moderador-or-above")

    assert response.status_code == 401


def test_get_current_user_allows_active_account():
    """No-regresión: una cuenta activa (is_user_active -> True) sigue
    resolviendo normalmente. El chequeo nuevo no debe cambiar nada para el
    99,9% de los requests."""
    fake_service = _FakeAuthService(
        tokens={"valid-viewer-token": VIEWER_USER},
        inactive_users=set(),
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client.get("/protected")

    assert response.status_code == 200
    assert response.json()["id"] == str(VIEWER_USER.id)


# ---------------------------------------------------------------------------
# role-management (tarea 2.7) — get_current_user() SOBRESCRIBE el rol con el
# de la base. LOS TESTS QUE DECIDEN EL CHANGE.
#
# El assert es sobre el VALOR devuelto, no sobre "no tiró excepción": una
# implementación que COMPARE el rol de la base contra el del claim y levante
# 401 cuando difieren pasa cualquier test de "degradar y verificar rechazo",
# deja el agujero abierto (require_min_role() autoriza leyendo
# CurrentUser.role) y encima convierte una PROMOCIÓN en un deslogueo. Estos
# dos tests son los únicos que la matan.
# ---------------------------------------------------------------------------


def test_get_current_user_returns_role_from_database_not_from_token():
    """[Scenario: El `CurrentUser` devuelto lleva el rol de la base, no el del
    token] Token con claim `role="admin"`, base con `viewer` ⇒ el CurrentUser
    devuelto tiene `role == UserRole.VIEWER`.

    Observable sin inspeccionar la implementación: `/protected` expone el rol
    del usuario autenticado y reporta `viewer`."""
    fake_service = _FakeAuthService(
        tokens={"stale-admin-token": ADMIN_USER},
        db_roles={ADMIN_USER.id: UserRole.VIEWER},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "stale-admin-token")

    response = client.get("/protected")

    # NO 401: la sesión es perfectamente válida, lo que cambió es el rol.
    assert response.status_code == 200
    assert response.json()["role"] == UserRole.VIEWER.value


def test_demotion_is_effective_on_the_next_request():
    """[Scenario: La degradación es efectiva en el request siguiente] Token
    emitido con `role="admin"`, base degradada a `viewer` ⇒ 403 en un endpoint
    `require_min_role(MODERADOR)`. 403 y NO 401: el 401 sería la firma de la
    implementación "comparar y rechazar", que además deslogueó a alguien cuya
    sesión está viva."""
    fake_service = _FakeAuthService(
        tokens={"stale-admin-token": ADMIN_USER},
        db_roles={ADMIN_USER.id: UserRole.VIEWER},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "stale-admin-token")

    response = client.get("/moderador-or-above")

    assert response.status_code == 403
    assert "insufficient role" in response.json()["detail"]


def test_promotion_is_also_effective_on_the_next_request():
    """[Scenario: La promoción también es efectiva en el request siguiente]
    EL TEST QUE MATA LA VARIANTE "comparar y 401": token con `role="viewer"`,
    base con `moderador` ⇒ el CurrentUser sale `moderador` y
    require_min_role(MODERADOR) DEJA PASAR.

    Una implementación que compare el rol de la base contra el del claim y
    levante 401 cuando difieren devuelve 401 acá: convertiría una promoción en
    un deslogueo, y el usuario promovido quedaría afuera hasta re-loguearse."""
    fake_service = _FakeAuthService(
        tokens={"stale-viewer-token": VIEWER_USER},
        db_roles={VIEWER_USER.id: UserRole.MODERADOR},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "stale-viewer-token")

    response = client.get("/moderador-or-above")

    assert response.status_code == 200
    assert response.json()["role"] == UserRole.MODERADOR.value


def test_deactivated_account_is_401_even_when_the_database_role_is_higher():
    """El orden importa: el estado de la cuenta se evalúa igual que antes y la
    revalidación del rol NO lo debilita. Una cuenta desactivada da 401 aunque
    su rol en la base sea superior al del token."""
    fake_service = _FakeAuthService(
        tokens={"valid-viewer-token": VIEWER_USER},
        inactive_users={VIEWER_USER.id},
        db_roles={VIEWER_USER.id: UserRole.SUPERADMIN},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "valid-viewer-token")

    response = client.get("/protected")

    assert response.status_code == 401
    assert "not authenticated" in response.json()["detail"]


def test_missing_row_produces_401_when_role_is_none():
    """[Scenario: Una fila inexistente sigue produciendo 401] `role is None`
    es el contrato de "la fila no existe" (ver el docstring de UserAuthState).
    get_current_user() lo trata como 401, sin propagar un rol fantasma."""
    fake_service = _FakeAuthService(
        tokens={"deleted-user-token": ADMIN_USER},
        inactive_users={ADMIN_USER.id},
        db_roles={ADMIN_USER.id: None},
    )
    app = _build_app(fake_service)
    client = TestClient(app)
    client.cookies.set(SESSION_COOKIE_NAME, "deleted-user-token")

    response = client.get("/protected")

    assert response.status_code == 401
