/**
 * Tests de la página `/feedback` (tarea 4.6 del change feedback-beta-testers).
 *
 * `canManage` se deriva del rol de `useAuth()` y se observa por lo único que
 * cambia en pantalla: la presencia de los controles "Mover a…". SWR es el
 * REAL (con caché nueva por test, patrón UsersPanel.test): si se mockeara,
 * "la tarjeta vuelve a su columna" probaría el mock y no el `rollbackOnError`
 * de producción — y la mutación M17 no podría morir. Lo que se mockea es el
 * helper `@/lib/feedback` (la red) y `useAuth` (quién mira).
 *
 * Los mocks devuelven SIEMPRE la misma referencia (`authState` se muta, no se
 * re-mockea): un mock de hook inestable cuelga los tests (lección del repo).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import { ApiStatusError } from '@/lib/auth';
import type { FeedbackReport } from '@/lib/feedback';
import { IntlTestProvider } from '@/lib/test-intl';
import type { UserPublic } from '@/lib/types';

import FeedbackPage from './page';

const S = es.feedback.status;
const B = es.feedback.board;
const C = es.feedback.comment;
const E = es.feedback.errors;

const { authState, listMock, statusMock, commentMock } = vi.hoisted(() => ({
  authState: { user: null as UserPublic | null },
  listMock: vi.fn(),
  statusMock: vi.fn(),
  commentMock: vi.fn(),
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => authState,
}));

vi.mock('@/lib/feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback')>();
  return {
    ...actual,
    listFeedbackReports: listMock,
    updateFeedbackStatus: statusMock,
    updateFeedbackComment: commentMock,
  };
});

function buildReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'r-default',
    type: 'bug',
    body: 'Cuerpo por defecto',
    route: '/analytics',
    url: 'http://localhost:3000/analytics',
    user_agent: 'Mozilla/5.0 TestRunner',
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

const T3 = buildReport({ id: 't3', body: 'Tercera falla (T3)', created_at: '2026-09-01T12:00:00Z' });
const P1 = buildReport({
  id: 'p1',
  body: 'Falla en progreso',
  status: 'in_progress',
  status_changed_at: '2026-09-02T10:00:00Z',
  admin_comment: 'v1',
  admin_comment_updated_at: '2026-09-02T10:05:00Z',
});
const REPORTS = [T3, P1];

function setRole(role: UserPublic['role']) {
  authState.user = { id: 'u1', email: 'yo@example.com', role };
}

function renderPage() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <IntlTestProvider>
        <FeedbackPage />
      </IntlTestProvider>
    </SWRConfig>,
  );
}

async function renderLoaded(reports: FeedbackReport[] = REPORTS) {
  listMock.mockResolvedValue(reports);
  renderPage();
  await screen.findByText('Tercera falla (T3)');
}

function column(name: string) {
  return screen.getByRole('region', { name });
}

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

function moveViaMenu(card: HTMLElement, statusLabel: string) {
  fireEvent.keyDown(within(card).getByRole('button', { name: B.moveTo }), { key: 'Enter' });
  fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitem', { name: statusLabel }));
}

/** Aviso de acción (mover/comentar): el `role="alert"` que NO es el de carga. */
function actionAlert() {
  return screen.getByRole('alert');
}

beforeEach(() => {
  vi.clearAllMocks();
  setRole('viewer');
});

afterEach(() => {
  cleanup();
});

describe('FeedbackPage — canManage derivado del rol', () => {
  it('viewer: el tablero se renderiza en modo lectura (sin "Mover a…") y GET se llama una vez', async () => {
    await renderLoaded();
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: B.moveTo })).toBeNull();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(B.title);
  });

  it('moderador: también modo lectura', async () => {
    setRole('moderador');
    await renderLoaded();
    expect(screen.queryByRole('button', { name: B.moveTo })).toBeNull();
  });

  it('admin: modo gestión', async () => {
    setRole('admin');
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: B.moveTo })).toHaveLength(REPORTS.length);
  });

  it('superadmin: modo gestión (jerárquico, no igualdad)', async () => {
    setRole('superadmin');
    await renderLoaded();
    expect(screen.getAllByRole('button', { name: B.moveTo })).toHaveLength(REPORTS.length);
  });
});

describe('FeedbackPage — carga y refresco', () => {
  it('"Actualizar" vuelve a pedir el tablero', async () => {
    await renderLoaded();
    fireEvent.click(screen.getByRole('button', { name: B.refresh }));
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('un GET que falla muestra el error de carga, no un tablero vacío', async () => {
    listMock.mockRejectedValue(new ApiStatusError(500, 'boom'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(B.loadError);
    expect(screen.queryByRole('region', { name: S.new })).toBeNull();
  });

  it('tablero vacío: cinco columnas con mensaje de vacío', async () => {
    listMock.mockResolvedValue([]);
    renderPage();
    await screen.findByRole('region', { name: S.new });
    expect(screen.getAllByText(B.empty)).toHaveLength(5);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('FeedbackPage — mover con actualización optimista y reversión', () => {
  beforeEach(() => setRole('admin'));

  it('éxito: la tarjeta queda en la columna destino con el item devuelto y sin refetch', async () => {
    await renderLoaded();
    statusMock.mockResolvedValue({ ...T3, status: 'done', status_changed_at: '2026-09-03T10:00:00Z' });

    moveViaMenu(cardContaining('Tercera falla (T3)'), S.done);

    await waitFor(() => expect(within(column(S.done)).getByText('Tercera falla (T3)')).toBeInTheDocument());
    expect(statusMock).toHaveBeenCalledWith('t3', 'done');
    expect(within(column(S.new)).queryByText('Tercera falla (T3)')).toBeNull();
    // Se reconcilia con el item del PUT, no con un GET nuevo.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('403: la tarjeta vuelve a su columna y aparece el aviso de permisos', async () => {
    await renderLoaded();
    statusMock.mockRejectedValue(new ApiStatusError(403, 'insufficient role'));

    moveViaMenu(cardContaining('Tercera falla (T3)'), S.done);

    await waitFor(() => expect(actionAlert()).toHaveTextContent(E.forbidden));
    expect(within(column(S.new)).getByText('Tercera falla (T3)')).toBeInTheDocument();
    expect(within(column(S.done)).queryByText('Tercera falla (T3)')).toBeNull();
  });

  it('401 (helper resuelve null): revierte con aviso de sesión', async () => {
    await renderLoaded();
    statusMock.mockResolvedValue(null);

    moveViaMenu(cardContaining('Tercera falla (T3)'), S.in_progress);

    await waitFor(() => expect(actionAlert()).toHaveTextContent(E.sessionExpired));
    expect(within(column(S.new)).getByText('Tercera falla (T3)')).toBeInTheDocument();
    expect(within(column(S.in_progress)).queryByText('Tercera falla (T3)')).toBeNull();
  });

  it('fallo de red: revierte con el aviso genérico', async () => {
    await renderLoaded();
    statusMock.mockRejectedValue(new TypeError('fetch failed'));

    moveViaMenu(cardContaining('Tercera falla (T3)'), S.discarded);

    await waitFor(() => expect(actionAlert()).toHaveTextContent(E.moveFailed));
    expect(within(column(S.new)).getByText('Tercera falla (T3)')).toBeInTheDocument();
    expect(within(column(S.discarded)).queryByText('Tercera falla (T3)')).toBeNull();
  });
});

describe('FeedbackPage — comentario con reversión', () => {
  beforeEach(() => setRole('admin'));

  function openEditor() {
    fireEvent.click(within(cardContaining('Falla en progreso')).getByRole('button', { name: B.openDetail }));
    const dialog = screen.getByRole('dialog');
    return { dialog, editor: within(dialog).getByRole('textbox', { name: C.label }) };
  }

  it('422 al guardar: la tarjeta vuelve a mostrar "v1" con aviso', async () => {
    await renderLoaded();
    commentMock.mockRejectedValue(new ApiStatusError(422, 'too long'));
    const { dialog, editor } = openEditor();

    fireEvent.change(editor, { target: { value: 'v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: C.save }));

    await waitFor(() => expect(actionAlert()).toHaveTextContent(E.commentFailed));
    expect(commentMock).toHaveBeenCalledWith('p1', 'v2');
    const card = cardContaining('Falla en progreso');
    expect(card.querySelector('[data-slot="admin-comment"]')).toHaveTextContent('v1');
    expect(card.querySelector('[data-slot="admin-comment"]')).not.toHaveTextContent('v2');
  });

  it('éxito al guardar: la tarjeta muestra el comentario nuevo sin rastro del anterior', async () => {
    await renderLoaded();
    commentMock.mockResolvedValue({ ...P1, admin_comment: 'v2', admin_comment_updated_at: '2026-09-03T10:00:00Z' });
    const { dialog, editor } = openEditor();

    fireEvent.change(editor, { target: { value: 'v2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: C.save }));

    await waitFor(() =>
      expect(cardContaining('Falla en progreso').querySelector('[data-slot="admin-comment"]')).toHaveTextContent('v2'),
    );
    expect(cardContaining('Falla en progreso').querySelector('[data-slot="admin-comment"]')).not.toHaveTextContent('v1');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('vaciar: manda null y la tarjeta deja de mostrar comentario', async () => {
    await renderLoaded();
    commentMock.mockResolvedValue({ ...P1, admin_comment: null, admin_comment_updated_at: null });
    const { dialog } = openEditor();

    fireEvent.click(within(dialog).getByRole('button', { name: C.clear }));

    await waitFor(() =>
      expect(cardContaining('Falla en progreso').querySelector('[data-slot="admin-comment"]')).toBeNull(),
    );
    expect(commentMock).toHaveBeenCalledWith('p1', null);
  });
});
