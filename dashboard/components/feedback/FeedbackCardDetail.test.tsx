/**
 * Tests de `FeedbackCardDetail` montado de forma aislada (tarea 4.1 del
 * change feedback-screenshot-attachment). Antes de este archivo, el
 * componente solo se ejercitaba indirectamente vía `FeedbackBoard.test.tsx`
 * — acá se agrega cobertura propia para el lightbox de la captura porque el
 * componente crece un control nuevo (imagen completa) que amerita su propio
 * molde en vez de sumar más casos indirectos al tablero.
 *
 * Reusa `ui/dialog.tsx` (Radix): Escape/click afuera y devolución de foco ya
 * son responsabilidad del primitivo, pero se verifican igual como
 * comportamiento observable del lightbox (design.md Decision 4: re-pedir la
 * URL de lectura siempre, nunca cachear la del thumbnail).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { FeedbackReport } from '@/lib/feedback';
import { IntlTestProvider } from '@/lib/test-intl';

const { getScreenshotDownloadUrlMock } = vi.hoisted(() => ({
  getScreenshotDownloadUrlMock: vi.fn(),
}));

vi.mock('@/lib/feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback')>();
  return { ...actual, getScreenshotDownloadUrl: getScreenshotDownloadUrlMock };
});

import { FeedbackCardDetail } from './FeedbackCardDetail';

const B = es.feedback.board;

function buildReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  return {
    id: 'r-default',
    type: 'bug',
    body: 'Cuerpo por defecto',
    route: '/analytics',
    url: 'http://localhost:3000/analytics',
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

function renderDetail(report: FeedbackReport, canManage = false) {
  const onComment = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <IntlTestProvider>
      <FeedbackCardDetail report={report} canManage={canManage} open onOpenChange={onOpenChange} onComment={onComment} />
    </IntlTestProvider>,
  );
  return { onComment, onOpenChange };
}

afterEach(() => {
  cleanup();
  getScreenshotDownloadUrlMock.mockReset();
});

describe('FeedbackCardDetail — sin screenshot_key', () => {
  it('no existe ningún control de imagen ni botón de lightbox', () => {
    renderDetail(buildReport({ screenshot_key: null }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button', { name: B.screenshotThumbnailAlt })).toBeNull();
    expect(getScreenshotDownloadUrlMock).not.toHaveBeenCalled();
  });
});

describe('FeedbackCardDetail — con screenshot_key', () => {
  it('muestra un thumbnail que pide la URL de lectura al montar el detalle', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    renderDetail(buildReport({ id: 'd1', screenshot_key: 'feedback-screenshots/aaaa.png' }));

    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledWith('d1'));
    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'https://r2.example/thumb.png');
  });

  it('click en el thumbnail abre un lightbox con la imagen completa, re-pidiendo la URL (no reusa la del thumbnail)', async () => {
    getScreenshotDownloadUrlMock
      .mockResolvedValueOnce({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' })
      .mockResolvedValueOnce({ url: 'https://r2.example/full.png', expires_at: '2026-09-03T00:10:00Z' });
    renderDetail(buildReport({ id: 'd2', screenshot_key: 'feedback-screenshots/bbbb.png' }));

    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(1));
    const thumbButton = await screen.findByRole('button', { name: B.screenshotThumbnailAlt });
    fireEvent.click(thumbButton);

    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledTimes(2));
    expect(getScreenshotDownloadUrlMock).toHaveBeenNthCalledWith(2, 'd2');

    const lightbox = await screen.findByRole('dialog', { name: B.screenshotLightboxTitle });
    const fullImg = await within(lightbox).findByRole('img');
    expect(fullImg).toHaveAttribute('src', 'https://r2.example/full.png');
  });

  it('el lightbox se cierra con Escape y devuelve el foco al thumbnail', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue({ url: 'https://r2.example/thumb.png', expires_at: '2026-09-03T00:05:00Z' });
    renderDetail(buildReport({ id: 'd3', screenshot_key: 'feedback-screenshots/cccc.png' }));

    const thumbButton = await screen.findByRole('button', { name: B.screenshotThumbnailAlt });
    fireEvent.click(thumbButton);

    const lightbox = await screen.findByRole('dialog', { name: B.screenshotLightboxTitle });
    fireEvent.keyDown(lightbox, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: B.screenshotLightboxTitle })).toBeNull());
    await waitFor(() => expect(thumbButton).toHaveFocus());
  });

  it('si getScreenshotDownloadUrl falla, el thumbnail degrada a imagen rota con alt descriptivo, sin lanzar', async () => {
    getScreenshotDownloadUrlMock.mockResolvedValue(null);
    renderDetail(buildReport({ id: 'd4', screenshot_key: 'feedback-screenshots/dddd.png' }));

    await waitFor(() => expect(getScreenshotDownloadUrlMock).toHaveBeenCalledWith('d4'));
    expect(await screen.findByText(B.screenshotUnavailable)).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    // El resto del detalle sigue renderizando: body, contexto técnico.
    expect(screen.getByText('Cuerpo por defecto')).toBeInTheDocument();
  });
});
