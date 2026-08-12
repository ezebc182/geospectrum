# Exploration: i18n-dashboard — Dashboard Next completo en ES/EN

Fecha: 2026-08-12. Branch: `feat/email-invitations`. Todo lo de abajo está verificado con `rg` sobre el código real.

## Current State

- El dashboard (`dashboard/app/(app)`, `components/`, `lib/`) está **100% en español hardcodeado**: JSX literal, objetos `label:` en lib, `aria-label`, placeholders, tooltips.
- Ya tienen i18n propio (NO rehacer): la landing pública (`lib/landing-i18n.ts`, 331 líneas, ~90 claves), la página de invitación (`lib/invite-i18n.ts`, 171 líneas) y los emails (monolingües por `invitations.locale`, subjects bilingües en `app/api/invitations/send/route.ts`).
- El propio `landing-i18n.ts` (líneas 2-12) documenta la intención: *"Cuando el dashboard entero se internacionalice (cambio SDD aparte, ya en el roadmap), esto se migra a esa infraestructura."*

## Inventario de superficie a traducir (evidencia)

Metodología: `rg` por caracteres acentuados excluyendo líneas de comentario (la convención del repo es comentarios en español, así que el conteo bruto de acentos miente), más un pase por palabras españolas sin tilde (`Eventos`, `Cargando`, `Buscar`...). Los números de acentos son **piso**, no techo.

### Números

- **~45 archivos** del dashboard con strings user-facing en español (excluyendo landing/invite/emails ya internacionalizados y `lib/*-i18n.ts`).
- **~220 líneas con strings acentuados** (sin comentarios) en `app/` + `components/`, más ~40-50 labels en objetos de `lib/`. Sumando strings sin tilde, estimación realista: **~350-450 strings / claves de traducción resultantes** (la landing produjo ~90 claves; el dashboard es 4-5x esa superficie).

### Dónde se concentra (top, líneas acentuadas no-comentario)

| Archivo | Strings | Qué es |
|---|---|---|
| `components/admin/InvitationsPanel.tsx` | 26 | Panel admin de invitaciones (tabla, dialogs, estados) |
| `components/FilterPanel.tsx` | 19 | Filtros del mapa |
| `components/AreaSelector.tsx` | 17 | Selector de áreas (búsqueda, grupos, vacíos) |
| `components/EventFiltersBar.tsx` | 15 | Filtros de la tabla de eventos |
| `app/(app)/page.tsx` | 15 | Dashboard principal (KPIs, títulos, estados) |
| `components/settings/TwoFactorSection.tsx` | 14 | 2FA (pasos, errores, backup codes) |
| `components/AdvancedSeismicMap.tsx` | 14 | Leyendas, capas, controles del mapa |
| `components/SeismicMapWithCities.tsx` | 13 | Popups y controles del mapa live |
| `app/login/page.tsx` | 11 | Login (mensajes de error de OAuth incluidos) |
| `components/onboarding/*` (Wizard + tour-steps + useTour) | ~25 | Wizard + 8 pasos de tour con title/content |
| resto (~30 archivos) | 1-8 c/u | Header, sidebar (6 labels), settings ×4, admin/access, explore, globe, spectrograms, EventsTable, NotificationBell, etc. |

### Strings en `lib/` (labels de datos de UI, no JSX)

- `lib/event-filters.ts` — `TIME_PERIODS`, rangos de magnitud, fuentes: ~15 labels ("Últimas 6 h", "Hoy", "Ayer"...).
- `lib/area-groups.ts:39-46` — `AREA_GROUP_LABELS`: "Mis áreas", "Cinturones sísmicos", "Zonas de subducción"...
- `lib/share-event.ts`, `lib/use-area-refresh.ts`, `lib/globe-data.ts`, `lib/types.ts` — labels y textos de compartir/refresco.
- `lib/utils.ts:67` — `formatDate` hardcodea `toLocaleString('es-AR', ...)`. También `MagnitudeTimeChart.tsx:47` (`'es-ES'`), `BetaSignupsPanel.tsx:26` y `InvitationsPanel.tsx:93` (`'es-AR'`). En cambio `app/invite/[token]/page.tsx:45` ya lo hace bien: `Intl.DateTimeFormat(locale === 'es' ? 'es-AR' : 'en-US')`.

### Qué es dato y NO se traduce

- `lib/major-cities.ts`, `lib/seismic-cities.ts`, `lib/plate-boundaries.ts` — nombres propios (ciudades, placas).
- **Nombres de áreas**: vienen del backend (`src/config/regions.py`) y ya son mezcla ES/EN ("Japan", "Andes Argentina-Chile", "Global (sin filtro)", "Mediterranean"). Son datos, no UI chrome.
- Lugares de eventos (`place` de USGS/EMSC) vienen en inglés de las fuentes.

### Strings del backend (sub-problema, dimensionado)

- Mensajes user-facing del backend: **casi nada**. Solo 2 `detail=` en `src/main.py` (uno en español: `"Demasiados intentos. Probá de nuevo más tarde."`), ~17 `HTTPException` entre `areas.py`/`deps.py`/`main.py` con mensajes técnicos.
- El cliente **no muestra esos mensajes crudos**: `lib/api.ts:31` lanza `` `API Error: ${status}` `` y cada componente arma su propio mensaje en español. O sea: los errores que ve el usuario ya viven en el frontend → se traducen con el resto.
- Emails: ya bilingües por `invitations.locale` (migración 010). Emails de beta: monolingües, quedan como están.

## Patrón i18n existente: cómo funciona y si escala

- **Mecánica** (`lib/landing-i18n.ts` + `components/landing/LandingContent.tsx:27-47`): diccionario tipado plano `LANDING_COPY: Record<Locale, Copy>` con interfaz TS que garantiza paridad ES/EN en compile-time. `useState<Locale>` en el componente raíz, detección `navigator.language` en `useEffect`, persistencia en `localStorage['landing-locale']` solo ante toggle explícito. El objeto `copy` baja por **prop-drilling** a los hijos.
- **Qué le falta para una app entera**:
  - No hay React Context: prop-drilling de `copy` a ~45 archivos y componentes anidados (sidebar → menú → item) no escala.
  - Sin interpolación genérica ni plurales: la única interpolación es una función ad-hoc (`relativeTime`, `landing-i18n.ts:329-330`).
  - Sin formateo de fechas/números por locale centralizado (cada componente llama `toLocaleString` con locale fijo).
  - Cambio de idioma: como es un `useState` local del árbol de la landing, en una app entera habría que subirlo a un Provider en el layout — en ese punto ya estás construyendo una librería i18n casera.
- **Qué sí prueba**: que un diccionario TS tipado con paridad forzada por interfaz funciona bien y da type-safety de claves gratis.

## Alternativa: next-intl (App Router)

- Contexto técnico verificado: Next 15.5.22 + React 19.2, **51 archivos `'use client'`** — el dashboard es mayormente client components con SWR; `middleware.ts` ya existe (auth + allowlist).
- next-intl soporta el modo **"without i18n routing"** (documentado oficialmente): NO exige reestructurar a `app/[locale]/` — el locale se resuelve server-side desde una cookie en `getRequestConfig`, y los client components usan `useTranslations()` vía `NextIntlClientProvider` montado en el root layout. Esto importa acá: el dashboard es una app autenticada sin SEO, URLs localizadas no aportan nada y reestructurar rutas rompería `middleware.ts`, los redirects de OAuth y los deep-links existentes.
- Cambio de idioma en caliente: setear la cookie + `router.refresh()`; el provider re-renderiza el árbol con los mensajes nuevos (aceptable: es un evento raro).
- Aporta sobre el patrón propio: ICU MessageFormat (plurales, interpolación, select), `useFormatter` para fechas/números/tiempo relativo por locale, namespaces por página/componente, type-safety de claves vía augmentation de `Messages`.
- Costo: una dependencia (~13 kB comprimido el runtime cliente), provider + `i18n/request.ts`, mover strings a `messages/es.json` + `messages/en.json`.

## Persistencia del idioma: qué hay y qué falta

| Capa | Hoy | Para el dashboard |
|---|---|---|
| Landing | `localStorage['landing-locale']` | Solo visible client-side; un server component / `getRequestConfig` no la puede leer → **cookie** es el reemplazo natural |
| Invitación | `invitations.locale` en DB (migración 010), define idioma del email y de `/invite` | Seed ideal del idioma inicial del invitado al aceptar |
| Cuenta | `users` **no tiene** `locale`. Sí existe `UserProfile` + `GET/PATCH /account/profile` (`src/main.py:1600-1624`, `src/models/user.py:151-187`) con `full_name/address/phone` | Agregar `locale` a `UserProfile`/`UserProfileUpdate` + migración SQL manual (patrón 001-0NN) es un cambio chico y el settings UI (`ProfileSection`) ya tiene el form y el PATCH |

## Approaches

1. **next-intl sin i18n routing** (cookie-based) — Provider en root layout, `messages/{es,en}.json`, `useTranslations` en los ~45 archivos, `useFormatter` reemplaza los `toLocaleString('es-AR')` hardcodeados.
   - Pros: estándar de facto App Router; plurales/ICU/fechas resueltos; namespaces; sin reestructurar rutas ni tocar middleware; type-safe.
   - Cons: dependencia nueva; migración mecánica de ~400 strings; landing/invite quedan con patrón viejo hasta migrarlos.
   - Effort: **Medium-High** (mecánico pero extenso).

2. **Extender el patrón propio a un Context** — `LocaleProvider` + hook `useT()` + diccionario `dashboard-i18n.ts` particionado.
   - Pros: cero dependencias; continuidad total con landing/invite; el equipo ya conoce el patrón.
   - Cons: reimplementar interpolación/plurales/formatos a mano; un diccionario de 400 claves en TS se vuelve inmanejable (la landing con 90 ya ocupa 331 líneas); sin tooling de claves faltantes; es construir next-intl casero.
   - Effort: **High** (la infra es "gratis" pero la mantenés vos para siempre).

3. **Reestructurar con `app/[locale]/`** (next-intl con routing) — Descartado: rompe middleware de auth, callbacks de OAuth, deep-links; cero beneficio SEO en una app autenticada.

## Recommendation

**Approach 1: next-intl sin i18n routing, locale en cookie, persistencia opcional en `users.locale`.** El comentario de `landing-i18n.ts` ya anticipaba migrar a "la infraestructura del dashboard" — esa infraestructura conviene que sea la estándar y no una casera de 400 claves.

## Risks

- Volumen: ~45 archivos tocados en un solo change → regresiones visuales/textuales difíciles de revisar. Mitigar por fases (chrome → páginas → mapas/charts → admin/settings).
- Strings dentro de canvas/Leaflet/Recharts (popups de mapa, tooltips de charts) se generan fuera de JSX; hay que pasarles las traducciones como funciones/props.
- Claves sin traducir en runtime si ES/EN divergen → mitigar con type-safety de next-intl + un test de paridad de claves.

## Ready for Proposal

Sí — proposal escrito en `openspec/changes/i18n-dashboard/proposal.md` con 4 decisiones abiertas marcadas para el usuario.
