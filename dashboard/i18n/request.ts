import { getRequestConfig } from 'next-intl/server';
import { cookies, headers } from 'next/headers';

import { DEFAULT_LOCALE, LOCALE_COOKIE, isAppLocale, type AppLocale } from '@/lib/locale';

/**
 * ÚNICO lugar del mapping app → locale de formato (design, Decision 2):
 * 'es' resuelve a es-AR (formato rioplatense que el dashboard ya usa hoy)
 * y 'en' a en-US. useLocale()/useFormatter() ven es-AR/en-US;
 * toAppLocale() colapsa de vuelta a 'es'|'en' para lo que viaja a la API.
 */
const FORMAT_LOCALES = { es: 'es-AR', en: 'en-US' } as const;

/**
 * Formats globales nombrados (Decision 6). `formatDateTimeCompact` de
 * lib/utils (YYYY-MM-DD HH:MM:SS estilo USGS) NO se localiza — es formato
 * técnico ordenable, deliberadamente fuera de esta tabla (pero también UTC).
 *
 * timeZone: 'UTC' en los tres: el dominio sísmico trabaja en UTC y todas
 * las fuentes llegan en UTC.
 *
 * OJO: fijarlo acá cubre SOLO las llamadas por nombre —
 * `format.dateTime(d, 'medium')`. Las que pasan opciones inline
 * (`format.dateTime(d, { hour: '2-digit' })`) NO heredan nada de esta tabla
 * y caían a la zona del navegador. Por eso el `timeZone` global va también
 * en el return de getRequestConfig (ver abajo), que es lo que use-intl
 * mergea cuando el call-site no trae `timeZone` propio.
 */
/**
 * Zona de TODA la app: el dominio sísmico trabaja en UTC y todas las fuentes
 * (USGS, EMSC, endtime de ObsPy) ya llegan en UTC. Fuente de verdad única —
 * `lib/test-intl.tsx` la re-exporta en vez de declarar la suya, así un test
 * no puede pasar en verde con producción mal configurada.
 */
export const APP_TIME_ZONE = 'UTC';

export const formats = {
  dateTime: {
    medium: { dateStyle: 'medium', timeStyle: 'medium', timeZone: APP_TIME_ZONE },
    short: { dateStyle: 'short', timeStyle: 'short', timeZone: APP_TIME_ZONE },
    time: { timeStyle: 'medium', timeZone: APP_TIME_ZONE },
  },
} as const;

/**
 * Primer idioma soportado del header Accept-Language, en orden de
 * aparición (los navegadores ya lo mandan ordenado por prioridad `q`).
 * Devuelve null si ningún tag mapea a un locale soportado.
 */
function localeFromAcceptLanguage(header: string): AppLocale | null {
  for (const entry of header.split(',')) {
    const tag = entry.split(';')[0]?.trim().toLowerCase();
    if (!tag) continue;
    const language = tag.split('-')[0];
    if (isAppLocale(language)) return language;
  }
  return null;
}

/**
 * Cascada server-side, una vez por request (design, Decision 3):
 * (1) cookie NEXT_LOCALE si vale es|en; (2) Accept-Language; (3) 'es'.
 * Un valor NO soportado en cualquier eslabón se trata como ausente y la
 * cascada sigue — nunca rompe el render. users.locale NO se resuelve acá
 * (lo reconcilia LocaleSync client-side): tocar la base o verificar sesión
 * en cada request server está PROHIBIDO por design.
 */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const headerStore = await headers();

  let appLocale: AppLocale | null = null;

  const cookieValue = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isAppLocale(cookieValue)) {
    appLocale = cookieValue;
  }

  if (appLocale === null) {
    const acceptLanguage = headerStore.get('accept-language');
    if (acceptLanguage) {
      appLocale = localeFromAcceptLanguage(acceptLanguage);
    }
  }

  if (appLocale === null) {
    appLocale = DEFAULT_LOCALE;
  }

  return {
    locale: FORMAT_LOCALES[appLocale],
    messages: (await import(`../messages/${appLocale}.json`)).default,
    formats,
    // Zona por defecto de TODA la app, incluidas las llamadas con opciones
    // inline que `formats` no alcanza. Sin esto, use-intl emite
    // ENVIRONMENT_FALLBACK y usa la zona del navegador.
    timeZone: APP_TIME_ZONE,
  };
});
