import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import es from '@/messages/es.json';
import { ApiStatusError } from '@/lib/auth';
import { FeedbackWidget } from './FeedbackWidget';

const W = es.feedback.widget;

// Referencias ESTABLES: un mock de router/pathname que devuelve un objeto
// nuevo por render cuelga tests (lección documentada). El pathname se cambia
// mutando `pathnameState.value`, nunca re-mockeando el módulo.
const {
  pathnameState,
  submitFeedbackMock,
  mutateMock,
  captureScreenshotMock,
  detectWebglCanvasMock,
  uploadScreenshotMock,
} = vi.hoisted(() => ({
  pathnameState: { value: '/analytics' },
  submitFeedbackMock: vi.fn(),
  mutateMock: vi.fn(),
  captureScreenshotMock: vi.fn(),
  detectWebglCanvasMock: vi.fn(),
  uploadScreenshotMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => pathnameState.value,
}));

vi.mock('@/lib/feedback', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/feedback')>();
  return { ...actual, submitFeedback: submitFeedbackMock };
});

vi.mock('@/lib/screenshot', () => ({
  captureScreenshot: captureScreenshotMock,
  detectWebglCanvas: detectWebglCanvasMock,
  uploadScreenshot: uploadScreenshotMock,
}));

const swrConfig = { mutate: mutateMock };
vi.mock('swr', () => ({
  useSWRConfig: () => swrConfig,
}));

const UA = 'Mozilla/5.0 (Macintosh) TestRunner/1.0';

function setUserAgent(value: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value, configurable: true });
}

// Sin trigger propio (vive en AppSidebar): el harness posee `open`/onOpenChange
// como lo haría el caller real, con un botón externo equivalente al del
// sidebar para disparar la apertura desde el test.
function ControlledWidget() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {W.button}
      </button>
      <FeedbackWidget open={open} onOpenChange={setOpen} />
    </>
  );
}

function renderWidget() {
  render(
    <NextIntlClientProvider locale="es-AR" messages={es}>
      <ControlledWidget />
    </NextIntlClientProvider>,
  );
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: W.button }));
  return screen.getByRole('dialog');
}

function typeBody(text: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
}

function clickSubmit() {
  fireEvent.click(screen.getByRole('button', { name: W.submit }));
}

/** Payload del único POST emitido. */
function sentPayload() {
  expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
  return submitFeedbackMock.mock.calls[0][0] as {
    type: string;
    body: string;
    route: string;
    url: string;
    user_agent: string;
  };
}

beforeEach(() => {
  pathnameState.value = '/analytics';
  window.history.replaceState({}, '', '/analytics?channel=AK.FIRE..BHZ&start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z');
  setUserAgent(UA);
  // Defaults neutros: sin captura, sin WebGL. Cada test que necesite otro
  // comportamiento lo pisa explícitamente.
  captureScreenshotMock.mockResolvedValue(null);
  detectWebglCanvasMock.mockReturnValue(false);
  uploadScreenshotMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('FeedbackWidget — botón flotante y dialog', () => {
  it('renderiza el botón flotante con aria-label traducido y sin dialog abierto', () => {
    renderWidget();
    expect(screen.getByRole('button', { name: W.button })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('al abrir muestra las dos opciones de tipo, el textarea con tope 2000 y contador, y las dos leyendas', () => {
    renderWidget();
    const dialog = openDialog();
    expect(screen.getByRole('radio', { name: W.types.bug })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: W.types.suggestion })).toBeInTheDocument();
    const textarea = screen.getByRole('textbox');
    expect(textarea).toHaveAttribute('maxlength', '2000');
    expect(dialog).toHaveTextContent('0 / 2000');
    // Leyenda de contexto adjuntado (honestidad sobre lo capturado).
    expect(dialog).toHaveTextContent(W.contextNotice);
    // Aviso de transparencia: visible ANTES de enviar.
    expect(dialog).toHaveTextContent(W.visibilityNotice);
  });

  it('el contador sigue al texto', () => {
    renderWidget();
    const dialog = openDialog();
    typeBody('hola');
    expect(dialog).toHaveTextContent('4 / 2000');
  });
});

describe('FeedbackWidget — captura de contexto en el submit', () => {
  it('manda route = pathname, url = href con query params, user_agent = navigator.userAgent y el type como literal', async () => {
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: '2026-09-03T12:00:00Z' });
    renderWidget();
    openDialog();
    fireEvent.click(screen.getByRole('radio', { name: W.types.suggestion }));
    typeBody('Estaría bueno ver la hora en el espectrograma');
    clickSubmit();

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    const payload = sentPayload();
    expect(payload.type).toBe('suggestion');
    expect(payload.body).toBe('Estaría bueno ver la hora en el espectrograma');
    expect(payload.route).toBe('/analytics');
    expect(payload.url).toBe(window.location.href);
    expect(payload.url).toContain('?channel=AK.FIRE..BHZ&start=');
    expect(payload.user_agent).toBe(UA);
  });

  it('el tipo por defecto es bug', async () => {
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });
    renderWidget();
    openDialog();
    typeBody('falla');
    clickSubmit();
    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    expect(sentPayload().type).toBe('bug');
  });

  it('trunca route a 300, url a 2000 y user_agent a 400 exactos; el body viaja completo', async () => {
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });
    pathnameState.value = '/' + 'r'.repeat(300); // 301 chars
    window.history.replaceState({}, '', '/x?q=' + 'u'.repeat(2100));
    expect(window.location.href.length).toBeGreaterThan(2000);
    setUserAgent('a'.repeat(401));
    const body = 'b'.repeat(1500);

    renderWidget();
    openDialog();
    typeBody(body);
    clickSubmit();

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    const payload = sentPayload();
    expect(payload.route).toHaveLength(300);
    expect(payload.route).toBe(pathnameState.value.slice(0, 300));
    expect(payload.url).toHaveLength(2000);
    expect(payload.url).toBe(window.location.href.slice(0, 2000));
    expect(payload.user_agent).toHaveLength(400);
    expect(payload.body).toBe(body);
  });
});

describe('FeedbackWidget — validación local', () => {
  it('un body de 2001 NO llega a submitFeedback y NO se recorta', async () => {
    renderWidget();
    const dialog = openDialog();
    const tooLong = 'x'.repeat(2001);
    typeBody(tooLong);
    clickSubmit();
    // Esperar un tick: si el widget mandara, ya estaría llamado.
    await new Promise((r) => setTimeout(r, 20));
    expect(submitFeedbackMock).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue(tooLong);
    expect(dialog).toHaveTextContent('2001 / 2000');
    expect(screen.getByRole('textbox')).toHaveAttribute('aria-invalid', 'true');
  });

  it('textarea vacío ⇒ cero llamadas', async () => {
    renderWidget();
    openDialog();
    clickSubmit();
    await new Promise((r) => setTimeout(r, 20));
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });

  it('solo espacios ⇒ cero llamadas', async () => {
    renderWidget();
    openDialog();
    typeBody('   \n\t  ');
    clickSubmit();
    await new Promise((r) => setTimeout(r, 20));
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });
});

describe('FeedbackWidget — estados del envío', () => {
  it('doble click con la promesa pendiente ⇒ una sola llamada, control deshabilitado e indicación de envío', async () => {
    let resolveSubmit: (v: unknown) => void = () => {};
    submitFeedbackMock.mockImplementation(
      () => new Promise((resolve) => { resolveSubmit = resolve; }),
    );
    renderWidget();
    const dialog = openDialog();
    typeBody('reporte');
    clickSubmit();
    // Segundo click mientras el request está en vuelo.
    const sending = await screen.findByRole('button', { name: W.sending });
    expect(sending).toBeDisabled();
    fireEvent.click(sending);
    expect(dialog).toHaveTextContent(W.sending);
    expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
    resolveSubmit({ id: 'r1', created_at: 'x' });
    await screen.findByText(W.sent);
  });

  it('201 ⇒ confirmación + link al tablero (sin navegar) + mutate(/feedback) + formulario vacío al reabrir', async () => {
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });
    renderWidget();
    openDialog();
    fireEvent.click(screen.getByRole('radio', { name: W.types.suggestion }));
    typeBody('todo bien');
    clickSubmit();

    await screen.findByText(W.sent);
    const link = screen.getByRole('link', { name: W.viewBoard });
    expect(link).toHaveAttribute('href', '/feedback');
    // El widget NO navega solo: seguimos en la misma URL.
    expect(window.location.pathname).toBe('/analytics');
    expect(mutateMock).toHaveBeenCalledWith('/feedback');
    expect(screen.queryByText(W.error)).not.toBeInTheDocument();

    // Cerrar y reabrir: el formulario arranca vacío (tipo y texto reseteados).
    fireEvent.click(screen.getByRole('button', { name: W.close }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    openDialog();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('radio', { name: W.types.bug })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: W.types.suggestion })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(W.sent)).not.toBeInTheDocument();
  });

  it('rechazo ⇒ error visible, texto intacto, sin confirmación; el reintento exitoso recién entonces confirma', async () => {
    submitFeedbackMock.mockRejectedValueOnce(new ApiStatusError(500, 'Internal Server Error'));
    renderWidget();
    openDialog();
    typeBody('se rompió el helicorder');
    clickSubmit();

    await screen.findByText(W.error);
    expect(screen.queryByText(W.sent)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('se rompió el helicorder');
    expect(mutateMock).not.toHaveBeenCalled();

    // Reintento con el backend recuperado.
    submitFeedbackMock.mockResolvedValueOnce({ id: 'r2', created_at: 'x' });
    fireEvent.click(screen.getByRole('button', { name: W.retry }));
    await screen.findByText(W.sent);
    expect(submitFeedbackMock).toHaveBeenCalledTimes(2);
    expect(submitFeedbackMock.mock.calls[1][0].body).toBe('se rompió el helicorder');
    expect(mutateMock).toHaveBeenCalledWith('/feedback');
  });

  it('401 (submitFeedback resuelve null) ⇒ error de sesión, sin confirmación ni mutate', async () => {
    submitFeedbackMock.mockResolvedValue(null);
    renderWidget();
    openDialog();
    typeBody('texto');
    clickSubmit();
    await screen.findByText(W.sessionExpired);
    expect(screen.queryByText(W.sent)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('texto');
    expect(mutateMock).not.toHaveBeenCalled();
  });
});

describe('FeedbackWidget — captura de pantalla automática al abrir', () => {
  it('al abrir dispara captureScreenshot sin bloquear el render del formulario', async () => {
    let resolveCapture: (v: Blob | null) => void = () => {};
    captureScreenshotMock.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));
    renderWidget();
    openDialog();

    await waitFor(() => expect(captureScreenshotMock).toHaveBeenCalledTimes(1));
    // El tester puede tipear ANTES de que la captura resuelva.
    typeBody('ya puedo escribir');
    expect(screen.getByRole('textbox')).toHaveValue('ya puedo escribir');

    resolveCapture(new Blob(['x'], { type: 'image/png' }));
  });

  it('detectWebglCanvas true ⇒ muestra el aviso; false ⇒ no lo muestra', async () => {
    detectWebglCanvasMock.mockReturnValue(true);
    renderWidget();
    const dialog = openDialog();
    expect(dialog).toHaveTextContent(W.webglNotice);
  });

  it('sin WebGL detectado, el aviso no aparece', () => {
    detectWebglCanvasMock.mockReturnValue(false);
    renderWidget();
    const dialog = openDialog();
    expect(dialog).not.toHaveTextContent(W.webglNotice);
  });

  it('el aviso WebGL nunca deshabilita ni retrasa el botón de enviar', () => {
    detectWebglCanvasMock.mockReturnValue(true);
    renderWidget();
    openDialog();
    typeBody('reporte con globo 3D');
    expect(screen.getByRole('button', { name: W.submit })).not.toBeDisabled();
  });

  it('si uploadScreenshot resuelve una key ANTES del submit, el payload la incluye', async () => {
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockResolvedValue('feedback-screenshots/abc.png');
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });

    renderWidget();
    openDialog();
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));
    typeBody('con captura');
    clickSubmit();

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    expect(submitFeedbackMock.mock.calls[0][0].screenshot_key).toBe('feedback-screenshots/abc.png');
  });

  it('si uploadScreenshot resuelve null (o no terminó a tiempo), el submit va sin screenshot_key y completa igual', async () => {
    let resolveUpload: (v: string | null) => void = () => {};
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockImplementation(() => new Promise((resolve) => { resolveUpload = resolve; }));
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });

    renderWidget();
    openDialog();
    typeBody('sin captura a tiempo');
    clickSubmit();

    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    expect(submitFeedbackMock.mock.calls[0][0].screenshot_key).toBeUndefined();
    await screen.findByText(W.sent);
    // Sin ningún mensaje de error de captura visible.
    expect(screen.queryByText(W.error)).not.toBeInTheDocument();

    // Resolver la subida pendiente DENTRO del test (envuelta en act vía
    // waitFor) para no dejar una actualización de estado colgando tras el
    // cleanup — la key llega tarde, pero el widget ya cerró/confirmó antes.
    resolveUpload(null);
    await waitFor(() => expect(uploadScreenshotMock).toHaveResolved());
  });
});
