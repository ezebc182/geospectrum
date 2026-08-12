"""Tests de integración de la superficie /auth/invitations* (email-invitations, 4.4).

Contrato verificado: la matriz completa de códigos de design.md Decision 3,
código por código — 401 sin sesión en los 5 endpoints protegidos, 403 por rol
insuficiente (viewer y moderador), 201/200/204 con admin y superadmin, el guard
de escalación (admin no invita superadmin, superadmin sí), y `validate` público
con su distinción 404 vs 410.

Híbrido deliberado, distinto del resto de tests/integration/:
- `invitation_service` es el REAL contra Postgres real (fixture `_migrated` de
  tests/conftest.py). Los mocks no sirven para afirmar que un 409 salga del
  estado de la base, ni que `mark-sent` escriba de verdad `email_sent_at`.
- `auth_service` sí se mockea, pero SOLO en `decode_access_token`: fabricar una
  sesión con un rol dado es justamente lo que este archivo necesita variar en
  cada test, y firmar JWTs reales no agregaría cobertura (deps.py ya está
  cubierto en tests/unit/test_deps.py).

`TestClient(app)` sin `with` (lifespan no corre) y app.state seteado a mano —
mismo patrón que test_auth_api.py.
"""

import asyncio
from unittest.mock import MagicMock
from uuid import uuid4

import asyncpg
import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.models.user import CurrentUser, UserRole
from src.services.invitation_service import InvitationService

EXPIRE_DAYS = 7

# Los 5 endpoints que exigen admin+ (validate NO está: es público a propósito).
PROTECTED_ENDPOINTS = [
    ("post", "/auth/invitations", {"email": "x@example.com", "role": "viewer"}),
    ("get", "/auth/invitations", None),
    ("delete", f"/auth/invitations/{uuid4()}", None),
    ("post", f"/auth/invitations/{uuid4()}/resend", None),
    ("post", f"/auth/invitations/{uuid4()}/mark-sent", None),
]


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """app es un singleton module-level: sin esto, el estado que mutó un test
    se filtra al siguiente (mismo fixture que test_auth_api.py)."""
    yield
    for key in ("auth_service", "invitation_service", "google_oauth_enabled"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


class _LazyPool:
    """Proxy de asyncpg.Pool que se crea en el PRIMER uso, no en el fixture.

    Por qué existe: `TestClient` corre la app en SU PROPIO event loop (uno por
    request, vía portal de anyio), distinto del loop de pytest-asyncio donde
    vive el fixture `db_pool`. Un pool de asyncpg está atado al loop que lo
    creó; compartirlo entre ambos revienta con "another operation is in
    progress" / "connection was closed in the middle of operation" —
    verificado, no supuesto.

    La solución es que el pool que usa el servicio NAZCA dentro del loop del
    request. `acquire()` es el único método que el InvitationService usa, y es
    donde se hace el lazy-init: para cuando se ejecuta, ya estamos en el loop
    correcto. Se guarda un pool por loop porque cada request de TestClient
    estrena uno.
    """

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pools: dict[int, asyncpg.Pool] = {}

    def acquire(self):
        loop = asyncio.get_event_loop()
        key = id(loop)

        class _AcquireCtx:
            def __init__(ctx_self, outer):
                ctx_self._outer = outer
                ctx_self._inner = None

            async def __aenter__(ctx_self):
                pool = ctx_self._outer._pools.get(key)
                if pool is None:
                    pool = await asyncpg.create_pool(ctx_self._outer._dsn, min_size=1, max_size=4)
                    ctx_self._outer._pools[key] = pool
                ctx_self._inner = pool.acquire()
                return await ctx_self._inner.__aenter__()

            async def __aexit__(ctx_self, *exc):
                return await ctx_self._inner.__aexit__(*exc)

        return _AcquireCtx(self)

    async def aclose_all(self) -> None:
        for pool in self._pools.values():
            await pool.close()
        self._pools.clear()


@pytest.fixture
def seeded(_migrated):
    """Usuarios reales de cada rol (vía psycopg2, síncrono) + el
    InvitationService real publicado en app.state sobre un `_LazyPool`.

    Los usuarios son filas de verdad porque `invited_by` es una FK contra
    users(id): con uuid4() inventados el INSERT reventaría — el tipo de detalle
    que sólo aparece contra una base real.

    Síncrono a propósito: sembrar con psycopg2 evita mezclar el loop de
    pytest-asyncio con el de TestClient (ver docstring de _LazyPool). La
    limpieza también es síncrona por la misma razón; `db_pool` no se usa acá.
    """
    import psycopg2

    users = {}
    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for role in (
                UserRole.SUPERADMIN,
                UserRole.ADMIN,
                UserRole.MODERADOR,
                UserRole.VIEWER,
            ):
                cur.execute(
                    "INSERT INTO users (email, password_hash, role) VALUES (%s, %s, %s) "
                    "RETURNING id, email, role",
                    (f"{role.value}@example.com", "$2b$12$hash-irrelevante", role.value),
                )
                row = cur.fetchone()
                users[role] = CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()

    lazy_pool = _LazyPool(_migrated)
    app.state.invitation_service = InvitationService(pool=lazy_pool, expire_days=EXPIRE_DAYS)
    yield users

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM invitations")
            cur.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _fetch_invitation_column(dsn: str, invitation_id, column: str):
    """Lectura directa de una columna de `invitations` (psycopg2, síncrono).

    Los asserts contra la BASE son el punto de estos tests — un 204 no prueba
    que `email_sent_at` se haya escrito. Se usa psycopg2 y no asyncpg por el
    mismo motivo de loops que documenta _LazyPool.
    """
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {column} FROM invitations WHERE id = %s", (str(invitation_id),))
            row = cur.fetchone()
    finally:
        conn.close()
    return row[0] if row else None


def _update_invitation(dsn: str, invitation_id, set_clause: str) -> None:
    """UPDATE directo para simular estados (aceptada/expirada) sin depender de
    endpoints que no existen (nadie 'acepta' una invitación por HTTP: eso lo
    hace el registro)."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute(f"UPDATE invitations SET {set_clause} WHERE id = %s", (str(invitation_id),))
    finally:
        conn.close()


def _login_as(user: CurrentUser, client: TestClient) -> None:
    """Simula una sesión válida del rol pedido: el cookie es opaco y el fake de
    `decode_access_token` es quien decide la identidad."""
    fake_auth_service = MagicMock()
    fake_auth_service.decode_access_token = MagicMock(return_value=user)
    app.state.auth_service = fake_auth_service
    client.cookies.set("session", "fake-session-jwt")


def _logout(client: TestClient) -> None:
    app.state.auth_service = MagicMock()
    client.cookies.clear()


def _create_invitation(client, email: str, role: str = "viewer") -> dict:
    response = client.post("/auth/invitations", json={"email": email, "role": role})
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# 401 — sin sesión
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("method,path,body", PROTECTED_ENDPOINTS)
def test_protected_endpoints_without_session_return_401(client, seeded, method, path, body):
    """[Scenario: Sin sesión no se puede crear invitación] — extendido a los 5
    endpoints protegidos: ninguno debe atender sin cookie."""
    _logout(client)

    response = getattr(client, method)(path, **({"json": body} if body else {}))

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# 403 — rol insuficiente
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", [UserRole.VIEWER, UserRole.MODERADOR])
@pytest.mark.parametrize("method,path,body", PROTECTED_ENDPOINTS)
def test_protected_endpoints_with_insufficient_role_return_403(
    client, seeded, role, method, path, body
):
    """[Scenario: Un viewer o moderador no puede crear invitaciones] y
    [Scenario: Un viewer no puede listar] — require_min_role(ADMIN) corta ANTES
    de que el servicio vea nada."""
    _login_as(seeded[role], client)

    response = getattr(client, method)(path, **({"json": body} if body else {}))

    assert response.status_code == 403


def test_viewer_cannot_list_invitations_and_sees_no_data(client, seeded, _migrated):
    """El 403 del listado no debe filtrar NADA del contenido: se siembra una
    invitación real y se confirma que su email no aparece en el body del
    rechazo."""
    _login_as(seeded[UserRole.ADMIN], client)
    _create_invitation(client, "secreta@example.com")

    _login_as(seeded[UserRole.VIEWER], client)
    response = client.get("/auth/invitations")

    assert response.status_code == 403
    assert "secreta@example.com" not in response.text


# ---------------------------------------------------------------------------
# POST /auth/invitations — 201 y guard de escalación
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("role", [UserRole.ADMIN, UserRole.SUPERADMIN])
def test_admin_and_superadmin_can_create_invitation(client, seeded, role):
    """201 con el token en claro — la ÚNICA vez que el sistema lo devuelve."""
    _login_as(seeded[role], client)

    response = client.post(
        "/auth/invitations", json={"email": "nueva@example.com", "role": "viewer"}
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "nueva@example.com"
    assert body["role"] == "viewer"
    assert body["status"] == "pending"
    assert body["token"]
    assert body["email_sent_at"] is None


def test_admin_cannot_invite_superadmin_403(client, seeded):
    """[Scenario: Un admin no puede invitar con rol superadmin] — sin este
    guard un admin se fabrica un superadmin por interpósita invitación."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(
        "/auth/invitations", json={"email": "escalada@example.com", "role": "superadmin"}
    )

    assert response.status_code == 403
    assert response.json() == {"error": "cannot invite a role higher than your own"}


def test_superadmin_can_invite_superadmin_201(client, seeded):
    """El guard compara niveles: mismo nivel está permitido."""
    _login_as(seeded[UserRole.SUPERADMIN], client)

    response = client.post(
        "/auth/invitations", json={"email": "otro-super@example.com", "role": "superadmin"}
    )

    assert response.status_code == 201
    assert response.json()["role"] == "superadmin"


def test_create_invitation_for_existing_account_returns_409(client, seeded):
    """El email `viewer@example.com` ya tiene cuenta (fixture `seeded`)."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(
        "/auth/invitations", json={"email": "viewer@example.com", "role": "viewer"}
    )

    assert response.status_code == 409
    assert response.json() == {"error": "email already registered"}


def test_create_duplicate_pending_invitation_returns_409(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)
    _create_invitation(client, "duplicada@example.com")

    response = client.post(
        "/auth/invitations", json={"email": "duplicada@example.com", "role": "viewer"}
    )

    assert response.status_code == 409
    assert "resend" in response.json()["error"]


def test_create_invitation_with_unknown_role_returns_422(client, seeded):
    """Pydantic corta antes del servicio: `role` es el enum existente."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(
        "/auth/invitations", json={"email": "x@example.com", "role": "emperador"}
    )

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# GET /auth/invitations — listado
# ---------------------------------------------------------------------------


def test_list_invitations_returns_state_and_never_tokens(client, seeded):
    """[Requirement: Listado de invitaciones con estado] + [Scenario: El
    listado no expone tokens] — el token creado no aparece en NINGÚN lado del
    body del listado."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "listada@example.com", "moderador")

    response = client.get("/auth/invitations")

    assert response.status_code == 200
    items = response.json()
    assert len(items) == 1
    assert items[0]["email"] == "listada@example.com"
    assert items[0]["role"] == "moderador"
    assert items[0]["status"] == "pending"
    assert "token" not in items[0]
    assert "token_hash" not in items[0]
    assert created["token"] not in response.text


# ---------------------------------------------------------------------------
# DELETE /auth/invitations/{id} — revocar
# ---------------------------------------------------------------------------


def test_revoke_invitation_returns_204_and_marks_it_revoked(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "a-revocar@example.com")

    response = client.delete(f"/auth/invitations/{created['id']}")

    assert response.status_code == 204
    listed = client.get("/auth/invitations").json()
    assert listed[0]["status"] == "revoked"


def test_revoke_unknown_invitation_returns_404(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.delete(f"/auth/invitations/{uuid4()}")

    assert response.status_code == 404
    assert response.json() == {"error": "invitation not found"}


def test_revoke_accepted_invitation_returns_409(client, seeded, _migrated):
    """Revocar una consumida no des-crea al usuario: rechazo explícito, no un
    no-op engañoso (Decision 3)."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "aceptada@example.com")
    _update_invitation(_migrated, created["id"], "accepted_at = now()")

    response = client.delete(f"/auth/invitations/{created['id']}")

    assert response.status_code == 409
    assert response.json() == {"error": "invitation already accepted"}


# ---------------------------------------------------------------------------
# POST /auth/invitations/{id}/resend
# ---------------------------------------------------------------------------


def test_resend_returns_200_with_a_brand_new_token(client, seeded):
    """El link anterior queda muerto en el mismo acto (el hash se pisa)."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "reenvio@example.com")

    response = client.post(f"/auth/invitations/{created['id']}/resend")

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == created["id"]
    assert body["token"] != created["token"]
    assert body["email_sent_at"] is None
    # El token viejo ya no valida (404: su hash fue pisado, no existe fila).
    _logout(client)
    assert (
        client.get("/auth/invitations/validate", params={"token": created["token"]}).status_code
        == 404
    )


def test_resend_unknown_invitation_returns_404(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/invitations/{uuid4()}/resend")

    assert response.status_code == 404


def test_resend_revoked_invitation_returns_409(client, seeded):
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "revocada@example.com")
    client.delete(f"/auth/invitations/{created['id']}")

    response = client.post(f"/auth/invitations/{created['id']}/resend")

    assert response.status_code == 409


def test_resend_accepted_invitation_returns_409(client, seeded, _migrated):
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "usada@example.com")
    _update_invitation(_migrated, created["id"], "accepted_at = now()")

    response = client.post(f"/auth/invitations/{created['id']}/resend")

    assert response.status_code == 409


# ---------------------------------------------------------------------------
# POST /auth/invitations/{id}/mark-sent
# ---------------------------------------------------------------------------


def test_mark_sent_returns_204_and_sets_email_sent_at(client, seeded, _migrated):
    """Confirmación de envío (Decision 4): la escribe la route de Next con la
    cookie del admin. Se verifica contra la BASE, no solo por el 204."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "confirmada@example.com")

    response = client.post(f"/auth/invitations/{created['id']}/mark-sent")

    assert response.status_code == 204
    assert _fetch_invitation_column(_migrated, created["id"], "email_sent_at") is not None
    assert client.get("/auth/invitations").json()[0]["email_sent_at"] is not None


def test_mark_sent_unknown_invitation_returns_404(client, seeded):
    """El `UPDATE 0` debe traducirse a 404 (no un 204 mentiroso)."""
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/auth/invitations/{uuid4()}/mark-sent")

    assert response.status_code == 404


# ---------------------------------------------------------------------------
# GET /auth/invitations/validate — PÚBLICO
# ---------------------------------------------------------------------------


def test_validate_is_reachable_without_any_cookie(client, seeded):
    """[Requirement: Validación pública] — la página /invite/[token] la consume
    ANTES de que exista sesión alguna. Sin cookie debe responder 200, no 401."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "publica@example.com", "moderador")

    _logout(client)
    response = client.get("/auth/invitations/validate", params={"token": created["token"]})

    assert response.status_code == 200
    body = response.json()
    assert body["email"] == "publica@example.com"
    assert body["role"] == "moderador"
    assert "expires_at" in body
    # NUNCA devuelve el token ni el hash de vuelta.
    assert "token" not in body


def test_validate_unknown_token_returns_404(client, seeded):
    _logout(client)

    response = client.get("/auth/invitations/validate", params={"token": "token-que-no-existe"})

    assert response.status_code == 404
    assert response.json() == {"error": "invalid invitation"}


def test_validate_revoked_token_returns_410(client, seeded):
    """404 vs 410 es deliberado (Decision 3, que gana sobre la spec): la UX
    distingue "link inválido" de "vencido — pedí un reenvío"."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "revocada-validate@example.com")
    client.delete(f"/auth/invitations/{created['id']}")

    _logout(client)
    response = client.get("/auth/invitations/validate", params={"token": created["token"]})

    assert response.status_code == 410
    assert response.json() == {"error": "invitation no longer valid"}


def test_validate_expired_token_returns_410(client, seeded, _migrated):
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "vencida-validate@example.com")
    _update_invitation(_migrated, created["id"], "expires_at = now() - interval '1 day'")

    _logout(client)
    response = client.get("/auth/invitations/validate", params={"token": created["token"]})

    assert response.status_code == 410


def test_validate_accepted_token_returns_410(client, seeded, _migrated):
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "aceptada-validate@example.com")
    _update_invitation(_migrated, created["id"], "accepted_at = now()")

    _logout(client)
    response = client.get("/auth/invitations/validate", params={"token": created["token"]})

    assert response.status_code == 410


def test_validate_without_token_param_returns_422(client, seeded):
    _logout(client)

    response = client.get("/auth/invitations/validate")

    assert response.status_code == 422


def test_validate_does_not_consume_the_invitation(client, seeded):
    """[Scenario: La validación no consume] — a nivel HTTP: N GET consecutivos
    siguen dando 200 y la invitación sigue `pending` en el listado."""
    _login_as(seeded[UserRole.ADMIN], client)
    created = _create_invitation(client, "no-consume@example.com")

    _logout(client)
    for _ in range(4):
        assert (
            client.get("/auth/invitations/validate", params={"token": created["token"]}).status_code
            == 200
        )

    _login_as(seeded[UserRole.ADMIN], client)
    assert client.get("/auth/invitations").json()[0]["status"] == "pending"
