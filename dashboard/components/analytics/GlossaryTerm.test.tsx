/**
 * Tests de `GlossaryTerm` — el disparador de definición del glosario v1.
 *
 * Interacción con Radix: `fireEvent.click` PELADO sobre un trigger de Radix es
 * VERDE FALSO (lección ya pagada en este repo con Radix Tabs). Radix escucha
 * `pointerdown`/`mousedown`, no `click`. Acá se usa esa secuencia para el mouse
 * y `keyDown` real para el teclado. `@testing-library/user-event` NO está
 * instalado en este repo (no figura en `package.json` ni en `node_modules`), y
 * esta fase no agrega dependencias: el camino equivalente es el que ya usa
 * `app/(app)/analytics/page.test.tsx`.
 *
 * Lo que jsdom NO puede verificar: que el popover no quede recortado, su
 * posición, ni el foco visible. jsdom no hace layout. Lo que sí se verifica —y
 * es lo que importa acá— es la PRESENCIA/AUSENCIA del contenido en el DOM, que
 * es exactamente lo que rompería montar el contenido a la fuerza.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GlossaryTerm } from './GlossaryTerm';
import { IntlTestProvider } from '@/lib/test-intl';
import es from '@/messages/es.json';

afterEach(cleanup);

const FUENTE = readFileSync(join(import.meta.dirname, 'GlossaryTerm.tsx'), 'utf8');

/**
 * Activa el trigger POR TECLADO, como lo hace un navegador de verdad.
 *
 * MEDIDO con una sonda, no supuesto: sobre este `Popover` de Radix, un
 * `fireEvent.keyDown` de Enter SOLO deja `aria-expanded="false"` — jsdom no
 * deriva el `click` nativo que un navegador dispara al activar un `<button>`
 * con Enter/Space. Emitir la secuencia completa es lo que replica el browser;
 * quedarse en `keyDown` sería testear jsdom, no el componente.
 *
 * Lo que este helper SIGUE probando: que el trigger sea un elemento
 * ACTIVABLE por teclado. Si dejara de ser un `<button>` (un `<span onClick>`,
 * por ejemplo) no sería focusable ni recibiría la activación, y los casos que
 * lo usan caen.
 */
function activarConTeclado(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.keyUp(trigger, { key: 'Enter', code: 'Enter' });
  fireEvent.click(trigger, { detail: 0 });
}

describe('GlossaryTerm', () => {
  // Caso 1 — el trigger es un botón REAL, no un span con onClick: eso es lo que
  // le da teclado y semántica al lector de pantalla, gratis, desde Radix.
  it('el trigger es un role="button" con nombre accesible salido de i18n', () => {
    render(
      <IntlTestProvider>
        <GlossaryTerm id="b-value" />
      </IntlTestProvider>,
    );

    const esperado = es.analytics.glossary.trigger.replace(
      '{term}',
      es.analytics.glossary.bValue.term,
    );
    expect(screen.getByRole('button', { name: esperado })).toBeInTheDocument();
  });

  // Caso 2 — apertura POR TECLADO y cierre con Esc devolviendo el foco. Es todo
  // comportamiento de Radix; el componente no lo reimplementa, pero si el
  // trigger dejara de ser un <button> se perdería y este caso lo ve.
  it('abre con teclado y al cerrar con Esc el foco vuelve al trigger', async () => {
    render(
      <IntlTestProvider>
        <GlossaryTerm id="mc" />
      </IntlTestProvider>,
    );

    const trigger = screen.getByRole('button');

    // Focusable SIN tabindex postizo: es la mitad del caso que un `<span>`
    // pierde. `HTMLButtonElement` además garantiza la activación por teclado.
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(trigger).toBeInstanceOf(HTMLButtonElement);

    activarConTeclado(trigger);
    await waitFor(() => {
      expect(screen.getByText(es.analytics.glossary.mc.definition)).toBeInTheDocument();
    });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText(es.analytics.glossary.mc.definition)).toBeNull();
    });
    expect(trigger).toHaveFocus();
  });

  // Caso 3 — el assert que MATA el montaje forzado del contenido cerrado.
  // Se mira PRESENCIA en el DOM, no visibilidad: jsdom no mide visibilidad, así
  // que un assert de "no se ve" sería verde falso garantizado.
  it('con el popover cerrado la definición NO está en el DOM', () => {
    render(
      <IntlTestProvider>
        <GlossaryTerm id="rsam" />
      </IntlTestProvider>,
    );

    expect(screen.queryByText(es.analytics.glossary.rsam.definition)).toBeNull();
  });

  // Caso 4 — una entrada de i18n, N invocaciones: el mismo término desde dos
  // lugares dice EXACTAMENTE lo mismo. Si alguien duplicara la definición en un
  // call-site, acá se ve.
  it('el mismo término desde dos lugares resuelve el mismo texto', async () => {
    render(
      <IntlTestProvider>
        <div>
          <GlossaryTerm id="mc" />
          <GlossaryTerm id="mc" />
        </div>
      </IntlTestProvider>,
    );

    const [primero, segundo] = screen.getAllByRole('button');

    activarConTeclado(primero);
    await waitFor(() => {
      expect(screen.getByText(es.analytics.glossary.mc.definition)).toBeInTheDocument();
    });
    const textoPrimero = screen.getByText(es.analytics.glossary.mc.definition).textContent;

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText(es.analytics.glossary.mc.definition)).toBeNull();
    });

    activarConTeclado(segundo);
    await waitFor(() => {
      expect(screen.getByText(es.analytics.glossary.mc.definition)).toBeInTheDocument();
    });
    const textoSegundo = screen.getByText(es.analytics.glossary.mc.definition).textContent;

    expect(textoSegundo).toBe(textoPrimero);
  });

  // Caso 5 — dos prohibiciones sobre el FUENTE. El hex, porque
  // `chart-chrome.test.ts` no cubre este archivo (no importa recharts). El
  // montaje forzado, porque deja contenido inactivo visible al lector de
  // pantalla y ningún assert de DOM con el popover abierto lo detectaría.
  it('el fuente no tiene hex ni monta a la fuerza el contenido cerrado', () => {
    expect(FUENTE.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []).toEqual([]);
    expect(FUENTE).not.toMatch(/forceMount/);
  });
});
