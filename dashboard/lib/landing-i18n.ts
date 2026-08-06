/**
 * i18n autocontenido de la landing pública (ES/EN).
 *
 * Diccionarios planos en vez de next-intl a propósito: la landing es UNA
 * página con texto estático y no justifica reestructurar el App Router en
 * rutas [locale]. Cuando el dashboard entero se internacionalice (cambio SDD
 * aparte, ya en el roadmap), esto se migra a esa infraestructura.
 *
 * El locale se detecta de navigator.language y se persiste en localStorage
 * cuando el visitante usa el toggle — su elección explícita gana sobre la
 * heurística del navegador.
 */

export type LandingLocale = 'es' | 'en';

const STORAGE_KEY = 'landing-locale';

export interface LandingCopy {
  nav: {
    login: string;
    /** Etiqueta del toggle: muestra el idioma DESTINO, no el actual. */
    localeToggle: string;
    localeToggleAria: string;
  };
  hero: {
    badge: string;
    titleTop: string;
    titleAccent: string;
    subtitle: string;
    ctaPrimary: string;
    ctaSecondary: string;
    statsTracked: string;
    statsMax: string;
    statsLast: string;
    tickerTitle: string;
    /** Abreviatura de profundidad en la infocard ("prof." / "depth"). */
    depthShort: string;
  };
  how: {
    kicker: string;
    title: string;
    steps: readonly { title: string; description: string }[];
  };
  features: {
    kicker: string;
    title: string;
    items: readonly { title: string; description: string }[];
  };
  cta: {
    titleTop: string;
    titleAccent: string;
    subtitle: string;
    button: string;
  };
  footer: {
    tagline: string;
    beta: {
      title: string;
      subtitle: string;
      placeholder: string;
      button: string;
      sending: string;
      success: string;
      invalid: string;
      error: string;
      emailLabel: string;
    };
    productColumn: string;
    dataColumn: string;
    linkHow: string;
    linkFeatures: string;
    linkLogin: string;
    sources: string;
    coverage: string;
    history: string;
    legal: string;
  };
}

export const LANDING_COPY: Record<LandingLocale, LandingCopy> = {
  es: {
    nav: {
      login: 'Iniciar sesión',
      localeToggle: 'EN',
      localeToggleAria: 'Switch to English',
    },
    hero: {
      badge: 'Monitoreo en vivo',
      titleTop: 'La Tierra no avisa.',
      titleAccent: 'GeoSpectrum sí.',
      subtitle:
        'Monitoreo sísmico global en tiempo real: ingesta continua de USGS, EMSC e INPRES, detección de enjambres, espectrogramas en vivo y alertas sobre las áreas que a usted le importan.',
      ctaPrimary: 'Explorar el monitor',
      ctaSecondary: 'Cómo funciona',
      statsTracked: 'eventos en seguimiento',
      statsMax: 'máxima',
      statsLast: 'último',
      tickerTitle: 'Actividad reciente',
      depthShort: 'prof.',
    },
    how: {
      kicker: 'Cómo funciona',
      title: 'Del sensor a su pantalla, en un flujo continuo',
      steps: [
        {
          title: 'Ingesta multi-fuente',
          description:
            'Eventos M3.0+ de todo el planeta desde USGS, EMSC e INPRES, deduplicados y normalizados en un catálogo único que se actualiza de forma continua.',
        },
        {
          title: 'Análisis en tiempo real',
          description:
            'KPIs por área, detección de enjambres, eventos significativos y actividad sentida — calculados sobre el catálogo vivo, no sobre reportes viejos.',
        },
        {
          title: 'Alertas y visualización',
          description:
            'Globo 3D, mapas con placas tectónicas y espectrogramas en vivo. Las alertas se disparan sobre sus áreas de interés, no sobre el mundo entero.',
        },
      ],
    },
    features: {
      kicker: 'Capacidades',
      title: 'Una sala de control sísmica, no otro visor de mapas',
      items: [
        {
          title: 'Globo 3D en vivo',
          description:
            'El Anillo de Fuego completo, sin cortes de proyección: cada sismo pulsa sobre la esfera con tamaño y color según su magnitud.',
        },
        {
          title: 'Mapas con contexto tectónico',
          description:
            'Límites de placas estilizados por tipo de borde, ciudades de referencia y encuadre automático del área activa.',
        },
        {
          title: 'Espectrogramas en vivo',
          description:
            'Señal sísmica cruda de estaciones vía SeedLink, renderizada en el navegador — lo que la estación escucha, usted lo ve.',
        },
        {
          title: 'Áreas de interés propias',
          description:
            'Defina las regiones que le importan — los Andes, Japón, Cascadia — y el monitor filtra eventos, KPIs y alertas para cada una.',
        },
        {
          title: 'Histórico de 12 meses',
          description:
            'Un año de catálogo consultable para comparar la actividad de hoy contra la línea de base real de la región.',
        },
        {
          title: 'Alertas inteligentes',
          description:
            'Enjambres, eventos significativos y actividad sentida — clasificados por severidad, sin ruido de fondo.',
        },
      ],
    },
    cta: {
      titleTop: 'El planeta ya está en movimiento.',
      titleAccent: 'Empiece a mirarlo en serio.',
      subtitle:
        'Acceda con su cuenta de Google y explore la actividad sísmica global con las mismas herramientas que ve en esta página.',
      button: 'Iniciar sesión',
    },
    footer: {
      tagline:
        'Sala de control sísmica global: datos en vivo, contexto tectónico y alertas sobre sus áreas de interés.',
      beta: {
        title: 'Sumarse a la beta',
        subtitle:
          'Deje su email y le enviamos una invitación cuando se abra el próximo cupo.',
        placeholder: 'su@email.com',
        button: 'Quiero mi invitación',
        sending: 'Enviando…',
        success: 'Listo — le avisamos cuando haya cupo.',
        invalid: 'Ingrese un email válido.',
        error: 'No se pudo registrar. Intente de nuevo en unos minutos.',
        emailLabel: 'Email para la beta',
      },
      productColumn: 'Producto',
      dataColumn: 'Datos',
      linkHow: 'Cómo funciona',
      linkFeatures: 'Capacidades',
      linkLogin: 'Iniciar sesión',
      sources: 'Fuentes: USGS · EMSC · INPRES',
      coverage: 'Cobertura global M3.0+',
      history: 'Histórico de 12 meses',
      legal: '© 2026 GeoSpectrum · geospectrum.org',
    },
  },
  en: {
    nav: {
      login: 'Sign in',
      localeToggle: 'ES',
      localeToggleAria: 'Cambiar a español',
    },
    hero: {
      badge: 'Live monitoring',
      titleTop: "The Earth doesn't warn you.",
      titleAccent: 'GeoSpectrum does.',
      subtitle:
        'Global seismic monitoring in real time: continuous ingestion from USGS, EMSC and INPRES, swarm detection, live spectrograms and alerts on the areas you care about.',
      ctaPrimary: 'Explore the monitor',
      ctaSecondary: 'How it works',
      statsTracked: 'events tracked',
      statsMax: 'max',
      statsLast: 'latest',
      tickerTitle: 'Recent activity',
      depthShort: 'depth',
    },
    how: {
      kicker: 'How it works',
      title: 'From the sensor to your screen, in one continuous flow',
      steps: [
        {
          title: 'Multi-source ingestion',
          description:
            'M3.0+ events worldwide from USGS, EMSC and INPRES, deduplicated and normalized into a single catalog that updates continuously.',
        },
        {
          title: 'Real-time analysis',
          description:
            'Per-area KPIs, swarm detection, significant events and felt activity — computed on the live catalog, not on stale reports.',
        },
        {
          title: 'Alerts and visualization',
          description:
            '3D globe, maps with tectonic plates and live spectrograms. Alerts fire on your areas of interest, not on the whole world.',
        },
      ],
    },
    features: {
      kicker: 'Capabilities',
      title: 'A seismic control room, not another map viewer',
      items: [
        {
          title: 'Live 3D globe',
          description:
            'The full Ring of Fire, with no projection cuts: every quake pulses on the sphere, sized and colored by magnitude.',
        },
        {
          title: 'Maps with tectonic context',
          description:
            'Plate boundaries styled by boundary type, reference cities and automatic framing of the active area.',
        },
        {
          title: 'Live spectrograms',
          description:
            'Raw seismic signal from stations via SeedLink, rendered in your browser — what the station hears, you see.',
        },
        {
          title: 'Your own areas of interest',
          description:
            'Define the regions you care about — the Andes, Japan, Cascadia — and the monitor filters events, KPIs and alerts for each one.',
        },
        {
          title: '12 months of history',
          description:
            "A year of queryable catalog to compare today's activity against the region's real baseline.",
        },
        {
          title: 'Smart alerts',
          description:
            'Swarms, significant events and felt activity — classified by severity, without background noise.',
        },
      ],
    },
    cta: {
      titleTop: 'The planet is already moving.',
      titleAccent: 'Start watching it for real.',
      subtitle:
        'Sign in with your Google account and explore global seismic activity with the same tools you see on this page.',
      button: 'Sign in',
    },
    footer: {
      tagline:
        'A global seismic control room: live data, tectonic context and alerts on your areas of interest.',
      beta: {
        title: 'Join the beta',
        subtitle:
          "Leave your email and we'll send you an invitation when the next spots open.",
        placeholder: 'you@email.com',
        button: 'Request my invite',
        sending: 'Sending…',
        success: "Done — we'll let you know when a spot opens.",
        invalid: 'Enter a valid email.',
        error: "Couldn't sign you up. Try again in a few minutes.",
        emailLabel: 'Email for the beta',
      },
      productColumn: 'Product',
      dataColumn: 'Data',
      linkHow: 'How it works',
      linkFeatures: 'Capabilities',
      linkLogin: 'Sign in',
      sources: 'Sources: USGS · EMSC · INPRES',
      coverage: 'Global coverage M3.0+',
      history: '12 months of history',
      legal: '© 2026 GeoSpectrum · geospectrum.org',
    },
  },
};

/**
 * Locale inicial: la elección persistida del visitante gana; si no hay,
 * decide el idioma del navegador. Sólo puede correr en el cliente.
 */
export function detectLandingLocale(): LandingLocale {
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'es' || stored === 'en') return stored;

  return navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en';
}

/** Persiste la elección explícita del toggle. */
export function storeLandingLocale(locale: LandingLocale): void {
  window.localStorage.setItem(STORAGE_KEY, locale);
}

/**
 * Tiempo relativo corto para el ticker ("hace 12 min" / "12 min ago").
 * A mano en vez de una librería de fechas: son tres rangos y un sufijo.
 */
export function relativeTime(isoUtc: string, locale: LandingLocale): string {
  const diffMs = Date.now() - new Date(isoUtc).getTime();
  const minutes = Math.max(0, Math.round(diffMs / 60_000));
  const hours = Math.round(minutes / 60);
  const days = Math.round(hours / 24);

  const value = minutes < 60 ? `${minutes} min` : hours < 24 ? `${hours} h` : `${days} d`;
  return locale === 'es' ? `hace ${value}` : `${value} ago`;
}
