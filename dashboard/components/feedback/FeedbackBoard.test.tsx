/**
 * Tests del tablero Kanban de feedback (tarea 4.1 del change
 * feedback-beta-testers). Renderiza con la config REAL de i18n
 * (`IntlTestProvider`: es.json + timeZone de producción), no con mocks de
 * `useTranslations`: una clave inexistente hace fallar el test.
 *
 * Los escenarios de `specs/dashboard-ui/spec.md` son la aceptación:
 * - cinco columnas, cuatro del flujo en orden y Descartado FUERA del flujo con
 *   `aria-label` distinto del de Hecho;
 * - modo lectura: CERO controles de gestión y ningún DndContext montado;
 * - modo gestión: "Mover a…" con los cinco estados y el actual `aria-disabled`;
 * - texto libre siempre como texto plano (XSS almacenado inerte).
 *
 * El drag real con puntero no es confiable en jsdom: la decisión del
 * `onDragEnd` se prueba sobre `resolveDrop` (función pura exportada) y la
 * presencia/ausencia del DndContext por sus nodos de accesibilidad
 * (`DndDescribedBy-*`, `aria-roledescription="draggable"`).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import en from '@/messages/en.json';
import es from '@/messages/es.json';
import type { FeedbackReport } from '@/lib/feedback';
import { IntlTestProvider } from '@/lib/test-intl';

// Referencia ESTABLE (vi.hoisted, mismo criterio que FeedbackWidget.test.tsx):
// el thumbnail y el lightbox de la tarjeta llaman a este mock, nunca al
// `getScreenshotDownloadUrl` real.
const { getScreenshotDownloadUrlMock } = vi.hoisted(() => ({
  getScreenshotDownloadUrlMock: vi.fn(),
}));

vi.mock('@/lib/feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback')>();
  return { ...actual, getScreenshotDownloadUrl: getScreenshotDownloadUrlMock };
});

import { FeedbackBoard, resolveDrop } from './FeedbackBoard';

const S = es.feedback.status;
const B = es.feedback.board;
const C = es.feedback.comment;
const TYPES = es.feedback.widget.types;

function buildReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'r-default',
    type: 'bug',
    body: 'Cuerpo por defecto',
    route: '/analytics',
    url: 'http://localhost:3000/analytics?channel=AK.FIRE..BHZ&start=2026-09-01T00:00:00Z',
    user_agent: 'Mozilla/5.0 (Macintosh) TestRunner/1.0',
    author_email: 'tester@example.com',
    created_at: '2026-09-01T10:00:00Z',
    status: 'new',
    status_changed_at: null,
    admin_comment: null,
    admin_comment_updated_at: null,
    screenshot_key: null,
    ...overrides,
  };
}

// Tres tarjetas en Nuevo con T1 < T2 < T3, pasadas en orden ASCENDENTE a
// propósito: el tablero debe ordenarlas T3, T2, T1 (created_at DESC).
const T1 = buildReport({ id: 't1', body: 'Primera falla (T1)', created_at: '2026-09-01T10:00:00Z' });
const T2 = buildReport({ id: 't2', body: 'Segunda falla (T2)', created_at: '2026-09-01T11:00:00Z' });
const T3 = buildReport({
  id: 't3',
  body: 'Tercera falla (T3)',
  created_at: '2026-09-01T12:00:00Z',
  author_email: 'tercera@example.com',
});
const ANALYSIS = buildReport({
  id: 'a1',
  type: 'suggestion',
  body: 'Sugerencia en análisis',
  status: 'in_analysis',
  status_changed_at: '2026-09-02T09:30:00Z',
});
const PROGRESS = buildReport({
  id: 'p1',
  body: 'Falla en progreso',
  status: 'in_progress',
  status_changed_at: '2026-09-02T10:00:00Z',
  admin_comment: 'Reproducido en staging',
  admin_comment_updated_at: '2026-09-02T10:05:00Z',
});
const DONE = buildReport({ id: 'd1', body: 'Falla resuelta', status: 'done', status_changed_at: '2026-09-02T11:00:00Z' });
const DISCARDED = buildReport({
  id: 'x1',
  type: 'suggestion',
  body: 'Sugerencia descartada',
  status: 'discarded',
  status_changed_at: '2026-09-02T12:00:00Z',
});

const ALL_REPORTS: FeedbackReport[] = [T1, T2, T3, ANALYSIS, PROGRESS, DONE, DISCARDED];

function renderBoard(reports: FeedbackReport[], canManage: boolean) {
  const onMove = vi.fn();
  const onComment = vi.fn();
  render(
    <IntlTestProvider>
      <FeedbackBoard reports={reports} canManage={canManage} onMove={onMove} onComment={onComment} />
    </IntlTestProvider>,
  );
  return { onMove, onComment };
}

function column(name: string) {
  return screen.getByRole('region', { name });
}

/** Solo las columnas del tablero: el ToastProvider del harness también monta
 * un region (viewport de Radix Toast). */
function boardColumns() {
  return screen.getAllByRole('region').filter((el) => el.hasAttribute('data-status'));
}

/** Tarjeta que contiene el texto dado (el `article` más cercano). */
function cardContaining(text: string): HTMLElement {
  // Con el detalle abierto el body también vive en el dialog (portal, fuera de
  // todo article): se busca la copia que SÍ está dentro de una tarjeta.
  const el = screen
    .getAllByText(text)
    .map((node) => node.closest('article'))
    .find((node): node is HTMLElement => node !== null);
  if (!el) throw new Error(`No hay <article> alrededor de "${text}"`);
  return el;
}

function openMoveMenu(card: HTMLElement) {
  const trigger = within(card).getByRole('button', { name: B.moveTo });
  // Radix abre con teclado (Enter): es el camino que la spec exige operable y
  // el único determinista en jsdom (pointerdown no siempre viaja).
  fireEvent.keyDown(trigger, { key: 'Enter' });
  return screen.getByRole('menu');
}

function openDetail(card: HTMLElement) {
  fireEvent.click(within(card).getByRole('button', { name: B.openDetail }));
  return screen.getByRole('dialog');
}

afterEach(() => {
  cleanup();
  getScreenshotDownloadUrlMock.mockReset();
});

describe('FeedbackBoard — estructura de columnas (modo lectura)', () => {
  it('renderiza cinco columnas: las cuatro del flujo en orden y Descartado fuera de la secuencia', () => {
    renderBoard(ALL_REPORTS, false);

    const flow = screen.getByRole('group', { name: B.flowGroup });
    const flowNames = within(flow)
      .getAllByRole('region')
      .map((el) => el.getAttribute('aria-label'));
    expect(flowNames).toEqual([S.new, S.in_analysis, S.in_progress, S.done]);

    // Descartado existe como columna propia, pero NO dentro del grupo del flujo.
    const discarded = column(S.discarded);
    expect(within(flow).queryByRole('region', { name: S.discarded })).toBeNull();
    expect(flow.contains(discarded)).toBe(false);

    expect(boardColumns()).toHaveLength(5);
  });

  it('Descartado no es Hecho: aria-label y etiqueta distintos', () => {
    renderBoard(ALL_REPORTS, false);
    const done = column(S.done);
    const discarded = column(S.discarded);
    expect(discarded.getAttribute('aria-label')).not.toBe(done.getAttribute('aria-label'));
    expect(within(discarded).getByRole('heading')).toHaveTextContent(S.discarded);
    expect(within(done).getByRole('heading')).toHaveTextContent(S.done);
    expect(S.discarded).not.toBe(S.done);
  });

  it('cada tarjeta cae en la columna de su status con tipo, resumen, autor y fecha', () => {
    renderBoard(ALL_REPORTS, false);

    expect(within(column(S.new)).getAllByRole('article')).toHaveLength(3);
    expect(within(column(S.in_analysis)).getByText('Sugerencia en análisis')).toBeInTheDocument();
    expect(within(column(S.in_progress)).getByText('Falla en progreso')).toBeInTheDocument();
    expect(within(column(S.done)).getByText('Falla resuelta')).toBeInTheDocument();
    expect(within(column(S.discarded)).getByText('Sugerencia descartada')).toBeInTheDocument();

    const t3 = cardContaining('Tercera falla (T3)');
    expect(t3).toHaveTextContent(TYPES.bug);
    expect(t3).toHaveTextContent('tercera@example.com');
    // Fecha formateada (UTC de la app): 1 sep 2026 12:00.
    expect(t3).toHaveTextContent(/1 de sept\.? de 2026/);
    expect(t3).toHaveTextContent('12:00');

    const a1 = cardContaining('Sugerencia en análisis');
    expect(a1).toHaveTextContent(TYPES.suggestion);
  });

  it('el admin_comment se muestra diferenciado del texto del tester, solo donde existe', () => {
    renderBoard(ALL_REPORTS, false);
    const p1 = cardContaining('Falla en progreso');
    const commentBlock = within(p1).getByText('Reproducido en staging').closest('[data-slot="admin-comment"]');
    expect(commentBlock).not.toBeNull();
    expect(commentBlock).toHaveTextContent(C.label);

    const t3 = cardContaining('Tercera falla (T3)');
    expect(t3.querySelector('[data-slot="admin-comment"]')).toBeNull();
  });

  it('ordena T3, T2, T1 dentro de la columna aunque lleguen ascendentes', () => {
    renderBoard(ALL_REPORTS, false);
    const bodies = within(column(S.new))
      .getAllByRole('article')
      .map((el) => el.textContent ?? '');
    expect(bodies[0]).toContain('Tercera falla (T3)');
    expect(bodies[1]).toContain('Segunda falla (T2)');
    expect(bodies[2]).toContain('Primera falla (T1)');
  });

  it('lista vacía: cinco columnas con mensaje de vacío y sin error', () => {
    renderBoard([], false);
    expect(boardColumns()).toHaveLength(5);
    expect(screen.getAllByText(B.empty)).toHaveLength(5);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });
});

describe('FeedbackBoard — modo lectura sin controles de gestión', () => {
  it('no renderiza "Mover a…" ni asas de arrastre ni DndContext', () => {
    renderBoard(ALL_REPORTS, false);
    expect(screen.queryByRole('button', { name: B.moveTo })).toBeNull();
    expect(screen.queryByRole('button', { name: B.dragHandle })).toBeNull();
    // dnd-kit marca lo arrastrable con aria-roledescription y monta las
    // instrucciones ocultas DndDescribedBy-* SOLO dentro de un DndContext.
    expect(document.querySelector('[aria-roledescription]')).toBeNull();
    expect(document.querySelector('[id^="DndDescribedBy"]')).toBeNull();
  });

  it('el detalle en modo lectura muestra el comentario pero no el editor', () => {
    renderBoard(ALL_REPORTS, false);
    const dialog = openDetail(cardContaining('Falla en progreso'));
    expect(dialog).toHaveTextContent('Reproducido en staging');
    expect(within(dialog).queryByRole('textbox')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: C.save })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: C.clear })).toBeNull();
  });

  it('body y comentario maliciosos se muestran como texto literal', () => {
    const evil = buildReport({
      id: 'evil',
      body: '<script>alert(1)</script>',
      status: 'in_progress',
      admin_comment: '<img src=x onerror="alert(2)">',
      admin_comment_updated_at: '2026-09-02T10:05:00Z',
    });
    renderBoard([evil], false);
    expect(screen.getByText('<script>alert(1)</script>')).toBeInTheDocument();
    expect(screen.getByText('<img src=x onerror="alert(2)">')).toBeInTheDocument();
    expect(document.body.querySelector('script')).toBeNull();
    expect(document.body.querySelector('img')).toBeNull();
  });
});

describe('FeedbackBoard — modo gestión', () => {
  it('"Mover a…" lista los cinco estados con el actual deshabilitado y mueve al elegido', () => {
    const { onMove } = renderBoard(ALL_REPORTS, true);
    const menu = openMoveMenu(cardContaining('Tercera falla (T3)'));

    const items = within(menu).getAllByRole('menuitem');
    expect(items.map((el) => el.textContent)).toEqual([S.new, S.in_analysis, S.in_progress, S.done, S.discarded]);

    const current = within(menu).getByRole('menuitem', { name: S.new });
    expect(current).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(within(menu).getByRole('menuitem', { name: S.done }));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith('t3', 'done');
  });

  it('elegir el estado actual no emite ninguna llamada', () => {
    const { onMove } = renderBoard(ALL_REPORTS, true);
    const menu = openMoveMenu(cardContaining('Sugerencia en análisis'));
    fireEvent.click(within(menu).getByRole('menuitem', { name: S.in_analysis }));
    expect(onMove).not.toHaveBeenCalled();
  });

  it('monta el DndContext y cada tarjeta tiene su asa arrastrable', () => {
    renderBoard(ALL_REPORTS, true);
    expect(document.querySelector('[id^="DndDescribedBy"]')).not.toBeNull();
    const handles = screen.getAllByRole('button', { name: B.dragHandle });
    expect(handles).toHaveLength(ALL_REPORTS.length);
    handles.forEach((handle) => expect(handle).toHaveAttribute('aria-roledescription', 'draggable'));
  });

  it('el detalle muestra body completo, route, url como link seguro, user agent y la fecha de movimiento si existe', () => {
    renderBoard(ALL_REPORTS, true);
    const dialog = openDetail(cardContaining('Sugerencia en análisis'));

    expect(dialog).toHaveTextContent('Sugerencia en análisis');
    expect(dialog).toHaveTextContent('/analytics');
    const link = within(dialog).getByRole('link', { name: ANALYSIS.url });
    expect(link).toHaveAttribute('href', ANALYSIS.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(dialog).toHaveTextContent('Mozilla/5.0 (Macintosh) TestRunner/1.0');
    // status_changed_at = 2026-09-02T09:30Z ⇒ se muestra la fecha de movimiento.
    expect(dialog).toHaveTextContent('09:30');
  });

  it('el detalle de una tarjeta nunca movida no muestra fecha de movimiento', () => {
    renderBoard(ALL_REPORTS, true);
    const dialog = openDetail(cardContaining('Tercera falla (T3)'));
    // La clave se traduce con la fecha; sin fecha, el prefijo no aparece.
    const movedPrefix = B.movedAt.split('{')[0].trim();
    expect(dialog).not.toHaveTextContent(movedPrefix);
  });

  it('el editor de comentario guarda el texto y vaciar manda null', () => {
    const { onComment } = renderBoard(ALL_REPORTS, true);
    const dialog = openDetail(cardContaining('Falla en progreso'));

    const editor = within(dialog).getByRole('textbox', { name: C.label });
    expect(editor).toHaveValue('Reproducido en staging');
    expect(editor).toHaveAttribute('maxlength', '2000');

    fireEvent.change(editor, { target: { value: 'Reproducido' } });
    fireEvent.click(within(dialog).getByRole('button', { name: C.save }));
    expect(onComment).toHaveBeenCalledWith('p1', 'Reproducido');

    fireEvent.click(within(dialog).getByRole('button', { name: C.clear }));
    expect(onComment).toHaveBeenLastCalledWith('p1', null);
    expect(onComment).toHaveBeenCalledTimes(2);
  });
});

describe('FeedbackBoard — con en.json el enum crudo nunca se ve (tarea 5.2)', () => {
  // Los tres valores del enum que NO coinciden con ninguna palabra inglesa
  // (`new` y `done` sí, y además son data-status, no texto). Case-sensitive a
  // propósito: "Discarded" (traducción) no debe matar el test, "discarded" sí.
  const RAW_STATUS = /\b(in_analysis|in_progress|discarded)\b/;
  const EN_S = en.feedback.status;
  const EN_B = en.feedback.board;

  function renderBoardEn(canManage: boolean) {
    render(
      <IntlTestProvider locale="en" messages={en}>
        <FeedbackBoard reports={ALL_REPORTS} canManage={canManage} onMove={vi.fn()} onComment={vi.fn()} />
      </IntlTestProvider>,
    );
  }

  it('las columnas se titulan "In analysis" y "Discarded"; ningún nodo muestra el valor crudo', () => {
    renderBoardEn(false);
    expect(screen.queryByText(RAW_STATUS)).toBeNull();
    expect(screen.getByRole('heading', { name: 'In analysis' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Discarded' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: EN_S.in_analysis })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: EN_S.discarded })).toBeInTheDocument();
    // Más fuerte que queryByText: cubre texto partido entre elementos.
    expect(document.body.textContent).not.toMatch(RAW_STATUS);
  });

  it('el menú "Move to…" y el badge del detalle también traducen los estados', () => {
    renderBoardEn(true);
    const card = cardContaining('Sugerencia en análisis');

    fireEvent.keyDown(within(card).getByRole('button', { name: EN_B.moveTo }), { key: 'Enter' });
    const items = within(screen.getByRole('menu'))
      .getAllByRole('menuitem')
      .map((el) => el.textContent);
    expect(items).toEqual([EN_S.new, EN_S.in_analysis, EN_S.in_progress, EN_S.done, EN_S.discarded]);
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    fireEvent.click(within(card).getByRole('button', { name: EN_B.openDetail }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('In analysis');
    expect(dialog).toHaveTextContent(EN_B.technicalContext);

    expect(screen.queryByText(RAW_STATUS)).toBeNull();
    expect(document.body.textContent).not.toMatch(RAW_STATUS);
  });
});

describe('FeedbackCard (vía FeedbackBoard) — thumbnail de captura (tarea 4.1)', () => {
  const B = es.feedback.board;

  it('tarjeta con screenshot_key renderiza un thumbnail que pide la URL de lectura', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    const withShot = buildReport({ id: 'shot1', body: 'Con captura', screenshot_key: 'feedback-screenshots/aaaa.png' });
    renderBoard([withShot], false);

    const card = cardContaining('Con captura');
    const thumbButton = await within(card).findByRole('button', { name: B.screenshotThumbnailAlt });
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledWith('shot1'));

    const img = await within(thumbButton).findByRole('img');
    expect(img).toHaveAttribute('src', 'https://r2.example/thumb.png');
  });

  it('tarjeta sin screenshot_key: cero elementos de imagen y el mismo layout que antes del change', () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    const noShot = buildReport({ id: 'noshot1', body: 'Sin captura', screenshot_key: null });
    renderBoard([noShot], false);

    const card = cardContaining('Sin captura');
    expect(within(card).queryByRole('button', { name: B.screenshotThumbnailAlt })).toBeNull();
    expect(card.querySelector('img')).toBeNull();
    expect(getScreenshotDownloadUrlMock).not.toHaveBeenCalled();
    // Layout idéntico al de una tarjeta sin este change: header, body, footer,
    // sin ningún wrapper extra de thumbnail.
    expect(card.querySelector('[data-slot="screenshot-thumbnail"]')).toBeNull();
  });

  it('click en el thumbnail abre un lightbox con la imagen completa y re-pide la URL (no reusa la del thumbnail)', async () => {
    getScreenshotDownloadUrlMock
      .mockResolvedValueOnce({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' })
      .mockResolvedValueOnce({ url: 'https://r2.example/full.png', expires_at: '2026-09-03T00:10:00Z' });
    const withShot = buildReport({ id: 'shot2', body: 'Con captura lightbox', screenshot_key: 'feedback-screenshots/bbbb.png' });
    renderBoard([withShot], false);

    const card = cardContaining('Con captura lightbox');
    const thumbButton = await within(card).findByRole('button', { name: B.screenshotThumbnailAlt });
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(1));

    fireEvent.click(thumbButton);
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(2));
    expect(getScreenshotDownloadUrlMock).toHaveBeenNthCalledWith(2, 'shot2');

    const lightbox = screen.getByRole('dialog', { name: B.screenshotLightboxTitle });
    const fullImg = await within(lightbox).findByRole('img');
    expect(fullImg).toHaveAttribute('src', 'https://r2.example/full.png');
  });

  it('Enter en el thumbnail (operable por teclado) también abre el lightbox', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    const withShot = buildReport({ id: 'shot3', body: 'Con captura teclado', screenshot_key: 'feedback-screenshots/cccc.png' });
    renderBoard([withShot], false);

    const card = cardContaining('Con captura teclado');
    const thumbButton = await within(card).findByRole('button', { name: B.screenshotThumbnailAlt });
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(thumbButton, { key: 'Enter' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: B.screenshotLightboxTitle })).not.toBeNull());
  });

  it('el lightbox es cerrable con Escape y devuelve el foco al thumbnail que lo abrió', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    const withShot = buildReport({ id: 'shot4', body: 'Con captura foco', screenshot_key: 'feedback-screenshots/dddd.png' });
    renderBoard([withShot], false);

    const card = cardContaining('Con captura foco');
    const thumbButton = await within(card).findByRole('button', { name: B.screenshotThumbnailAlt });
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(1));

    fireEvent.click(thumbButton);
    const lightbox = await screen.findByRole('dialog', { name: B.screenshotLightboxTitle });
    fireEvent.keyDown(lightbox, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: B.screenshotLightboxTitle })).toBeNull());
    await waitFor(() => expect(thumbButton).toHaveFocus());
  });

  it('si getScreenshotDownloadUrl falla (401/500), el thumbnail degrada a imagen rota con alt descriptivo, sin crashear el resto de la tarjeta', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue(null);
    const withShot = buildReport({ id: 'shot5', body: 'Con captura rota', author_email: 'roto@example.com', screenshot_key: 'feedback-screenshots/eeee.png' });
    renderBoard([withShot], false);

    const card = cardContaining('Con captura rota');
    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledWith('shot5'));

    expect(await within(card).findByText(B.screenshotUnavailable)).toBeInTheDocument();
    expect(card.querySelector('img')).toBeNull();
    // El resto de la tarjeta sigue intacto: body, autor.
    expect(card).toHaveTextContent('Con captura rota');
    expect(card).toHaveTextContent('roto@example.com');
  });
});

describe('FeedbackCardDetail (vía FeedbackBoard) — sin controles de imagen si no hay captura (tarea 4.1)', () => {
  const B = es.feedback.board;

  it('en el detalle, sin screenshot_key no existe ningún control de imagen ni botón de lightbox', () => {
    getScreenshotDownloadUrlMock.mockResolvedValue(null);
    const noShot = buildReport({ id: 'noshot2', body: 'Sin captura detalle', screenshot_key: null });
    renderBoard([noShot], false);

    const dialog = openDetail(cardContaining('Sin captura detalle'));
    expect(within(dialog).queryByRole('img')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: B.screenshotThumbnailAlt })).toBeNull();
    expect(getScreenshotDownloadUrlMock).not.toHaveBeenCalled();
  });
});

describe('resolveDrop — decisión del onDragEnd', () => {
  const active = { id: 't3', data: { current: { status: 'new' } } };

  it('sin destino no mueve', () => {
    expect(resolveDrop({ active, over: null })).toBeNull();
  });

  it('soltar en la misma columna no mueve', () => {
    expect(resolveDrop({ active, over: { id: 'new' } })).toBeNull();
  });

  it('soltar en otra columna devuelve id y status destino', () => {
    expect(resolveDrop({ active, over: { id: 'in_progress' } })).toEqual({ id: 't3', status: 'in_progress' });
  });

  it('un destino que no es un estado válido no mueve', () => {
    expect(resolveDrop({ active, over: { id: 'basura' } })).toBeNull();
  });
});
