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
 * i18n (i18n-dashboard, Decision 5): los textos salen del diccionario, así que
 * la constante pasó a ser `buildTourSteps(t)` — useTour la invoca con el `t`
 * del namespace `onboarding` en cada arranque del tour, de modo que un cambio
 * de idioma se refleja en el próximo tour sin estado residual.
 *
 * Los imports son type-only: se borran al compilar, así este módulo no
 * arrastra driver.js ni next-intl al bundle — el runtime de driver.js entra
 * solo por el import dinámico de useTour.ts.
 */

import type { DriveStep } from 'driver.js';
import type { useTranslations } from 'next-intl';

/**
 * `t` del namespace `onboarding` con su tipado real de claves. El contrato
 * genérico `(key: string) => string` del design no compila: el `t` de
 * next-intl solo acepta las claves del namespace (más angosto que `string`),
 * y por contravarianza no es asignable a un parámetro que exige aceptar
 * cualquier string. El tipo exacto, type-only, resuelve ambas cosas.
 */
export type OnboardingTranslator = ReturnType<typeof useTranslations<'onboarding'>>;

export function buildTourSteps(t: OnboardingTranslator): DriveStep[] {
  return [
    {
      element: '[data-tour-id="map"]',
      popover: {
        title: t('tour.steps.map.title'),
        description: t('tour.steps.map.description'),
        side: 'top',
        align: 'center',
      },
    },
    {
      element: '[data-tour-id="nav-globe"]',
      popover: {
        title: t('tour.steps.globe.title'),
        description: t('tour.steps.globe.description'),
        side: 'right',
        align: 'start',
      },
    },
    {
      element: '[data-tour-id="area-selector"]',
      popover: {
        title: t('tour.steps.areas.title'),
        description: t('tour.steps.areas.description'),
        side: 'bottom',
        align: 'start',
      },
    },
    {
      element: '[data-tour-id="alerts-bell"]',
      popover: {
        title: t('tour.steps.alerts.title'),
        description: t('tour.steps.alerts.description'),
        side: 'bottom',
        align: 'end',
      },
    },
  ];
}
