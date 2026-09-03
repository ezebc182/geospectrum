# Exploration: feedback-beta-testers

## Current State

### Autenticación y admin (estado REAL en código, verificado)

- **Roles jerárquicos ya implementados y en uso**: `src/models/user.py` define `UserRole` (superadmin=3, admin=2, moderador=1, viewer=0) con `ROLE_LEVEL`/`role_level()`. No es "Fase 1 a medias": el sistema completo está operativo.
- **Dependencias reusables en `src/api/deps.py`**: `get_current_user` (cookie `session` + JWT + round-trip a la base que trae rol y estado de cuenta FRESCOS — el rol del token se sobrescribe con el de la base), `get_current_user_optional`, `require_role()` (igualdad exacta) y `require_min_role()` (jerárquico). El patrón establecido para endpoints de admin es `Depends(require_min_role(UserRole.ADMIN))` — hay ~10 endpoints en `src/main.py` que ya lo usan (gestión de users, beta-signups, invitations).
- **Frontend**: `dashboard/components/AppSidebar.tsx` tiene `ADMIN_ROLES = ['admin', 'superadmin']` y un bloque `adminRoutes` que solo se renderiza si `user.role` está en esa lista, con el comentario explícito de que el gate real vive en el backend (`require_min_role`); lo del sidebar es solo no mostrar. Páginas admin existentes: `dashboard/app/(app)/admin/{access,invitations,users}/`.
- **Estado en prod** (memoria de auditoría 2026-08-17, no re-verificable desde acá): 4 cuentas, cero admins; superadmin solo local. Esto es una **dependencia de rollout**: la vista admin de feedback será inalcanzable en prod hasta promover al menos una cuenta a admin (la UI de `/admin/users` ya permite cambiar roles).

### Migraciones

- 18 migraciones en `deploy/sql/migrations/` (más 2 en `db/migrations/`), auto-aplicadas al arranque por `scripts/apply_migrations.py` (gateado por `RUN_MIGRATIONS_ON_STARTUP`): **idempotentes por convención** (`CREATE ... IF NOT EXISTS`), sin Alembic ni tabla de versiones, con `pg_advisory_lock` contra réplicas concurrentes. Una migración nueva es solo un archivo `019_*.sql` idempotente.
- Precedente de modelado directo: `017_window_comments.sql` — tabla con `id UUID`, `user_id` FK a `users` con `ON DELETE CASCADE`, `body TEXT` con `CHECK (char_length ...)`, `created_at` con default. Y el criterio de estados de `beta_signups`: **timestamps, no columnas de estado** ("`approved_at`... no columnas de estado que puedan desincronizarse", `src/models/beta.py`).

### Endpoints FastAPI

Dos patrones conviven:
1. Inline en `src/main.py` (beta-signups, gestión de users) — justificado ahí para no partir el dominio auth en dos lugares.
2. **`APIRouter` en `src/api/routers/`** (areas, comments, picks, stations, walls) — `src/api/routers/comments.py` es el molde exacto para esta feature: router + service resuelto desde `request.app.state.*` (seteado en el lifespan de `main.py`), modelos Pydantic en `src/models/`, service con SQL en `src/services/`.

### Dashboard (App Router)

- **El lugar del widget global es `dashboard/app/(app)/layout.tsx`** — precedente directo y documentado en el propio archivo: `OnboardingGate` (wizard global), `LiveEventsProvider`, `NotificationBell`. La lección "lo global va en el layout" ya está pagada.
- Cliente API: `dashboard/lib/api.ts` (`SeismicAPI`, `credentials: 'include'` obligatorio para que viaje la cookie `session` cross-origin) y helpers por dominio en `dashboard/lib/*.ts`.
- i18n con `useTranslations` (next-intl): los strings del widget y de la vista admin deben ir en es/en como el resto.
- Contexto técnico capturable desde el cliente sin infraestructura nueva: `usePathname()`/`window.location.href` (las URLs de share ya codifican canal y ventana en query params, así que capturar la URL completa cubre "canal o ventana abierta si aplica"), `navigator.userAgent`. El timestamp lo pone el server (`now()` en la base) — el del cliente no es confiable.

### Anti-spam (honeypot + rate limit de la landing)

`POST /beta-signups` (`src/main.py:905`) usa honeypot (`website` en `BetaSignupRequest`) + rate limit por IP en Redis **porque es un endpoint PÚBLICO y anónimo**. El endpoint de feedback será autenticado (`get_current_user`): el honeypot no aplica (no hay bots con sesión válida) y el rate limit es de valor marginal con ~4 cuentas beta conocidas. No corresponde copiar ese patrón acá; basta el `CHECK` de longitud en la base + validación Pydantic.

## Affected Areas

- `deploy/sql/migrations/019_feedback_reports.sql` — tabla nueva (patrón 017 + criterio de timestamps de beta_signups)
- `src/models/feedback.py` — modelos Pydantic (patrón `src/models/window_comment.py` / `beta.py`)
- `src/services/feedback_service.py` — SQL + lógica (patrón `window_comments.py`)
- `src/api/routers/feedback.py` — router nuevo (patrón `comments.py`), registrado en `src/main.py` + service en `app.state` en el lifespan
- `dashboard/app/(app)/layout.tsx` — montaje del widget flotante global
- `dashboard/components/` — componente del widget (botón flotante + dialog)
- `dashboard/app/(app)/admin/feedback/page.tsx` — vista admin nueva
- `dashboard/components/AppSidebar.tsx` — entrada en `adminRoutes`
- `dashboard/lib/` — helper de API del dominio feedback + tests
- Mensajes i18n es/en del dashboard

## Approaches

1. **Router dedicado + tabla propia (recomendado)** — `feedback.py` router siguiendo `comments.py`, tabla `feedback_reports` con `resolved_at` timestamp.
   - Pros: patrón ya establecido 5 veces; aislado del dominio auth; migración aditiva idempotente; rollback trivial.
   - Cons: ninguno relevante.
   - Effort: Low-Medium.

2. **Endpoints inline en `main.py`** (como beta-signups).
   - Pros: consistente con los endpoints admin existentes.
   - Cons: `main.py` ya tiene ~1800 líneas; el argumento de "no partir el dominio auth" no aplica a feedback, que es dominio propio; los routers son el patrón más nuevo del repo.
   - Effort: Low.

3. **Reusar `window_comments`** con un canal sintético.
   - Pros: cero migración.
   - Cons: abuso semántico (sin tipo, sin resolved, lectura colaborativa cuando acá debe ser solo-admin); descartado.
   - Effort: Low pero deuda inmediata.

## Recommendation

Approach 1. Todo el andamiaje existe; el change es chico y calcado de precedentes: migración 019 idempotente, router + service + modelos, widget en el layout, página admin gateada por `require_min_role(ADMIN)` en backend y `ADMIN_ROLES` en sidebar.

## Risks

- Cero admins en prod: la vista admin queda inalcanzable hasta promover una cuenta (acción del usuario, la UI ya existe).
- Capturas de pantalla: almacenar blobs en TimescaleDB es riesgo real (incidente de disco lleno 2026-08-28) y no hay object storage en el stack → fuera de v1 con justificación.
- El "contexto técnico" automático depende de que la URL codifique el estado (canal/ventana) — cierto para las vistas con share URL, parcial para otras; el proposal debe prometer URL + pathname, no "estado completo de la app".

## Ready for Proposal

Yes — alcance ya fijado por el usuario, precedentes claros para cada pieza, sin incógnitas técnicas abiertas.

---

## Addendum 2026-09-03 — cambio de alcance

El usuario amplió el alcance ANTES de escribir código: de canal binario solo-admin (abierto/resuelto por `resolved_at`) a **tablero Kanban de 5 estados** (`Nuevo → En análisis → En progreso → Hecho`, más `Descartado` terminal aparte), **visible en solo-lectura para todos los testers** (columna + autor por email, criterio `author_email` de `window_comments`), con drag & drop solo para admin (`require_min_role(ADMIN)`, `src/api/deps.py:219`) y **un** comentario opcional y editable del admin por tarjeta.

Verificado para esta ampliación: `@dnd-kit/{core,sortable,utilities}` ya está en `dashboard/package.json` (walls) — cero dependencias nuevas. El criterio "timestamps, no columnas de estado" de `src/models/beta.py` fue pensado para un estado binario y debe rediscutirse en el design para 5 estados con transiciones. El proposal.md es la fuente vigente; `specs/`, `design.md` y `tasks.md` de este change quedaron DESACTUALIZADOS y deben regenerarse.
