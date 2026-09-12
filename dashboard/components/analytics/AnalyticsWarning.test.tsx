/**
 * Tests de `AnalyticsWarning` — el componente de presentación de una
 * advertencia de la lib pura (`lib/analytics-warnings.ts`).
 *
 * Lo que jsdom NO puede verificar, y por eso ningún caso lo promete:
 * jsdom no hace layout, no resuelve `hsl(var(--token))` contra la cascada y
 * nada mide más de 0×0. Acá se verifica que el componente DECLARE la clase del
 * token; que esa clase dé 4.5:1 no lo dice ningún unit test — lo ve el usuario.
 *
 * Por qué este archivo prohíbe hex por su cuenta: `chart-chrome.test.ts`
 * descubre archivos filtrando por `from 'recharts'`, y este componente NO
 * importa recharts a propósito (Decisión 7 del design). O sea: un hex acá NO
 * sería atrapado por aquel test. El hueco lo tapa el caso 5 de este archivo.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { AnalyticsWarning } from './AnalyticsWarning';
import { IntlTestProvider } from '@/lib/test-intl';
import type { AnalyticsWarning as AnalyticsWarningData } from '@/lib/analytics-warnings';
import es from '@/messages/es.json';

afterEach(cleanup);

const FUENTE = readFileSync(join(import.meta.dirname, 'AnalyticsWarning.tsx'), 'utf8');

/** Una advertencia por severidad, tomadas del catálogo real de la lib. */
const CRITICAL: AnalyticsWarningData = {
  id: 'b-value.mc-at-catalog-floor',
  severity: 'critical',
  params: { mc: 2.5 },
};

const WARNING: AnalyticsWarningData = {
  id: 'b-value.small-sample-above-mc',
  severity: 'warning',
  params: { nAboveMc: 60, minEvents: 50 },
};

const INFO: AnalyticsWarningData = {
  id: 'tremor.no-baseline',
  severity: 'info',
  params: {},
};

function renderWarnings(warnings: AnalyticsWarningData[]) {
  return render(
    <IntlTestProvider>
      <AnalyticsWarning warnings={warnings} />
    </IntlTestProvider>,
  );
}

describe('AnalyticsWarning', () => {
  // Caso 1 — el escenario "no depende ÚNICAMENTE del color" de la spec. Se
  // assertean las DOS cosas: texto de severidad alcanzable por el lector de
  // pantalla Y un icono con aria-hidden (la FORMA distingue, no solo el tono).
  it.each([
    ['critical', CRITICAL, es.analytics.severity.critical],
    ['warning', WARNING, es.analytics.severity.warning],
    ['info', INFO, es.analytics.severity.info],
  ])(
    'la severidad %s es alcanzable como texto y además lleva un icono con aria-hidden',
    (_severidad, warning, etiqueta) => {
      renderWarnings([warning]);

      // El texto de severidad existe DENTRO del nodo de la advertencia y es
      // alcanzable por el lector de pantalla: no está solo en el color.
      // Matcher de substring y no igualdad exacta porque el nivel se renderiza
      // como prefijo ("Crítico: …") pegado al mensaje.
      const nodo = screen.getByRole(warning.severity === 'critical' ? 'alert' : 'status');
      expect(nodo.textContent).toContain(etiqueta);

      // El icono está, y está oculto al lector de pantalla: su significado ya
      // viaja en el texto; que anuncie "triángulo" no aporta nada.
      const icono = nodo.querySelector('svg[aria-hidden="true"]');
      expect(icono).not.toBeNull();
    },
  );

  // Caso 2 — `alert` es una live region ASSERTIVE: interrumpe al lector. Cuatro
  // `info` en `role="alert"` convierten la página en un atropello sonoro.
  it('solo critical lleva role="alert"; warning e info llevan role="status"', () => {
    const { unmount } = renderWarnings([CRITICAL]);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
    unmount();

    renderWarnings([WARNING, INFO]);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  // Caso 3 — "sin contenedor ni separador". Se assertea la AUSENCIA del nodo,
  // no la ausencia de texto: un contenedor vacío con padding es espaciado
  // fantasma y pasaría un assert de texto.
  it('con la lista vacía no renderiza NINGÚN nodo en el DOM', () => {
    // Se monta en un contenedor PROPIO, no el de `renderWarnings`: el
    // `IntlTestProvider` trae el `ToastProvider`, que planta su region de
    // notificaciones en el contenedor y haría que `firstChild` nunca fuera
    // null. Lo que se mide acá es la salida del componente, no la del andamio.
    const propio = document.createElement('div');
    document.body.appendChild(propio);

    render(
      <IntlTestProvider>
        <AnalyticsWarning warnings={[]} />
      </IntlTestProvider>,
      { container: propio, baseElement: propio },
    );

    // El provider no aporta nodos propios al árbol del componente, así que lo
    // único que podría haber acá es el contenedor de la advertencia.
    expect(propio.querySelector('[role="alert"], [role="status"]')).toBeNull();
    expect(propio.textContent).toBe('');
  });

  // Caso 4 — el texto sale de i18n con los params interpolados, Y el literal no
  // está escrito en el .tsx. Un assert de DOM solo NO distingue "salió de i18n"
  // de "está hardcodeado y coincide": por eso se lee el fuente.
  it('el texto sale de i18n con los params interpolados, y el literal no está en el fuente', () => {
    renderWarnings([CRITICAL]);

    // La clave de `mc-at-catalog-floor` interpola {mc}: el valor tiene que
    // aparecer. Se assertea `2.5` con punto y no `2,5`: un placeholder plano de
    // next-intl inserta el número tal cual, NO lo formatea por locale. Darlo
    // por formateado sería inventarle al framework un comportamiento que no
    // tiene; si en la Fase 3 se quiere coma, va `{mc, number}` en la clave.
    const nodo = screen.getByRole('alert');
    expect(nodo.textContent).toContain('2.5');
    expect(nodo.textContent).toContain('piso de ingesta');

    // Y ese literal NO puede estar en el componente.
    expect(FUENTE).not.toMatch(/piso de ingesta/);
    expect(FUENTE).not.toMatch(/ingest floor/i);
  });

  // Caso 5 — NECESARIO porque `chart-chrome.test.ts` no cubre este archivo
  // (no importa recharts). Sin este caso, un hex acá pasaría sin que nada lo vea.
  it('el fuente no contiene ningún literal hexadecimal de color', () => {
    const hexes = FUENTE.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(hexes).toEqual([]);
  });

  // Caso 6 — lo verificable en jsdom es la DECLARACIÓN de la clase del token.
  // El contraste real no lo mide ningún unit test.
  it('las clases de color son tokens declarados, no valores computados', () => {
    const { unmount } = renderWarnings([CRITICAL]);
    expect(screen.getByRole('alert')).toHaveClass('text-destructive');
    unmount();

    renderWarnings([WARNING, INFO]);
    const [warning, info] = screen.getAllByRole('status');
    expect(warning).toHaveClass('text-warning');
    expect(info).toHaveClass('text-muted-foreground');
  });
});
