# Design: i18n completo del dashboard (ES/EN) con next-intl

Decisiones del usuario (2026-08-12, cerradas): (1) next-intl *without i18n routing*; (2) persistencia cookie + `users.locale`; (3) alcance TODA la app — landing y `/invite` migran a next-intl, emails de beta por idioma; (4) errores de API backend fuera de alcance. Este design las baja a tierra con evidencia del código real.

## Technical Approach

El locale se resuelve **una sola vez por request, server-side**, en `dashboard/i18n/request.ts` (`getRequestConfig` de next-intl): cookie `NEXT_LOCALE` → `Accept-Language` → `'es'`. El `NextIntlClientProvider` se monta en el root layout (`app/layout.tsx`, que hoy hardcodea `lang="es"`) y serializa los mensajes del locale activo hacia los 51 client components; nada de `app/[locale]/` — `middleware.ts` (auth), los callbacks de OAuth y los deep-links no se tocan.

`users.locale` (migración 011) entra a la cascada **del lado del cliente**: un componente `LocaleSync` reconcilia el perfil hidratado con la cookie en el primer paint. El cambio de idioma es: setear cookie + `router.refresh()` (re-corre `getRequestConfig`, el provider re-renderiza con los mensajes nuevos, la caché de SWR queda intacta — sin reload) + `PATCH /account/profile {locale}` si hay sesión.

La migración de strings es por fases con commits revertibles: infra+chrome → páginas → mapas/charts → settings/admin → onboarding/toasts → landing+invite (donde `landing-i18n.ts` e `invite-i18n.ts` se retiran). El backend gana `users.locale`, `beta_signups.locale` (capturado del toggle de la landing) y plantillas ES/EN en los tres emails de beta; la aprobación de un beta signup propaga su locale a la invitación (`insert_invitation_row(locale=...)`), cerrando la cadena landing → email → `/invite` → dashboard en el idioma del invitado.

## Architecture Decisions

### Decision 1: next-intl `4.13.6` pinneado exacto, modo *without i18n routing*

**Choice**: dependencia `"next-intl": "4.13.6"` (pin exacto, sin caret).

- Verificado contra el registry (2026-08-12): `npm view next-intl version` → **4.13.6** (dist-tag `latest`; `v4-beta` y `canary` descartados). Peers: `next ^12–^16`, `react ^16.8–^19` — compatible con lo instalado (`next ^15.5.22`, `react ^19.2.0` en `dashboard/package.json`).
- Pin exacto siguiendo el precedente del propio `package.json`: la infra deliberada se pinnea (`resend 6.18.1`, `driver.js 1.8.0`, `@react-email/components 1.0.12`); los frameworks van con caret.
- Setup exacto (contratos abajo): `next.config.ts` se envuelve con `createNextIntlPlugin('./i18n/request.ts')` (hoy el config son 10 líneas, solo `reactStrictMode` + env — el wrap es trivial); `i18n/request.ts` resuelve el locale desde `cookies()`/`headers()` de `next/headers`; el root layout hace `const locale = await getLocale()` para `<html lang>` y monta `NextIntlClientProvider` **por fuera** de `Providers` (los mensajes no dependen de theme/auth/tooltip). Client components: `useTranslations('ns')`, `useFormatter()`, `useLocale()`. SWR no se toca: `t()` es capa de presentación, el data-fetching queda igual.

**Alternatives considered**: (a) `app/[locale]/` con routing — descartado en el proposal: rompe `middleware.ts` (matcher actual `'/((?!api|_next/static|...).*)'`), los redirects de OAuth y los deep-links, sin beneficio SEO en una app autenticada. (b) Extender el patrón casero de la landing — descartado: a 400 claves es reimplementar next-intl sin tooling (la landing con ~90 claves ya ocupa 331 líneas). (c) `^4.13.6` — descartado por el precedente de pins exactos en infra.

**Rationale**: versión verificada, no asumida; el modo cookie-based es el documentado oficialmente por next-intl para apps sin URLs localizadas, y es el único que deja `middleware.ts` intacto.

### Decision 2: Locale identifier `'es' | 'en'` en cookie/DB/JSON; locale de FORMATO `es-AR`/`en-US` mapeado en un solo lugar

**Choice**: dos niveles deliberados:

- **Identificador de app**: `'es' | 'en'` — es lo que va en la cookie `NEXT_LOCALE`, en `users.locale`, `beta_signups.locale`, `invitations.locale` (CHECK existente de la migración 010: `locale IN ('es','en')`) y como nombre de archivo de mensajes.
- **Locale de formato**: `i18n/request.ts` es el ÚNICO lugar que mapea `es → 'es-AR'`, `en → 'en-US'` y lo devuelve como locale de next-intl. `useFormatter()`/`useLocale()` ven `es-AR`/`en-US`; un helper `toAppLocale()` colapsa a `'es'|'en'` para todo lo que viaja a la API.

**Alternatives considered**: (a) usar `'es'` genérico también para formato — descartado: `'es'` resuelve a convenciones de es-ES (horas en formato 24 h), mientras el dashboard HOY formatea todo en `es-AR` (12 h con "p. m." — `lib/utils.ts:67`, `InvitationsPanel.tsx:93`, `BetaSignupsPanel.tsx:26`) y `/invite` ya eligió explícitamente `es-AR` (`app/invite/[token]/page.tsx:45`). Cambiaría el formato horario visible sin razón. (b) guardar `es-AR` en cookie/DB — descartado: rompería el CHECK de la migración 010 y duplicaría el mapping en cada consumidor.

**Rationale**: preserva el formato rioplatense ya elegido, mantiene la DB alineada con `invitations.locale`, y el mapping vive en un solo archivo.

### Decision 3: Cascada de resolución — server: cookie → Accept-Language → 'es'; `users.locale` reconcilia client-side vía `LocaleSync`

**Choice**:

- **Server (`i18n/request.ts`)**: (1) cookie `NEXT_LOCALE` si vale `es`/`en`; (2) primer idioma soportado del header `Accept-Language`; (3) `'es'`. Sin tocar la base ni verificar sesión acá.
- **Cliente (`components/LocaleSync.tsx`, montado en el layout de `(app)`)**: cuando `GET /account/profile` hidrata con `locale` no nulo y **no existe** cookie `NEXT_LOCALE`, setea la cookie a `users.locale` y hace `router.refresh()` una única vez. Si la cookie existe, no hace nada: la elección explícita del dispositivo gana.
- **Cookie**: `NEXT_LOCALE=es|en; path=/; max-age=31536000; SameSite=Lax`, **no** httpOnly (la setea el cliente; es una preferencia de UI, no un secreto — a diferencia de la cookie `session`, que es httpOnly a propósito, ver `middleware.ts`).
- **Cambio de idioma** (selector en `UserMenu` del Header + select en `settings/ProfileSection`): setear cookie → `router.refresh()` → si hay sesión, `PATCH /account/profile {locale}` en paralelo (best-effort: si el PATCH falla, la UI ya cambió; se loguea, no se bloquea). Sin reload de página ni pérdida de estado SWR.
- **Landing**: el toggle deja de ser `useState` local + `localStorage['landing-locale']` (`LandingContent.tsx:27-41`) y pasa a la misma mecánica cookie+refresh. La preferencia guardada en localStorage NO se migra: primera visita post-deploy re-detecta por Accept-Language — pérdida aceptable de una preferencia de UI en una página pública.
- **`/invite`**: al validar el token, si NO hay cookie `NEXT_LOCALE`, la página setea la cookie a `invitation.locale` (respuesta de `validate`) + refresh — `validate.locale` sigue mandando el idioma inicial del invitado, y como la cookie queda seteada, el primer login post-aceptación aterriza en el dashboard en ese idioma sin paso extra. Si el invitado ya tenía cookie (eligió antes), su elección gana.

**Alternatives considered**: (a) resolver `users.locale` en `getRequestConfig` (verificar la cookie `session` con jose + fetch al backend) — descartado: mete un round-trip al backend en CADA request server de Next solo para una preferencia que la cookie ya captura tras el primer login; acopla el render al uptime de la API. (b) meter el locale como claim del JWT — descartado: el proyecto ya aprendió que los datos mutables no van al JWT (`onboarding_completed_at`, `src/models/user.py:130-137` lo documenta); el idioma cambiaría recién al re-login. (c) migrar el `localStorage` de la landing a cookie con un script one-shot — descartado por costo/beneficio.

**Rationale**: la cascada pedida (cookie → users.locale → Accept-Language → es) se cumple observablemente: con cookie, nada la pisa; sin cookie, el primer render usa Accept-Language (que en la práctica coincide con `users.locale` casi siempre) y `LocaleSync` corrige en el primer paint al hidratar el perfil. El costo es un posible flash de idioma en el primer render de un dispositivo nuevo con Accept-Language distinto del perfil — evento raro y autocorregido.

### Decision 4: Mensajes — `messages/es.json` + `messages/en.json`, namespaces por dominio, migración en 6 fases

**Choice**:

- **Un archivo por idioma** (`dashboard/messages/{es,en}.json`), con namespaces top-level por dominio (ES es la fuente — los strings actuales se mueven tal cual, sin re-redactar):

  | Namespace | Cubre (evidencia del inventario del exploration) |
  |---|---|
  | `common` | Botones/estados compartidos: Guardar, Cancelar, Cargando, Reintentar, N/A |
  | `nav` | AppSidebar (6 labels), Header, UserMenu |
  | `auth` | `app/login/page.tsx` (11 strings, incl. errores de OAuth) |
  | `dashboard` | `app/(app)/page.tsx` (15: KPIs, títulos, estados) |
  | `events` | EventsTable + EventFiltersBar (15) + claves de `lib/event-filters.ts` (~15: periods, rangos, fuentes) |
  | `filters` | FilterPanel (19) |
  | `areas` | AreaSelector (17) + grupos de `lib/area-groups.ts` (6) + AreaHeader/use-area-refresh |
  | `map` | AdvancedSeismicMap (14) + SeismicMapWithCities (13): leyendas, capas, popups |
  | `globe` | Globo 3D, GlobeEventPanel, labels de `lib/globe-data.ts` |
  | `charts` | MagnitudeTimeChart, spectrograms |
  | `onboarding` | OnboardingWizard + `tour-steps.ts` (8 pasos title/description) |
  | `settings` | ProfileSection, TwoFactorSection (14), ExportData, DangerZone |
  | `admin` | InvitationsPanel (26), BetaSignupsPanel, access |
  | `notifications` | NotificationBell |
  | `share` | `lib/share-event.ts` |
  | `errors` | Mensajes de error que el cliente arma (los `detail` del backend se siguen descartando — `lib/api.ts`) |
  | `landing` | Migración 1:1 de `LANDING_COPY` (fase 6) |
  | `invite` | Migración 1:1 de `INVITE_COPY` (fase 6) |

- **Type-safety**: `dashboard/global.d.ts` con la augmentation de next-intl v4 (`interface AppConfig { Messages: typeof es }`) — claves inexistentes fallan en compile-time con ES como fuente del tipo.
- **Paridad ES/EN**: test Vitest (`messages/parity.test.ts`) que aplana ambos JSON y exige igualdad exacta de sets de claves + ningún valor vacío. Complementa el type-check (que solo valida contra ES).
- **Orden de migración (fases = commits revertibles, cada una compila y pasa tests sola)**:
  1. Infra (plugin, request.ts, provider, cookie, selector en UserMenu) + chrome: layout, Header, AppSidebar, login.
  2. Dashboard principal + events/filters + areas (incluye `lib/event-filters.ts` y `lib/area-groups.ts`).
  3. Mapas + globe + charts + spectrograms (los casos duros de la Decision 5).
  4. Settings (incl. select de idioma en ProfileSection + `LocaleSync`) + admin.
  5. Onboarding/tour + toasts + share + NotificationBell + `lib/utils.ts` (fechas).
  6. Landing + `/invite` a next-intl; retiro de `landing-i18n.ts` e `invite-i18n.ts`.

  Las claves se agregan a AMBOS json en la fase que las consume — el test de paridad corre verde en cada fase, nunca hay EN "pendiente".

**Alternatives considered**: (a) un JSON por namespace — descartado por ahora: next-intl carga el archivo entero igual y ~400 claves son ~30 KB; partir archivos es una optimización prematura (ver Risks). (b) migrar todo en un commit — descartado: ~45 archivos en un diff es irrevisable (Risk High del proposal). (c) re-redactar copy al migrar — descartado: paridad textual exacta es el criterio de no-regresión; el copy se pule en otro change.

**Rationale**: namespaces espejando el árbol de componentes hacen greppeable la relación clave↔uso; las fases reproducen el orden de dependencia real (la infra primero, la landing al final porque HOY ya funciona bilingüe).

### Decision 5: Strings fuera de JSX — `t()` vive en componentes/hooks; las funciones puras de `lib/` reciben mensajes por parámetro

**Choice**: regla única — **ningún `lib/*.ts` importa next-intl**. El borde componente↔lib se resuelve por caso:

- **`lib/event-filters.ts`**: `TIME_PERIODS` pierde `label` y queda `{ value: TimePeriod }[]`; el componente resuelve `t(\`periods.${value}\`)`. Las funciones de filtrado (puras, testeadas sin DOM — comentario del propio archivo) no cambian de firma.
- **`lib/area-groups.ts`**: `AREA_GROUP_LABELS` se elimina; `groupAreas()` devuelve `{ id, areas }` y el componente deriva el label con `t(\`groups.${id}\`)`. El `localeCompare(..., 'es')` de la línea 134 pasa a usar el locale activo (recibido por parámetro).
- **Popups de Leaflet** (HTML strings en `AdvancedSeismicMap.tsx:234,380` y `SeismicMapWithCities.tsx:237,300`): ambos son client components — el `useEffect` que construye los markers captura un objeto `popupLabels` memoizado desde `useTranslations`, y **`locale` entra a las deps del effect** para reconstruir los popups al cambiar idioma. Atención a la trampa conocida del proyecto (memoria: efecto que lee un ref sin tenerlo en deps corre una vez y nunca más): acá el contenido del popup DEBE regenerarse en el cambio de locale, así que las labels van por valor en deps, no por ref.
- **Recharts** (`MagnitudeTimeChart.tsx:47`, `tickFormatter` con `'es-ES'` hardcodeado): el formatter se define inline en el componente usando `useFormatter().dateTime(...)`.
- **Canvas del globo / `lib/globe-data.ts`**: las funciones que arman labels reciben los strings ya traducidos por parámetro desde el componente.
- **`lib/share-event.ts`**: `buildShareText`/`shareEvent` ganan un parámetro `messages: ShareMessages` (título "Monitor sísmico" de la línea 88, etc.) que provee el componente; los tests unitarios siguen sin montar DOM (la razón por la que el archivo existe separado, según su propio header).
- **`components/onboarding/tour-steps.ts`**: la constante `TOUR_STEPS` pasa a `buildTourSteps(t: Translator): DriveStep[]` — `useTour` la invoca con el `t` del namespace `onboarding`. El import type-only de driver.js se conserva (no arrastra runtime al bundle, como documenta el archivo).
- **Toasts**: se disparan desde componentes client → `t()` directo, sin caso especial.

**Alternatives considered**: (a) un singleton `getT()` importable desde lib — descartado: rompe el modelo server/client de next-intl y esconde la dependencia del locale (un módulo "puro" que cambia de output por estado global). (b) traducir popups con claves y un post-procesador — sobre-ingeniería para 4 call-sites.

**Rationale**: mantiene la propiedad que el código ya defiende explícitamente (funciones puras testeables sin DOM en `event-filters`, `share-event`, `area-groups`) y hace visible en la firma qué necesita traducción.

### Decision 6: Fechas y números — `useFormatter` con formats globales; muere el `'es-AR'` hardcodeado

**Choice**: `i18n/request.ts` declara `formats` globales nombrados (`dateTime: 'medium'` estilo `formatDateTime` actual, `'short'`, `'time'`) y los componentes usan `useFormatter()`. Los cuatro call-sites con locale fijo (`lib/utils.ts:67` `'es-AR'`, `MagnitudeTimeChart.tsx:47` `'es-ES'`, `BetaSignupsPanel.tsx:26` y `InvitationsPanel.tsx:93` `'es-AR'`) se reemplazan. `formatDateTime`/`formatDateTimeCompact` de `lib/utils.ts`: la variante "compact" (YYYY-MM-DD HH:MM:SS, estilo USGS, deliberadamente neutra según su docstring) **no se localiza** — es un formato técnico ordenable, idéntico en ambos idiomas; `formatDateTime` sí migra a `useFormatter` (o recibe el locale por parámetro donde el call-site no es componente). `relativeTime` casero de la landing (`landing-i18n.ts:323-331`) se reemplaza por `useFormatter().relativeTime()` en la fase 6.

**Alternatives considered**: pasar el locale a las funciones de `lib/utils.ts` y mantener `toLocaleString` — viable, pero duplica el mapping es→es-AR fuera de `request.ts` (viola Decision 2).

**Rationale**: un solo origen del locale de formato; el criterio "compact es dato técnico, no copy" evita localizar lo que se eligió precisamente por ser neutral.

### Decision 7: Backend — migración `011_user_and_beta_locale.sql`, modelos, y la cadena beta→invitación→email por idioma

**Choice** (SQL completo en Interfaces / Contracts):

- **Migración 011** (numeración verificada: `deploy/sql/migrations/` termina en `010_invitation_locale.sql`): en UN archivo, porque es un solo concepto (idioma del usuario/interesado):
  - `users.locale TEXT NULL` + CHECK `('es','en')` — **nullable a propósito**: `NULL` = "nunca eligió" (deja decidir a Accept-Language), distinto de un default `'es'` que pisaría la detección para siempre.
  - `beta_signups.locale TEXT NOT NULL DEFAULT 'es'` + CHECK — NOT NULL con default, espejo exacto de `invitations.locale` (010): las filas históricas son de la landing en ES.
  - Idempotente estilo 010: `ADD COLUMN IF NOT EXISTS`, CHECK con nombre explícito y `DROP CONSTRAINT IF EXISTS` previo; rollback documentado en el archivo. Se aplica sola al arranque (`scripts/apply_migrations.py`).
- **Modelos Pydantic**: el tipo `InvitationLocale = Literal["es", "en"]` ya existe (`src/models/invitation.py:22`) y se reutiliza (import directo — invitation.py solo depende de tipos, sin ciclos): `UserProfile.locale: Optional[InvitationLocale] = None`, `UserProfileUpdate.locale: Optional[InvitationLocale] = None`, `BetaSignupRequest.locale: InvitationLocale = "es"`, `BetaSignupItem.locale: InvitationLocale = "es"`.
- **PATCH de perfil**: `AuthService.get_profile()` suma `locale` al SELECT (`auth_service.py:757`) y `update_profile()` lo acepta gratis — el UPDATE parcial ya se construye desde `model_dump(exclude_unset=True)` (`auth_service.py:783`), solo entra el campo al modelo. La garantía de tipos del endpoint (`UserProfileUpdate` no declara `role`/`email`) se preserva.
- **Beta signup**: `POST /beta-signups` (main.py:682) persiste `locale` (el form de la landing, `LandingFooter.tsx`, lo manda desde el toggle activo; `signupBeta()` de `lib/api.ts:165` gana el parámetro). El honeypot y el rate-limit no cambian.
- **Aprobación** (`approve_beta_signup`, main.py:763): el `SELECT ... FOR UPDATE` suma `locale`; se propaga a `insert_invitation_row(conn, ..., locale=signup["locale"])` — el parámetro ya existe con default `'es'` (`invitation_service.py:157`), hoy el approve simplemente no lo pasa — y a `send_beta_approved_email(signup["email"], signup["locale"])`.
- **Emails de beta** (`email_service.py`): `send_beta_signup_emails(email, locale)` y `send_beta_approved_email(email, locale)` ganan el parámetro y eligen copy ES o EN (mismo `_layout`/`_paragraph`/`_button` inline; se elimina la línea muted en inglés del template actual, que era el parche monolingüe). El aviso al admin queda en ES (es para el admin, no para el interesado). El email de invitación admin-elegida no cambia (ya es bilingüe por `invitations.locale`, ruta Next + react-email).

**Alternatives considered**: (a) dos migraciones (011 users, 012 beta) — descartado: un concepto, un archivo, menos ruido en el arranque; el rollback documenta ambas mitades por separado. (b) `users.locale NOT NULL DEFAULT 'es'` — descartado (mata la cascada: todo usuario existente quedaría clavado en ES aunque su navegador pida EN). (c) mover `InvitationLocale` a un módulo común — YAGNI para un alias de dos literales; se reevalúa si aparece un tercer consumidor.

**Rationale**: cada pieza reutiliza un mecanismo existente (el UPDATE parcial genérico, el parámetro `locale` ya presente en `insert_invitation_row`, el patrón de la migración 010); el único código nuevo real son los templates EN de los emails de beta.

### Decision 8: Migración de landing y `/invite` — mapping 1:1, paridad textual, y retiro de los diccionarios caseros

**Choice** (fase 6, la última):

- **Mapping de claves**: `LANDING_COPY.{hero,sections,footer,...}` → `landing.*`; `INVITE_COPY.{accept,states,...}` → `invite.*`. Regla: misma jerarquía, mismos textos carácter por carácter (la interfaz TS que forzaba paridad ES/EN se reemplaza por el test de paridad + augmentation). Las dos funciones con lógica (`relativeTime` → `useFormatter().relativeTime`; `detectLandingLocale`/`storeLandingLocale` → cascada de la Decision 3) se retiran con el archivo.
- **Criterio de paridad visual**: cero cambios de markup/clases en esta fase — el diff de cada componente de landing/invite debe ser "prop `copy` → hooks", nada más. Verificación: e2e existentes + smoke visual manual ES/EN de landing e invite (los textos son idénticos, así que cualquier diferencia visual es un bug de la migración).
- **`/invite` y el idioma inicial**: `validate.locale` sigue mandando — al validar el token, si no hay cookie `NEXT_LOCALE`, la página la setea al locale de la invitación (Decision 3). El `LocaleSwitcher` propio de la página (`page.tsx:100`) se reemplaza por el switcher global. `formatExpiry` (línea 44-45, ya parametrizado por locale) migra a `useFormatter`.
- **Retiro**: `lib/landing-i18n.ts` y `lib/invite-i18n.ts` se BORRAN al final de la fase 6 (con sus tests, si los hay); el comentario de `landing-i18n.ts:2-12` que anticipaba esta migración se cumple y desaparece con el archivo.

**Alternatives considered**: dejar landing/invite con el patrón viejo (recomendación original del proposal) — **revertido por decisión del usuario** (alcance = toda la app): convivir con dos infras i18n era el costo diferido; el usuario eligió pagarlo ahora.

**Rationale**: hacerlo al final minimiza el riesgo — para la fase 6 la infra ya está probada por 5 fases de dashboard, y el mapping 1:1 hace el diff mecánico.

### Decision 9: Rollout — migración aditiva + deploy único; sin feature flag

**Choice**: un solo tren de deploy alcanza. Orden interno: la migración 011 es aditiva y corre sola al arranque de la API (Railway); el frontend (Vercel) tolera `locale` ausente en el perfil (campo `Optional`) y el backend viejo tolera un PATCH sin `locale` (`exclude_unset`). No hay ventana en la que una mitad rompa a la otra, así que no se necesita flag ni deploy en dos etapas. Las 6 fases de la Decision 4 son commits/PRs sobre el mismo branch — el rollout a prod puede ser al final o por fase, ambas seguras porque cada fase deja la app 100% funcional (los strings aún no migrados simplemente siguen en ES hardcodeado).

**Rationale**: aditividad en ambas puntas (columnas nullable/default + campos opcionales) es la misma receta que ya usó email-invitations; la única precondición real es la del proposal — mergear `feat/email-invitations` antes del apply (comparte `InvitationsPanel`, `/invite`, emails).

## Data Flow

    Resolución del locale (cada request server de Next)
    ────────────────────────────────────────────────────
    cookie NEXT_LOCALE ──sí──→ locale
          │no
    Accept-Language es/en? ──sí──→ locale
          │no
        'es'
          │
    i18n/request.ts: locale app ('es'|'en') → locale formato ('es-AR'|'en-US')
          │
    app/layout.tsx: <html lang> + NextIntlClientProvider (mensajes del locale)
          │
    client components: useTranslations / useFormatter / useLocale

    Cambio de idioma (selector Header/Settings)
    ────────────────────────────────────────────
    click → set cookie NEXT_LOCALE → router.refresh() ─→ re-render (SWR intacto)
                    └─(si hay sesión)→ PATCH /account/profile {locale} (best-effort)

    Primer login en dispositivo nuevo
    ──────────────────────────────────
    GET /account/profile → LocaleSync: ¿profile.locale ≠ null y no hay cookie?
        → set cookie = users.locale → router.refresh() (una vez)

    Cadena del invitado por beta (EN)
    ──────────────────────────────────
    landing (toggle EN) → POST /beta-signups {email, locale:'en'}
        → beta_signups.locale='en' → confirmación EN al interesado
    admin aprueba → insert_invitation_row(locale='en') + send_beta_approved_email(..., 'en')
    invitado abre /invite → validate.locale='en' → set cookie 'en'
    → acepta → primer login → dashboard EN

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `dashboard/package.json` | Modify | `"next-intl": "4.13.6"` |
| `dashboard/next.config.ts` | Modify | Wrap con `createNextIntlPlugin('./i18n/request.ts')` |
| `dashboard/i18n/request.ts` | Create | Cascada cookie→Accept-Language→'es'; mapping es→es-AR; `formats` globales |
| `dashboard/messages/es.json`, `messages/en.json` | Create | ~400 claves, namespaces Decision 4 |
| `dashboard/messages/parity.test.ts` | Create | Paridad de claves ES/EN (Vitest) |
| `dashboard/global.d.ts` | Create | Augmentation `AppConfig.Messages` (type-safety de claves) |
| `dashboard/app/layout.tsx` | Modify | `lang={locale}` dinámico + `NextIntlClientProvider` |
| `dashboard/lib/locale.ts` | Create | `setLocaleCookie()`, `toAppLocale()`, constantes cookie |
| `dashboard/components/LocaleSync.tsx` | Create | Reconciliación users.locale→cookie (Decision 3) |
| `dashboard/components/LocaleSwitcher.tsx` | Create | Selector reutilizado en UserMenu, Settings, landing, invite |
| `dashboard/components/UserMenu.tsx`, `Header.tsx` | Modify | Monta el switcher |
| `dashboard/app/(app)/**` (11 páginas), `app/login/page.tsx` | Modify | Strings → `useTranslations` (fases 1-2) |
| `dashboard/components/**` (~30 archivos) | Modify | Strings → hooks; popups/tour/charts según Decision 5 |
| `dashboard/lib/{event-filters,area-groups,share-event,use-area-refresh,globe-data,types,utils}.ts` | Modify | Labels fuera; firmas con mensajes/locale por parámetro |
| `dashboard/components/settings/ProfileSection.tsx` | Modify | Select de idioma; PATCH incluye `locale` |
| `dashboard/lib/api.ts` | Modify | `signupBeta(email, website, locale)`; tipos de perfil con `locale` |
| `dashboard/components/landing/*`, `app/invite/[token]/page.tsx` | Modify | Fase 6: hooks en vez de prop `copy` |
| `dashboard/lib/landing-i18n.ts`, `dashboard/lib/invite-i18n.ts` | Delete | Fase 6, tras migrar claves 1:1 |
| `deploy/sql/migrations/011_user_and_beta_locale.sql` | Create | `users.locale` + `beta_signups.locale` (Decision 7) |
| `src/models/user.py` | Modify | `locale` en `UserProfile`/`UserProfileUpdate` |
| `src/models/beta.py` | Modify | `locale` en `BetaSignupRequest`/`BetaSignupItem` |
| `src/services/auth_service.py` | Modify | `locale` en SELECT de `get_profile` (el UPDATE parcial ya es genérico) |
| `src/main.py` | Modify | `/beta-signups` persiste locale; approve propaga locale a invitación y email |
| `src/services/email_service.py` | Modify | Templates ES/EN en los emails de beta; firmas con `locale` |
| `dashboard/middleware.ts`, rutas, OAuth callbacks | **Unmodified** | El modo sin routing no los toca |

## Interfaces / Contracts

### `dashboard/i18n/request.ts` (contrato)

```ts
// Cascada server-side. NUNCA toca la base ni verifica sesión (Decision 3).
const FORMAT_LOCALES = { es: 'es-AR', en: 'en-US' } as const;
type AppLocale = keyof typeof FORMAT_LOCALES; // 'es' | 'en'

export default getRequestConfig(async () => {
  const appLocale: AppLocale = /* cookie NEXT_LOCALE válida */ ?? /* Accept-Language */ ?? 'es';
  return {
    locale: FORMAT_LOCALES[appLocale],           // formato: es-AR / en-US
    messages: (await import(`../messages/${appLocale}.json`)).default,
    formats: { dateTime: { medium: { dateStyle: 'medium', timeStyle: 'medium' }, /* ... */ } },
  };
});
```

### Migración `011_user_and_beta_locale.sql`

```sql
-- users.locale: NULL = "nunca eligió" (la cascada cookie/Accept-Language decide).
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
ALTER TABLE users ADD CONSTRAINT users_locale_check
    CHECK (locale IS NULL OR locale IN ('es', 'en'));

-- beta_signups.locale: espejo de invitations.locale (010). Filas viejas = 'es'.
ALTER TABLE beta_signups ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'es';
ALTER TABLE beta_signups DROP CONSTRAINT IF EXISTS beta_signups_locale_check;
ALTER TABLE beta_signups ADD CONSTRAINT beta_signups_locale_check
    CHECK (locale IN ('es', 'en'));

-- Rollback:
-- ALTER TABLE users DROP CONSTRAINT IF EXISTS users_locale_check;
-- ALTER TABLE users DROP COLUMN IF EXISTS locale;
-- ALTER TABLE beta_signups DROP CONSTRAINT IF EXISTS beta_signups_locale_check;
-- ALTER TABLE beta_signups DROP COLUMN IF EXISTS locale;
```

### Modelos Pydantic (deltas)

```python
from src.models.invitation import InvitationLocale  # Literal["es", "en"], ya existe

class UserProfile(BaseModel):
    ...
    locale: Optional[InvitationLocale] = None   # NULL = sin preferencia guardada

class UserProfileUpdate(BaseModel):
    ...
    locale: Optional[InvitationLocale] = None   # entra al UPDATE parcial existente

class BetaSignupRequest(BaseModel):
    email: EmailStr
    website: str = Field(default="", max_length=200)
    locale: InvitationLocale = "es"             # toggle de la landing
```

### Firmas de servicios (deltas)

```python
# email_service.py — copy ES o EN completo por template (adiós línea muted EN)
async def send_beta_signup_emails(self, email: str, locale: InvitationLocale = "es") -> None: ...
async def send_beta_approved_email(self, email: str, locale: InvitationLocale = "es") -> None: ...

# main.py approve_beta_signup — SELECT suma locale, y:
await insert_invitation_row(conn, email=..., role=UserRole.VIEWER,
                            invited_by=admin.id, expire_days=...,
                            locale=signup["locale"])   # param ya existente, hoy sin pasar
await request.app.state.email_service.send_beta_approved_email(signup["email"], signup["locale"])
```

### Frontend (contratos clave)

```ts
// lib/locale.ts
export type AppLocale = 'es' | 'en';
export function setLocaleCookie(locale: AppLocale): void;   // NEXT_LOCALE, 1 año, SameSite=Lax
export function toAppLocale(bcp47: string): AppLocale;       // 'es-AR' -> 'es'

// lib/api.ts
export async function signupBeta(email: string, website: string, locale: AppLocale): Promise<void>;

// lib/share-event.ts — la función pura recibe los mensajes, no el hook
export interface ShareMessages { title: string; /* ... */ }
export function buildShareText(evento: SeismicEvent, messages: ShareMessages): string;

// components/onboarding/tour-steps.ts
export function buildTourSteps(t: (key: string) => string): DriveStep[];

// lib/event-filters.ts — TIME_PERIODS pierde label; el componente traduce
export const TIME_PERIODS: { value: TimePeriod }[];
```

### `messages/es.json` (forma)

```json
{
  "nav": { "dashboard": "Panel", "globe": "Globo 3D" },
  "events": {
    "periods": { "all": "Todo", "6h": "Últimas 6 h", "today": "Hoy", "yesterday": "Ayer" }
  },
  "areas": { "groups": { "mine": "Mis áreas", "subduction": "Zonas de subducción" } }
}
```

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Unit (front) | Paridad de claves ES/EN; `toAppLocale`; `buildShareText(messages)`; `buildTourSteps(t)`; filtros sin label | Vitest — los tests existentes de lib se ajustan a las firmas nuevas |
| Unit (back) | `UserProfile`/`BetaSignupRequest` con `locale`; templates de email ES/EN por locale | pytest — extiende `tests/unit/test_auth_service.py` y los de email |
| Integration (back) | PATCH `/account/profile {locale}` persiste y devuelve; `/beta-signups` guarda locale; approve propaga locale a `invitations.locale` (contra la base real — memoria del proyecto: verificar contra la base, no con mocks) | pytest integration, patrón `test_invitations_api.py` |
| Component | Switcher setea cookie + refresh; `LocaleSync` corrige solo sin cookie; popups Leaflet se regeneran al cambiar locale | Vitest + Testing Library |
| E2E | Login → toggle EN → sidebar/tabla/settings en EN sin reload; `/invite` EN → dashboard EN; onboarding.spec.ts existente en verde | Playwright |
| Visual | Smoke manual ES/EN por página en cada fase (textos EN más largos: sidebar, botones, tablas) | Checklist por fase en tasks |

## Migration / Rollout

Migración 011 aditiva, auto-aplicada al arranque (patrón 001-010, `scripts/apply_migrations.py`). Deploy único Railway+Vercel; sin feature flag (Decision 9). Precondición: mergear `feat/email-invitations` antes del apply. Rollback: revertir commits por fase (cada fase deja la app funcional); el SQL de rollback está en la propia 011; la cookie `NEXT_LOCALE` huérfana es inocua.

## Open Questions

- [ ] Ninguna bloqueante. Diferido explícitamente: partir `messages/*.json` por namespace si el payload serializado al cliente molesta en métricas reales (hoy ~30 KB estimados — no amerita).
