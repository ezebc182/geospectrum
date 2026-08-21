import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import es from '@/messages/es.json';
import type { WallLayout } from '@/lib/types';
import { MAX_WALL_TEXT_LEN } from '@/lib/wall-editor';
import { WallBuilder } from './WallBuilder';

const TOKYO = { channel: 'IU.MAJO.00.BHZ', label: 'Tokyo' };
const LIMA = { channel: 'II.NNA.00.BHZ', label: 'Lima' };

const LAYOUT: WallLayout = {
  columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO] }] }],
  showMetrics: false,
};

function renderBuilder(layout: WallLayout = LAYOUT, onChange = vi.fn()) {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <WallBuilder layout={layout} onChange={onChange} catalog={[TOKYO, LIMA]} />
    </NextIntlClientProvider>
  );
  return onChange;
}

afterEach(cleanup);

describe('WallBuilder', () => {
  it('agrega un canal del catálogo al grupo activo', () => {
    const onChange = renderBuilder();
    // botón "Agregar" DENTRO de la fila de Lima del catálogo (Tokyo ya está en el muro)
    const limaRow = screen.getByText('Lima').closest('li')!;
    fireEvent.click(within(limaRow).getByRole('button'));
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].channels).toEqual([TOKYO, LIMA]);
  });

  it('el canal ya presente en el muro tiene su botón deshabilitado', () => {
    renderBuilder();
    // "Tokyo" aparece dos veces (catálogo + estructura del muro): se busca
    // puntualmente dentro del catálogo, igual que el ajuste ya usado en el
    // test de "Agregar" (ver nota del brief, Step 4).
    const catalog = within(screen.getByTestId('wall-catalog'));
    const row = catalog.getByText('Tokyo').closest('li')!;
    expect(row.querySelector('button')!.hasAttribute('disabled')).toBe(true);
  });

  it('la búsqueda filtra el catálogo por label y por canal', () => {
    renderBuilder();
    fireEvent.change(screen.getByPlaceholderText('Buscar canal o ciudad'), {
      target: { value: 'NNA' },
    });
    const catalog = within(screen.getByTestId('wall-catalog'));
    expect(catalog.queryByText('Tokyo')).toBeNull();
    expect(catalog.getByText('Lima')).toBeTruthy();
  });

  it('el input de título de grupo respeta el límite del backend (MAX_WALL_TEXT_LEN)', () => {
    renderBuilder();
    const input = screen.getByDisplayValue('ASIA') as HTMLInputElement;
    expect(input.maxLength).toBe(MAX_WALL_TEXT_LEN);
  });

  it('renombrar el grupo dispara onChange con el título nuevo', () => {
    const onChange = renderBuilder();
    fireEvent.change(screen.getByDisplayValue('ASIA'), { target: { value: 'PACÍFICO' } });
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].title).toBe('PACÍFICO');
  });

  it('las flechas reordenan canales dentro del grupo', () => {
    const layout: WallLayout = {
      columns: [{ groups: [{ title: 'ASIA', channels: [TOKYO, LIMA] }] }],
      showMetrics: false,
    };
    const onChange = renderBuilder(layout);
    // fila de Tokyo dentro de la estructura del muro (no del catálogo)
    const rows = screen.getAllByTestId('builder-channel-row');
    fireEvent.click(rows[0].querySelector('button[aria-label="Bajar"]')!);
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[0].channels).toEqual([LIMA, TOKYO]);
  });

  it('agregar columna y grupo', () => {
    const onChange = renderBuilder();
    fireEvent.click(screen.getByRole('button', { name: 'Agregar columna' }));
    expect((onChange.mock.calls[0][0] as WallLayout).columns).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Agregar grupo' })[0]);
    const withGroup = onChange.mock.calls[1][0] as WallLayout;
    expect(withGroup.columns[0].groups).toHaveLength(2);
  });

  it('el selector de grupo es accesible por teclado (foco + Enter activa el grupo)', () => {
    const layout: WallLayout = {
      columns: [
        {
          groups: [
            { title: 'ASIA', channels: [] },
            { title: 'AMÉRICA', channels: [] },
          ],
        },
      ],
      showMetrics: false,
    };
    const onChange = renderBuilder(layout);
    // El armador arranca con { col: 0, group: 0 } activo — enfocar y activar
    // por teclado el segundo grupo (AMÉRICA) y confirmar que "Agregar" desde
    // el catálogo cae ahí, no en el grupo por defecto.
    const groupSelectors = screen.getAllByRole('button', { name: 'Elegir grupo' });
    expect(groupSelectors).toHaveLength(2);
    groupSelectors[1].focus();
    fireEvent.keyDown(groupSelectors[1], { key: 'Enter' });

    const limaRow = screen.getByText('Lima').closest('li')!;
    fireEvent.click(within(limaRow).getByRole('button'));
    const next = onChange.mock.calls[0][0] as WallLayout;
    expect(next.columns[0].groups[1].channels).toEqual([LIMA]);
    expect(next.columns[0].groups[0].channels).toEqual([]);
  });

  it('operar los controles de un grupo no activo no lo selecciona (click no burbujea)', () => {
    const layout: WallLayout = {
      columns: [
        {
          groups: [
            { title: 'ASIA', channels: [] },
            { title: 'AMÉRICA', channels: [] },
          ],
        },
      ],
      showMetrics: false,
    };
    const onChange = renderBuilder(layout);
    // Grupo activo por defecto: { col: 0, group: 0 } (ASIA). Clickear el
    // input de título del segundo grupo (AMÉRICA, no activo) es un click
    // real que burbujea por el DOM hasta el selector del grupo si no se
    // corta — no debe cambiar la selección: el "Agregar" siguiente debe
    // seguir cayendo en ASIA.
    fireEvent.click(screen.getByDisplayValue('AMÉRICA'));

    const limaRow = screen.getByText('Lima').closest('li')!;
    fireEvent.click(within(limaRow).getByRole('button'));
    const afterAdd = onChange.mock.calls[0][0] as WallLayout;
    expect(afterAdd.columns[0].groups[0].channels).toEqual([LIMA]);
    expect(afterAdd.columns[0].groups[1].channels).toEqual([]);
  });
});
