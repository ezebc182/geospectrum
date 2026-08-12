/**
 * Pasos del tour de onboarding (email-invitations, Decision 7).
 *
 * Definición declarativa, separada del hook: los textos y el orden se ajustan
 * acá sin tocar la mecánica de driver.js. Cada paso ancla por su atributo
 * `data-tour-id` propio — NUNCA por clases de Tailwind ni estructura del DOM,
 * que son volátiles (riesgo explícito del proposal: el dashboard se rediseñó
 * hace días).
 *
 * El tour NO navega entre páginas (design.md): resalta las entradas de
 * navegación (p. ej. el link al Globo 3D en el sidebar) en vez de visitar
 * cada sección.
 *
 * El import de tipos es type-only: se borra al compilar, así este módulo no
 * arrastra driver.js al bundle — el runtime entra solo por el import dinámico
 * de useTour.ts.
 */

import type { DriveStep } from 'driver.js';

export const TOUR_STEPS: DriveStep[] = [
  {
    element: '[data-tour-id="map"]',
    popover: {
      title: 'Mapa de epicentros',
      description:
        'Acá viven los eventos sísmicos de tu área de interés en tiempo real: ' +
        'cada círculo es un sismo, con tamaño y color según su magnitud. ' +
        'Podés activar capas (placas tectónicas, ciudades) desde el botón de Capas.',
      side: 'top',
      align: 'center',
    },
  },
  {
    element: '[data-tour-id="nav-globe"]',
    popover: {
      title: 'Globo 3D',
      description:
        'La misma actividad sísmica, pero sobre un globo terráqueo interactivo: ' +
        'ideal para ver la actividad global de un vistazo y entender los patrones ' +
        'a escala planetaria.',
      side: 'right',
      align: 'start',
    },
  },
  {
    element: '[data-tour-id="area-selector"]',
    popover: {
      title: 'Áreas de interés',
      description:
        'Elegí qué región monitorear: Andes, Japón, Cascadia y más. ' +
        'El área activa condiciona todo el dashboard — mapa, indicadores, ' +
        'tabla de eventos y alertas.',
      side: 'bottom',
      align: 'start',
    },
  },
  {
    element: '[data-tour-id="alerts-bell"]',
    popover: {
      title: 'Alertas',
      description:
        'La campana concentra las alertas activas: eventos significativos, ' +
        'enjambres y actividad sentida en tu área. El número indica cuántas ' +
        'hay ahora mismo.',
      side: 'bottom',
      align: 'end',
    },
  },
];
