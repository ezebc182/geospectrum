'use client';

/**
 * Presentación de las advertencias que produce `lib/analytics-warnings.ts`.
 *
 * Presentacional PURO: sin estado, sin efectos, sin red. Recibe la lista ya
 * calculada y la dibuja. No decide QUÉ advertir — eso es de la lib— ni CUÁNDO
 * pedirla — eso es del panel (Fase 3).
 *
 * Tres reglas que NO son cosméticas:
 *
 * 1. **Icono + texto, nunca color solo** (WCAG 1.4.1). Un daltónico distingue
 *    `critical` de `warning` por la FORMA del icono (triángulo vs círculo), y
 *    el nivel además viaja como TEXTO alcanzable por el lector de pantalla. El
 *    icono va `aria-hidden`: su significado ya está en ese texto, y anunciar
 *    "triángulo" no aporta nada.
 * 2. **`role="alert"` SOLO para `critical`.** `alert` es una live region
 *    assertive: INTERRUMPE al lector de pantalla. Un panel con cuatro `info` en
 *    `role="alert"` convierte la página en un atropello sonoro. `status` es
 *    polite y se anuncia cuando el usuario llega. La regla operativa: `alert`
 *    solo cuando el número que se ve en pantalla no es confiable — que es
 *    exactamente la definición de `critical`.
 * 3. **Tokens, nunca hex.** `--destructive` y `--warning` existen en `:root` y
 *    en `.dark` con sus `-foreground`, así que el tema lo resuelve la cascada
 *    sin `useTheme`. OJO: este archivo NO importa `recharts` a propósito, así
 *    que `chart-chrome.test.ts` NO lo descubre — un hex acá no lo atraparía
 *    nadie. Lo prohíbe su propio test.
 *
 * No recibe `className` ni `variant`: la severidad determina la apariencia, y
 * un override externo permitiría pintar un `critical` de gris. El espaciado lo
 * pone el contenedor, que es Fase 3.
 */

import { AlertCircle, Info, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { AnalyticsWarning as AnalyticsWarningData, WarningSeverity } from '@/lib/analytics-warnings';
import { cn } from '@/lib/utils';

/** Severidad → cromo, icono y rol ARIA. Tabla cerrada por el tipo. */
const SEVERITY_STYLES: Record<
  WarningSeverity,
  { className: string; Icon: typeof Info; role: 'alert' | 'status' }
> = {
  critical: {
    className: 'border-destructive/40 bg-destructive/10 text-destructive',
    Icon: TriangleAlert,
    role: 'alert',
  },
  warning: {
    className: 'border-warning/40 bg-warning/10 text-warning',
    Icon: AlertCircle,
    role: 'status',
  },
  info: {
    className: 'border-border bg-muted text-muted-foreground',
    Icon: Info,
    role: 'status',
  },
};

type Props = {
  warnings: readonly AnalyticsWarningData[];
};

export function AnalyticsWarning({ warnings }: Props) {
  const t = useTranslations('analytics');

  // Lista vacía ⇒ NINGÚN nodo. Ni contenedor, ni separador, ni espaciado
  // fantasma: "cero advertencias" es una red sana, no un bloque vacío.
  if (warnings.length === 0) {
    return null;
  }

  return (
    <>
      {warnings.map((warning) => {
        const { className, Icon, role } = SEVERITY_STYLES[warning.severity];

        return (
          <div
            key={warning.id}
            role={role}
            className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-xs', className)}
          >
            <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
            <p>
              {/* El nivel como TEXTO: es lo que hace que la severidad no
                  dependa únicamente del color para un lector de pantalla. */}
              <span className="font-medium">{t(`severity.${warning.severity}`)}: </span>
              <WarningMessage warning={warning} />
            </p>
          </div>
        );
      })}
    </>
  );
}

/**
 * `switch` exhaustivo por `id`: es el mecanismo que ata el contrato
 * lib↔clave i18n en COMPILE-TIME. Cada rama narrowa `params` al shape exacto
 * que declara esa regla, así que pasarle los params de otra regla no compila.
 * Una rama nueva en la lib sin su clave i18n tampoco compila (augmentation de
 * `global.d.ts`). No es verbosidad: es el único punto donde el compilador puede
 * comprobar que el id, sus params y la clave coinciden.
 */
function WarningMessage({ warning }: { warning: AnalyticsWarningData }) {
  const t = useTranslations('analytics.warnings');

  switch (warning.id) {
    case 'b-value.mc-at-catalog-floor':
      return <>{t('b-value.mc-at-catalog-floor', warning.params)}</>;
    case 'b-value.mixed-magnitude-scales':
      return <>{t('b-value.mixed-magnitude-scales', warning.params)}</>;
    case 'b-value.unknown-magnitude-type':
      return <>{t('b-value.unknown-magnitude-type', warning.params)}</>;
    case 'b-value.small-sample-above-mc':
      return <>{t('b-value.small-sample-above-mc', warning.params)}</>;
    case 'b-value.most-events-below-mc':
      return <>{t('b-value.most-events-below-mc', warning.params)}</>;
    case 'b-value.derived-sigma-interval':
      return <>{t('b-value.derived-sigma-interval', warning.params)}</>;
    case 'tremor.median-baseline-masking':
      return <>{t('tremor.median-baseline-masking', warning.params)}</>;
    case 'tremor.no-baseline':
      return <>{t('tremor.no-baseline')}</>;
    case 'tremor.emergent-onset':
      return <>{t('tremor.emergent-onset')}</>;
    case 'tremor.undefined-band':
      return <>{t('tremor.undefined-band')}</>;
    case 'uptime.channels-below-threshold':
      return <>{t('uptime.channels-below-threshold', warning.params)}</>;
    case 'uptime.channels-unobserved':
      return <>{t('uptime.channels-unobserved', warning.params)}</>;
  }
}
