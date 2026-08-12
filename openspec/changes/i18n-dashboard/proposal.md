# Proposal: i18n completo del dashboard (ES/EN)

## Intent

El dashboard Next (`dashboard/app/(app)`, `components/`, `lib/`) está 100% en español hardcodeado, pero los invitados a la beta pueden ser angloparlantes (decisión del usuario, 2026-08-12). El sistema ya es bilingüe en sus bordes — landing pública (`lib/landing-i18n.ts`), página `/invite` (`lib/invite-i18n.ts`) y emails de invitación (por `invitations.locale`) — pero un invitado EN que acepta su invitación en inglés aterriza en una app entera en español. Este change internacionaliza TODO el dashboard autenticado a ES/EN.

Evidencia del inventario (ver `exploration.md` para la metodología):

- **~45 archivos** con strings user-facing en español; **~350-450 claves** de traducción estimadas.
- Concentración: panel admin de invitaciones (26 strings acentuados), filtros (FilterPanel 19, EventFiltersBar 15), AreaSelector (17), dashboard principal (15), settings/2FA (14), mapas (AdvancedSeismicMap 14, SeismicMapWithCities 13), login (11), onboarding wizard + tour (~25), sidebar, tablas, KPIs, notificaciones.
- Labels de UI en `lib/`: `event-filters.ts` (~15), `area-groups.ts` (6), `share-event.ts`, `use-area-refresh.ts`, `globe-data.ts`, `types.ts`.
- Fechas con locale fijo: `lib/utils.ts:67` (`'es-AR'`), `MagnitudeTimeChart.tsx:47` (`'es-ES'`), `BetaSignupsPanel.tsx:26`, `InvitationsPanel.tsx:93`.

## Scope

### In Scope

- **Infraestructura i18n del dashboard**: next-intl en modo *without i18n routing* (sin `app/[locale]/`): `messages/es.json` + `messages/en.json` con namespaces por página/feature, `i18n/request.ts` resolviendo el locale desde cookie, `NextIntlClientProvider` en el root layout. Las rutas, `middleware.ts` (auth) y los callbacks de OAuth NO se tocan.
- **Migración de los ~45 archivos** de `app/(app)`, `app/login`, `components/` y los labels de `lib/` a `useTranslations()`, por fases (chrome/navegación → páginas → mapas/charts → settings/admin → onboarding/tour).
- **Fechas y números por locale**: reemplazar los `toLocaleString('es-AR'|'es-ES')` hardcodeados por `useFormatter`/`Intl` parametrizado (patrón que `app/invite/[token]/page.tsx:45` ya usa bien).
- **Selector de idioma** en la UI del dashboard (UserMenu o settings) que setea la cookie + `router.refresh()`.
- **Seed del locale inicial**: detección `navigator.language` (mismo criterio que la landing) con la elección explícita ganando; al aceptar una invitación, `invitations.locale` siembra la preferencia.
- **Persistencia en cuenta** (decisión resuelta #2): migración SQL manual `011_user_and_beta_locale.sql` (patrón 001-0NN, sin Alembic) agregando `users.locale` y `beta_signups.locale`, campo en `UserProfile`/`UserProfileUpdate` (`src/models/user.py:151-187`) y select de idioma en `components/settings/ProfileSection.tsx` — el `PATCH /account/profile` ya existe (`src/main.py:1610`).
- **Migración de landing y `/invite` a next-intl** (decisión resuelta #4): mapping 1:1 de `LANDING_COPY`/`INVITE_COPY` a los namespaces `landing.*`/`invite.*`; `lib/landing-i18n.ts` y `lib/invite-i18n.ts` se retiran al final. `validate.locale` sigue mandando el idioma inicial en `/invite`.
- **Emails de beta bilingües** (decisión resuelta #4): `beta_signups.locale` capturado del toggle de la landing; la aprobación propaga ese locale a la invitación (`insert_invitation_row(locale=...)`) y a los emails de confirmación/bienvenida (plantillas ES/EN en `src/services/email_service.py`).
- **Test de paridad de claves** ES/EN (Vitest) para que un idioma no divergir silenciosamente del otro.

### Out of Scope

- **Traducir strings del BACKEND**: los `detail=` de FastAPI (2 user-facing en `main.py`, ~17 `HTTPException` técnicos) casi no llegan al usuario — `lib/api.ts:31` los descarta y el frontend arma sus propios mensajes, que SÍ se traducen acá. Internacionalizar el backend (Accept-Language, catálogos Python) queda explícitamente fuera (decisión resuelta #3).
- **Traducir datos**: nombres de áreas (`src/config/regions.py`, ya mezcla ES/EN: "Japan", "Andes Argentina-Chile"), ciudades (`major-cities.ts`, `seismic-cities.ts`), placas tectónicas, `place` de USGS/EMSC (viene en inglés de la fuente).
- **Idiomas adicionales** (pt, ja, ...) — la infra los deja baratos, pero solo se escriben ES y EN.

## Approach

**next-intl sin i18n routing, locale en cookie.** El dashboard es una app autenticada (cero SEO), mayormente client components (51 archivos `'use client'`) con SWR; reestructurar a `app/[locale]/` rompería middleware de auth, OAuth callbacks y deep-links sin beneficio alguno — por eso se usa el modo cookie-based documentado por next-intl. El provider vive en el root layout; los componentes consumen `useTranslations('namespace')` — se elimina el prop-drilling que el patrón casero de la landing habría exigido a escala de 45 archivos.

El patrón propio existente se respeta como precedente y SE MIGRA en este change (decisión resuelta #4): la semántica "preferencia explícita gana sobre la detección del navegador" se replica con la cookie, y el propio `lib/landing-i18n.ts:2-12` ya declaraba que al internacionalizar el dashboard "esto se migra a esa infraestructura" — la migración de landing y `/invite` es la última fase, tras la cual los diccionarios caseros se retiran.

Cascada de resolución del locale: cookie explícita → `users.locale` (si existe y hay sesión) → `navigator.language` → `es` (default, igual que backend/emails). La migración de strings es mecánica y se hace por fases para poder revisar diffs acotados; los strings generados fuera de JSX (popups Leaflet, tooltips Recharts, canvas) reciben las traducciones por parámetro desde el componente que ya tiene el hook.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `dashboard/messages/{es,en}.json` | New | Diccionarios con namespaces (~350-450 claves) |
| `dashboard/i18n/request.ts` + `dashboard/app/layout.tsx` | New/Modified | `getRequestConfig` (cookie) + `NextIntlClientProvider` |
| `dashboard/app/(app)/**` (11 páginas) + `app/login/page.tsx` | Modified | Strings → `useTranslations` |
| `dashboard/components/**` (~30 archivos, incl. settings/, admin/, onboarding/) | Modified | Strings → `useTranslations`; tour-steps/tooltips parametrizados |
| `dashboard/lib/{event-filters,area-groups,share-event,use-area-refresh,globe-data,types,utils}.ts` | Modified | Labels → claves; `formatDate` recibe locale |
| `dashboard/components/UserMenu.tsx` (o settings) | Modified | Selector de idioma (cookie + refresh) |
| `deploy/sql/migrations/011_user_and_beta_locale.sql` | New | `users.locale` nullable + `beta_signups.locale` |
| `src/models/user.py` + `src/models/beta.py` + `src/main.py` | Modified | `locale` en perfil y beta signup; approve propaga locale |
| `src/services/email_service.py` | Modified | Plantillas ES/EN en los emails de beta |
| `dashboard/lib/landing-i18n.ts` + `dashboard/lib/invite-i18n.ts` | Deleted (fase final) | Migrados a `messages/{es,en}.json` (`landing.*`/`invite.*`) |
| `dashboard/middleware.ts`, rutas, OAuth | **Unmodified** | El modo sin routing no las toca |

## Decisiones resueltas por el usuario (2026-08-12)

1. **Librería: next-intl, modo "without i18n routing"** — APROBADO como se recomendó. Locale en cookie, provider en el root layout, sin reestructurar rutas (`middleware.ts` y OAuth intactos). Versión y setup exacto en `design.md` (Decision 1).

2. **Persistencia: cookie + `users.locale`, ambas en este change** — APROBADO como se recomendó. Selector en el header y en Settings; el cambio setea la cookie y, con sesión, hace `PATCH /account/profile` (endpoint existente). Migración SQL 011 + campo en `UserProfile`/`UserProfileUpdate` (`design.md` Decisions 3 y 7).

3. **Errores de API del backend: fuera de alcance** — APROBADO como se recomendó. Los `detail=` de FastAPI no se internacionalizan; el frontend sigue armando sus propios mensajes (que sí se traducen acá).

4. **Alcance ampliado a TODA la app** — el usuario REVIRTIÓ la recomendación de diferir: landing y `/invite` migran de los diccionarios caseros a next-intl EN ESTE CHANGE (`landing-i18n.ts` e `invite-i18n.ts` se retiran al final), y los emails de beta pasan a ser bilingües: `beta_signups.locale` se captura del toggle de la landing, y la aprobación hereda ese locale hacia la invitación (`create_invitation`/`insert_invitation_row`) y hacia los emails de beta (plantillas ES/EN en `email_service.py`). En `/invite`, `validate.locale` sigue mandando el idioma inicial del invitado.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Regresiones textuales/visuales por tocar ~45 archivos | High | Fases con diffs revisables; test de paridad de claves; e2e existentes (onboarding.spec.ts) + smoke visual por página |
| Claves faltantes en runtime (EN incompleto) | Med | Type-safety de next-intl (augmentation de `Messages`) + test Vitest de paridad ES/EN |
| Strings fuera de JSX (Leaflet popups, Recharts, canvas) mal cableados | Med | Pasar traducciones por props/funciones desde el componente con hook; casos listados en exploration |
| Layout roto por textos EN más largos/cortos | Low | Revisión visual de sidebar/botones/tablas en EN |
| Conflictos con el branch `feat/email-invitations` en vuelo | Med | Arrancar el apply después de mergear ese branch (toca InvitationsPanel, invite, emails) |

## Rollback Plan

- La infra es aditiva: revertir el commit del provider + `messages/` restaura el comportamiento actual (los strings ES quedan como valores del diccionario, no se pierden).
- Migración por fases = commits independientes revertibles por área (chrome, páginas, mapas, settings/admin, onboarding).
- Si se aprueba `users.locale`: migración SQL reversible con `ALTER TABLE users DROP COLUMN locale;` documentada en el propio archivo (patrón 001-0NN); el campo es opcional en `UserProfile`, el backend funciona sin él.
- La cookie de locale es inofensiva: si se revierte todo, se ignora.

## Dependencies

- Merge previo de `feat/email-invitations` (comparte archivos: `InvitationsPanel`, `/invite`, emails, middleware).
- Dependencia npm nueva: `next-intl 4.13.6` (decisión resuelta #1; versión verificada contra el registry, ver design.md Decision 1).

## Success Criteria

- [ ] Un usuario puede alternar ES/EN desde la UI del dashboard y TODA la interfaz autenticada (sidebar, páginas, filtros, mapas, tablas, settings, admin, onboarding/tour, mensajes de error del cliente) cambia de idioma sin recargar sesión.
- [ ] Cero strings user-facing hardcodeados en español en `app/(app)`, `app/login` y `components/` (verificable con el mismo `rg` del inventario, quedando solo datos: ciudades, placas, nombres de áreas).
- [ ] Fechas y números se formatean según el locale activo (adiós `'es-AR'` hardcodeado en `lib/utils.ts`, charts y admin panels).
- [ ] La preferencia persiste entre sesiones y dispositivos (cookie + `users.locale`, editable desde el header y settings).
- [ ] Un invitado EN que acepta su invitación ve el dashboard en inglés en su primer login.
- [ ] Un interesado que se anota a la beta con la landing en EN recibe la confirmación y la bienvenida en inglés, y su invitación hereda ese locale.
- [ ] `lib/landing-i18n.ts` y `lib/invite-i18n.ts` eliminados; landing y `/invite` sirven ambos idiomas desde `messages/{es,en}.json` con paridad textual exacta.
- [ ] Test de paridad de claves ES/EN en verde; suite Vitest y e2e existentes en verde.
