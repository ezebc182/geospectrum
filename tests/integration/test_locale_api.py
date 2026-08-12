"""Tests de integración del locale (i18n-dashboard, Fase 1, tarea 1.8b).

Cubre por nombre los escenarios de specs/account-settings y specs/auth del
change: PATCH/GET de `users.locale` vía /account/profile, la captura del
locale en POST /beta-signups y su propagación en el approve (invitación +
email), todo CONTRA POSTGRES REAL (memoria del proyecto: verificar contra la
base, no con mocks — un 201 no prueba que la fila tenga el locale correcto).

Híbrido, mismo patrón que test_invitations_api.py:
- `auth_service` es el REAL (get_profile/update_profile pegan a la base) con
  SOLO `decode_access_token` reemplazado en la instancia: fabricar la sesión
  es lo único que se necesita variar, y firmar JWTs no agrega cobertura.
- `app.state.db_pool` es un `_LazyPool` (el pool nace en el loop del request
  de TestClient, no en el de pytest-asyncio — ver test_invitations_api.py).
- `email_service` es un mock: acá se afirma CON QUÉ locale se lo llama; el
  contenido de los templates ya está cubierto en test_locale_models.py.
- El Redis del rate limit se reemplaza por un fake permisivo para que un
  Redis local real no acumule intentos y meta 429 espurios entre tests.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import asyncpg
import pytest
from fastapi.testclient import TestClient

import src.main as main_module
from src.main import app
from src.models.user import CurrentUser, MeResponse, UserRole
from src.services.auth_service import AuthService


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture(autouse=True)
def _reset_app_state():
    """app es un singleton module-level: sin esto, el estado que mutó un test
    se filtra al siguiente (mismo fixture que test_invitations_api.py)."""
    yield
    for key in ("auth_service", "db_pool", "email_service", "google_oauth_enabled"):
        if hasattr(app.state, key):
            del app.state._state[key]
    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def _permissive_rate_limit_redis(monkeypatch):
    """El rate limit de /beta-signups usa el Redis module-level de main. Con
    un Redis local real escuchando en 6379, los POST de esta suite sumarían
    al presupuesto 5/hora y el sexto daría 429. El fake siempre responde 1."""
    fake_redis = MagicMock()
    fake_redis.incr = AsyncMock(return_value=1)
    fake_redis.expire = AsyncMock(return_value=True)
    monkeypatch.setattr(main_module, "totp_login_attempt_redis", fake_redis)
    return fake_redis


class _LazyPool:
    """Proxy de asyncpg.Pool creado en el PRIMER uso, dentro del loop del
    request de TestClient (ver docstring largo en test_invitations_api.py).
    Suma `fetchrow`/`fetch` porque los endpoints de beta usan el pool directo,
    no solo `acquire()`."""

    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pools: dict[int, asyncpg.Pool] = {}

    async def _get_pool(self) -> asyncpg.Pool:
        key = id(asyncio.get_event_loop())
        pool = self._pools.get(key)
        if pool is None:
            pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=4)
            self._pools[key] = pool
        return pool

    async def fetchrow(self, query: str, *args):
        return await (await self._get_pool()).fetchrow(query, *args)

    async def fetch(self, query: str, *args):
        return await (await self._get_pool()).fetch(query, *args)

    def acquire(self):
        outer = self

        class _AcquireCtx:
            def __init__(ctx_self):
                ctx_self._inner = None

            async def __aenter__(ctx_self):
                pool = await outer._get_pool()
                ctx_self._inner = pool.acquire()
                return await ctx_self._inner.__aenter__()

            async def __aexit__(ctx_self, *exc):
                return await ctx_self._inner.__aexit__(*exc)

        return _AcquireCtx()


@pytest.fixture
def seeded(_migrated):
    """Un usuario por rol (psycopg2, síncrono — ver test_invitations_api.py),
    el AuthService REAL y el pool lazy publicados en app.state, y un
    email_service mockeado para afirmar los locale con que se lo invoca."""
    import psycopg2

    users = {}
    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for role in (UserRole.ADMIN, UserRole.VIEWER):
                cur.execute(
                    "INSERT INTO users (email, password_hash, role, full_name) "
                    "VALUES (%s, %s, %s, %s) RETURNING id, email, role",
                    (f"{role.value}@example.com", "$2b$12$hash-irrelevante", role.value, "Ana"),
                )
                row = cur.fetchone()
                users[role] = CurrentUser(id=row[0], email=row[1], role=UserRole(row[2]))
    finally:
        conn.close()

    lazy_pool = _LazyPool(_migrated)
    auth_service = AuthService(
        dsn=_migrated,
        secret_key="secreto-de-test",
        token_expire_minutes=30,
        pool=lazy_pool,  # type: ignore[arg-type]
    )
    app.state.auth_service = auth_service
    app.state.db_pool = lazy_pool

    email_service = MagicMock()
    email_service.send_beta_signup_emails = AsyncMock()
    email_service.send_beta_approved_email = AsyncMock()
    app.state.email_service = email_service

    yield users

    conn = psycopg2.connect(_migrated)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM invitations")
            cur.execute("DELETE FROM beta_signups")
            cur.execute("DELETE FROM areas_of_interest WHERE NOT is_system")
            cur.execute("DELETE FROM users")
    finally:
        conn.close()


def _login_as(user: CurrentUser, client: TestClient) -> None:
    """Sesión fabricada: la cookie es opaca y los fakes de decode deciden la
    identidad — el resto del AuthService sigue siendo el real. Se reemplazan
    AMBOS pasos de get_current_user: el payload crudo (guard de pending_2fa)
    y el CurrentUser final."""
    app.state.auth_service.decode_token_payload = MagicMock(
        return_value={"sub": str(user.id), "email": user.email, "role": user.role.value}
    )
    app.state.auth_service.decode_access_token = MagicMock(return_value=user)
    client.cookies.set("session", "fake-session-jwt")


def _fetch_one(dsn: str, query: str, *params):
    """Lectura directa contra la base (psycopg2, síncrono): los asserts sobre
    filas reales son el punto de este archivo."""
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchone()
    finally:
        conn.close()


def _fetch_all(dsn: str, query: str, *params):
    import psycopg2

    conn = psycopg2.connect(dsn)
    try:
        with conn.cursor() as cur:
            cur.execute(query, params)
            return cur.fetchall()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# GET/PATCH /account/profile — specs/account-settings
# ---------------------------------------------------------------------------


def test_preexisting_account_has_null_locale(client, seeded):
    """[Scenario: Cuenta preexistente sin preferencia] — un usuario que nunca
    eligió idioma devuelve locale null, sin error alguno."""
    _login_as(seeded[UserRole.VIEWER], client)

    response = client.get("/account/profile")

    assert response.status_code == 200
    assert response.json()["locale"] is None


def test_patch_locale_persists_and_get_returns_it(client, seeded, _migrated):
    """[Scenario: Guardar la preferencia en inglés] — PATCH {locale:'en'}
    persiste en users.locale, el GET posterior lo devuelve y el resto del
    perfil (full_name sembrado) queda intacto."""
    user = seeded[UserRole.VIEWER]
    _login_as(user, client)

    patch = client.patch("/account/profile", json={"locale": "en"})

    assert patch.status_code == 200
    assert patch.json()["locale"] == "en"

    got = client.get("/account/profile")
    assert got.status_code == 200
    assert got.json()["locale"] == "en"
    assert got.json()["full_name"] == "Ana"

    row = _fetch_one(_migrated, "SELECT locale FROM users WHERE id = %s", str(user.id))
    assert row == ("en",)


def test_patch_other_fields_does_not_touch_locale(client, seeded, _migrated):
    """[Scenario: PATCH de otros campos no pisa la preferencia] — un PATCH
    sin `locale` actualiza lo suyo y deja la preferencia guardada intacta."""
    user = seeded[UserRole.VIEWER]
    _login_as(user, client)
    assert client.patch("/account/profile", json={"locale": "en"}).status_code == 200

    response = client.patch("/account/profile", json={"full_name": "Nueva Firma"})

    assert response.status_code == 200
    assert response.json()["full_name"] == "Nueva Firma"
    assert response.json()["locale"] == "en"
    row = _fetch_one(_migrated, "SELECT locale FROM users WHERE id = %s", str(user.id))
    assert row == ("en",)


def test_patch_unsupported_locale_returns_422_without_modifying(client, seeded, _migrated):
    """[Scenario: Valor no soportado es rechazado] — 'fr' responde 422 y la
    preferencia guardada no se toca (a diferencia del fallback tolerante del
    endpoint público de beta)."""
    user = seeded[UserRole.VIEWER]
    _login_as(user, client)
    assert client.patch("/account/profile", json={"locale": "en"}).status_code == 200

    response = client.patch("/account/profile", json={"locale": "fr"})

    assert response.status_code == 422
    assert client.get("/account/profile").json()["locale"] == "en"
    row = _fetch_one(_migrated, "SELECT locale FROM users WHERE id = %s", str(user.id))
    assert row == ("en",)


def test_locale_never_travels_in_session_shapes():
    """[Scenario: El locale no viaja en el JWT ni en /auth/me] — garantía de
    shape, el mismo criterio de diseño de tipos del proyecto: CurrentUser (la
    fuente de los claims del JWT) y MeResponse (el response_model de
    /auth/me) no declaran `locale`, así que ningún serializer puede colarlo."""
    assert "locale" not in CurrentUser.model_fields
    assert "locale" not in MeResponse.model_fields


# ---------------------------------------------------------------------------
# POST /beta-signups — specs/auth (captura del locale)
# ---------------------------------------------------------------------------


def test_beta_signup_in_english_persists_the_locale(client, seeded, _migrated):
    """[Scenario: Alta desde la landing en inglés persiste el locale] — 201
    anti-enumeración de siempre, fila con locale='en' y confirmación enviada
    en ese idioma."""
    response = client.post("/beta-signups", json={"email": "fan@example.com", "locale": "en"})

    assert response.status_code == 201
    assert response.json() == {"ok": True}
    row = _fetch_one(
        _migrated, "SELECT locale FROM beta_signups WHERE email = %s", "fan@example.com"
    )
    assert row == ("en",)
    app.state.email_service.send_beta_signup_emails.assert_awaited_once_with(
        "fan@example.com", "en"
    )


def test_beta_signup_without_or_invalid_locale_falls_back_to_spanish(client, seeded, _migrated):
    """[Scenario: Caller sin locale o con valor inválido cae a español] —
    ninguna de las dos variantes produce 400/422; ambas filas quedan 'es'."""
    without = client.post("/beta-signups", json={"email": "sin@example.com"})
    invalid = client.post("/beta-signups", json={"email": "raro@example.com", "locale": "xx"})

    assert without.status_code == 201
    assert invalid.status_code == 201
    rows = _fetch_all(
        _migrated,
        "SELECT email, locale FROM beta_signups WHERE email IN (%s, %s) ORDER BY email",
        "sin@example.com",
        "raro@example.com",
    )
    assert rows == [("raro@example.com", "es"), ("sin@example.com", "es")]


def test_beta_repost_does_not_override_original_locale(client, seeded, _migrated):
    """[Scenario: El repost no pisa el locale original] — el segundo POST del
    mismo email responde el mismo 201, conserva 'en' y no reenvía emails
    (comportamiento de repost existente)."""
    assert (
        client.post("/beta-signups", json={"email": "fan@example.com", "locale": "en"}).status_code
        == 201
    )
    app.state.email_service.send_beta_signup_emails.reset_mock()

    repost = client.post("/beta-signups", json={"email": "fan@example.com", "locale": "es"})

    assert repost.status_code == 201
    assert repost.json() == {"ok": True}
    row = _fetch_one(
        _migrated, "SELECT locale FROM beta_signups WHERE email = %s", "fan@example.com"
    )
    assert row == ("en",)
    app.state.email_service.send_beta_signup_emails.assert_not_awaited()


# ---------------------------------------------------------------------------
# POST /beta-signups/{id}/approve — specs/auth (herencia del locale)
# ---------------------------------------------------------------------------


def _signup_id(dsn: str, email: str):
    row = _fetch_one(dsn, "SELECT id FROM beta_signups WHERE email = %s", email)
    assert row is not None
    return row[0]


def test_approving_an_english_signup_creates_an_english_invitation(client, seeded, _migrated):
    """[Scenario: Aprobación de un signup EN produce invitación EN] — la
    invitación creada hereda locale='en' (no el default 'es'), con rol viewer,
    y el email de aprobación sale en ese idioma."""
    assert (
        client.post("/beta-signups", json={"email": "fan@example.com", "locale": "en"}).status_code
        == 201
    )
    _login_as(seeded[UserRole.ADMIN], client)

    response = client.post(f"/beta-signups/{_signup_id(_migrated, 'fan@example.com')}/approve")

    assert response.status_code == 200
    assert response.json() == {"ok": True, "already_approved": False}
    invitation = _fetch_one(
        _migrated, "SELECT locale, role FROM invitations WHERE lower(email) = %s", "fan@example.com"
    )
    assert invitation == ("en", "viewer")
    app.state.email_service.send_beta_approved_email.assert_awaited_once_with(
        "fan@example.com", "en"
    )


def test_reapproving_does_not_mutate_the_existing_invitation(client, seeded, _migrated):
    """[Scenario: Re-aprobar no muta la invitación existente] — el segundo
    approve responde already_approved, no crea una segunda invitación y el
    locale de la pendiente queda intacto."""
    assert (
        client.post("/beta-signups", json={"email": "fan@example.com", "locale": "en"}).status_code
        == 201
    )
    _login_as(seeded[UserRole.ADMIN], client)
    signup_id = _signup_id(_migrated, "fan@example.com")
    assert client.post(f"/beta-signups/{signup_id}/approve").status_code == 200

    reapprove = client.post(f"/beta-signups/{signup_id}/approve")

    assert reapprove.status_code == 200
    assert reapprove.json() == {"ok": True, "already_approved": True}
    invitations = _fetch_all(
        _migrated, "SELECT locale FROM invitations WHERE lower(email) = %s", "fan@example.com"
    )
    assert invitations == [("en",)]
