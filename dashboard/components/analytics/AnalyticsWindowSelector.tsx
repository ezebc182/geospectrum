/**
 * Selectores de ventana de /analytics (analytics-professional-panels, 5.2;
 * design Decision 8, spec dashboard-ui Decisión 1).
 *
 * Son DOS controles a propósito: los días de catálogo (b-value, hipocentros,
 * uptime: `seismic_events` tiene ~1 año) y las horas de señal (RSAM y tremor:
 * FDSN tiene tope de 24 h). Un selector único obligaría a mentir en un
 * extremo ("365 días" de RSAM que devuelve 24 h). Componente controlado: la
 * página guarda el estado y decide qué re-pide cada cambio.
 */

'use client';

import { useTranslations } from 'next-intl';

export const CATALOG_DAYS_PRESETS = [7, 30, 90, 365] as const;
export const SIGNAL_WINDOW_PRESETS = [6, 12, 24] as const;

export type CatalogDays = (typeof CATALOG_DAYS_PRESETS)[number];
export type SignalWindowHours = (typeof SIGNAL_WINDOW_PRESETS)[number];

interface AnalyticsWindowSelectorProps {
  catalogDays: CatalogDays;
  signalWindowHours: SignalWindowHours;
  onCatalogDaysChange: (days: CatalogDays) => void;
  onSignalWindowChange: (hours: SignalWindowHours) => void;
  className?: string;
}

interface PresetGroupProps<T extends number> {
  label: string;
  presets: readonly T[];
  active: T;
  format: (value: T) => string;
  onChange: (value: T) => void;
}

function PresetGroup<T extends number>({ label, presets, active, format, onChange }: PresetGroupProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>
      <div className="inline-flex overflow-hidden rounded-md border border-gray-300 dark:border-gray-600">
        {presets.map((value) => {
          const isActive = value === active;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(value)}
              className={
                'px-3 py-1 text-sm transition-colors ' +
                (isActive
                  ? 'bg-seismic-600 text-white'
                  : 'bg-white text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700')
              }
            >
              {format(value)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function AnalyticsWindowSelector({
  catalogDays,
  signalWindowHours,
  onCatalogDaysChange,
  onSignalWindowChange,
  className,
}: AnalyticsWindowSelectorProps) {
  const t = useTranslations('analytics');

  return (
    <div className={className ?? 'flex flex-wrap items-center gap-6'}>
      <PresetGroup
        label={t('window.catalogDays')}
        presets={CATALOG_DAYS_PRESETS}
        active={catalogDays}
        format={(count) => t('window.days', { count })}
        onChange={onCatalogDaysChange}
      />
      <PresetGroup
        label={t('window.signalWindow')}
        presets={SIGNAL_WINDOW_PRESETS}
        active={signalWindowHours}
        format={(count) => t('window.hours', { count })}
        onChange={onSignalWindowChange}
      />
    </div>
  );
}
