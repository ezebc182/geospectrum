/**
 * Selector de ventanas de /analytics (analytics-professional-panels, 5.2;
 * spec dashboard-ui "Selectores de ventana temporal", Decisión 1).
 *
 * Lo que se afirma: son DOS grupos independientes (días de catálogo y horas
 * de señal) con callbacks separados — elegir un preset de un grupo NO dispara
 * el callback del otro — y el activo se marca con `aria-pressed`. Los textos
 * salen de los JSON reales vía `t(...)`.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { IntlTestProvider } from '@/lib/test-intl';
import {
  AnalyticsWindowSelector,
  CATALOG_DAYS_PRESETS,
  SIGNAL_WINDOW_PRESETS,
} from './AnalyticsWindowSelector';

function renderSelector(over: Partial<Parameters<typeof AnalyticsWindowSelector>[0]> = {}) {
  const onCatalogDaysChange = vi.fn();
  const onSignalWindowChange = vi.fn();
  render(
    <IntlTestProvider>
      <AnalyticsWindowSelector
        catalogDays={30}
        signalWindowHours={24}
        onCatalogDaysChange={onCatalogDaysChange}
        onSignalWindowChange={onSignalWindowChange}
        {...over}
      />
    </IntlTestProvider>,
  );
  return { onCatalogDaysChange, onSignalWindowChange };
}

const daysLabel = (count: number) => es.analytics.window.days.replace('{count}', String(count));
const hoursLabel = (count: number) => es.analytics.window.hours.replace('{count}', String(count));

afterEach(cleanup);

describe('AnalyticsWindowSelector', () => {
  it('expone los presets del design: 7/30/90/365 días y 6/12/24 h', () => {
    expect(CATALOG_DAYS_PRESETS).toEqual([7, 30, 90, 365]);
    expect(SIGNAL_WINDOW_PRESETS).toEqual([6, 12, 24]);
  });

  it('renderiza los dos grupos con sus títulos i18n y un botón por preset', () => {
    renderSelector();
    expect(screen.getByText(es.analytics.window.catalogDays)).toBeInTheDocument();
    expect(screen.getByText(es.analytics.window.signalWindow)).toBeInTheDocument();
    for (const d of CATALOG_DAYS_PRESETS) {
      expect(screen.getByRole('button', { name: daysLabel(d) })).toBeInTheDocument();
    }
    for (const h of SIGNAL_WINDOW_PRESETS) {
      expect(screen.getByRole('button', { name: hoursLabel(h) })).toBeInTheDocument();
    }
  });

  it('marca con aria-pressed SOLO el preset activo de cada grupo', () => {
    renderSelector({ catalogDays: 90, signalWindowHours: 6 });
    expect(screen.getByRole('button', { name: daysLabel(90) })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: daysLabel(30) })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: hoursLabel(6) })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: hoursLabel(24) })).toHaveAttribute('aria-pressed', 'false');
  });

  it('elegir 7 días llama a onCatalogDaysChange(7) y NO al callback de señal', () => {
    const { onCatalogDaysChange, onSignalWindowChange } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: daysLabel(7) }));
    expect(onCatalogDaysChange).toHaveBeenCalledTimes(1);
    expect(onCatalogDaysChange).toHaveBeenCalledWith(7);
    expect(onSignalWindowChange).not.toHaveBeenCalled();
  });

  it('elegir 6 h llama a onSignalWindowChange(6) y NO al callback de catálogo', () => {
    const { onCatalogDaysChange, onSignalWindowChange } = renderSelector();
    fireEvent.click(screen.getByRole('button', { name: hoursLabel(6) }));
    expect(onSignalWindowChange).toHaveBeenCalledTimes(1);
    expect(onSignalWindowChange).toHaveBeenCalledWith(6);
    expect(onCatalogDaysChange).not.toHaveBeenCalled();
  });
});
