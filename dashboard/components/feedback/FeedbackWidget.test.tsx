import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

// Abrir dispara SIEMPRE trabajo asíncrono real ahora (captureScreenshot al
// abrir, design Decision 3): envuelve el click en `act()` async y espera un
// microtask para que la resolución del mock (incluso el default `null` de
// `beforeEach`) ya haya corrido dentro de `act` antes de que el test
// aserte — sin este flush, React actualiza estado (`setIsCapturing(false)`)
// fuera de `act` y todos los tests que abren el diálogo tiran el warning
// "not wrapped in act", aunque no les importe la captura en absoluto.
async function openDialog() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: W.button }));
    await Promise.resolve();
  });
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

// jsdom no implementa URL.createObjectURL/revokeObjectURL — mock local, no
// global (vitest.setup.ts es para infraestructura de TODA la suite, esto es
// específico del preview de captura de este componente).
let objectUrlCounter = 0;
beforeEach(() => {
  pathnameState.value = '/analytics';
  window.history.replaceState({}, '', '/analytics?channel=AK.FIRE..BHZ&start=2026-09-01T00:00:00Z&end=2026-09-02T00:00:00Z');
  setUserAgent(UA);
  // Defaults neutros: sin captura, sin WebGL. Cada test que necesite otro
  // comportamiento lo pisa explícitamente.
  captureScreenshotMock.mockResolvedValue(null);
  detectWebglCanvasMock.mockReturnValue(false);
  uploadScreenshotMock.mockResolvedValue(null);
  objectUrlCounter = 0;
  URL.createObjectURL = vi.fn(() => `blob:mock-${++objectUrlCounter}`);
  URL.revokeObjectURL = vi.fn();
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

  it('al abrir muestra las dos opciones de tipo, el textarea con tope 2000 y contador, y las dos leyendas', async () => {
    renderWidget();
    const dialog = await openDialog();
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

  it('el contador sigue al texto', async () => {
    renderWidget();
    const dialog = await openDialog();
    typeBody('hola');
    expect(dialog).toHaveTextContent('4 / 2000');
  });
});

describe('FeedbackWidget — captura de contexto en el submit', () => {
  it('manda route = pathname, url = href con query params, user_agent = navigator.userAgent y el type como literal', async () => {
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: '2026-09-03T12:00:00Z' });
    renderWidget();
    await openDialog();
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
    await openDialog();
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
    await openDialog();
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
    const dialog = await openDialog();
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
    await openDialog();
    clickSubmit();
    await new Promise((r) => setTimeout(r, 20));
    expect(submitFeedbackMock).not.toHaveBeenCalled();
  });

  it('solo espacios ⇒ cero llamadas', async () => {
    renderWidget();
    await openDialog();
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
    const dialog = await openDialog();
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
    await openDialog();
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
    await openDialog();
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByRole('radio', { name: W.types.bug })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: W.types.suggestion })).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByText(W.sent)).not.toBeInTheDocument();
  });

  it('rechazo ⇒ error visible, texto intacto, sin confirmación; el reintento exitoso recién entonces confirma', async () => {
    submitFeedbackMock.mockRejectedValueOnce(new ApiStatusError(500, 'Internal Server Error'));
    renderWidget();
    await openDialog();
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
    await openDialog();
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
    await openDialog();

    await waitFor(() => expect(captureScreenshotMock).toHaveBeenCalledTimes(1));
    // El tester puede tipear ANTES de que la captura resuelva.
    typeBody('ya puedo escribir');
    expect(screen.getByRole('textbox')).toHaveValue('ya puedo escribir');

    resolveCapture(new Blob(['x'], { type: 'image/png' }));
    // Resolver dispara setScreenshotPreviewUrl + el .then de uploadScreenshot
    // (mock default: resuelve null) — esperar su efecto para no dejar una
    // actualización de estado colgando tras el cleanup.
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(uploadScreenshotMock).toHaveResolved());
  });

  it('detectWebglCanvas true ⇒ muestra el aviso; false ⇒ no lo muestra', async () => {
    detectWebglCanvasMock.mockReturnValue(true);
    renderWidget();
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(W.webglNotice);
  });

  it('sin WebGL detectado, el aviso no aparece', async () => {
    detectWebglCanvasMock.mockReturnValue(false);
    renderWidget();
    const dialog = await openDialog();
    expect(dialog).not.toHaveTextContent(W.webglNotice);
  });

  it('el aviso WebGL nunca deshabilita ni retrasa el botón de enviar', async () => {
    detectWebglCanvasMock.mockReturnValue(true);
    renderWidget();
    await openDialog();
    typeBody('reporte con globo 3D');
    expect(screen.getByRole('button', { name: W.submit })).not.toBeDisabled();
    // captureScreenshot resuelve `null` (default de beforeEach) tras el
    // assert síncrono: esperar su resolución evita el warning de act() por
    // el setIsCapturing(false) que dispara después.
    await waitFor(() => expect(captureScreenshotMock).toHaveResolved());
  });

  it('si uploadScreenshot resuelve una key ANTES del submit, el payload la incluye', async () => {
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockResolvedValue('feedback-screenshots/abc.png');
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });

    renderWidget();
    await openDialog();
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
    await openDialog();
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

describe('FeedbackWidget — preview y descarte de la captura', () => {
  it('mientras captureScreenshot está pendiente muestra un indicador de "capturando"', async () => {
    let resolveCapture: (v: Blob | null) => void = () => {};
    captureScreenshotMock.mockImplementation(() => new Promise((resolve) => { resolveCapture = resolve; }));

    renderWidget();
    const dialog = await openDialog();
    expect(dialog).toHaveTextContent(W.capturing);

    resolveCapture(null);
    await waitFor(() => expect(captureScreenshotMock).toHaveResolved());
  });

  it('con captura+subida exitosas muestra un thumbnail y un botón para descartarla', async () => {
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockResolvedValue('feedback-screenshots/abc.png');

    renderWidget();
    const dialog = await openDialog();
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));

    expect(dialog).not.toHaveTextContent(W.capturing);
    expect(screen.getByRole('img', { name: W.screenshotPreviewAlt })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: W.discardScreenshot })).toBeInTheDocument();
  });

  it('descartar la captura la saca del payload y no vuelve a aparecer sola', async () => {
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockResolvedValue('feedback-screenshots/abc.png');
    submitFeedbackMock.mockResolvedValue({ id: 'r1', created_at: 'x' });

    renderWidget();
    await openDialog();
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: W.discardScreenshot }));
    expect(screen.queryByRole('img', { name: W.screenshotPreviewAlt })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: W.discardScreenshot })).not.toBeInTheDocument();

    typeBody('reporte sin captura a propósito');
    clickSubmit();
    await waitFor(() => expect(submitFeedbackMock).toHaveBeenCalledTimes(1));
    expect(submitFeedbackMock.mock.calls[0][0].screenshot_key).toBeUndefined();
  });

  it('si captureScreenshot resuelve null (falló o excede el tamaño) no muestra preview ni botón de descarte', async () => {
    captureScreenshotMock.mockResolvedValue(null);

    renderWidget();
    const dialog = await openDialog();
    await waitFor(() => expect(captureScreenshotMock).toHaveResolved());

    expect(dialog).not.toHaveTextContent(W.capturing);
    expect(screen.queryByRole('img', { name: W.screenshotPreviewAlt })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: W.discardScreenshot })).not.toBeInTheDocument();
  });

  it('al reabrir el diálogo el preview y el estado de descarte se resetean', async () => {
    captureScreenshotMock.mockResolvedValue(new Blob(['x'], { type: 'image/png' }));
    uploadScreenshotMock.mockResolvedValue('feedback-screenshots/abc.png');

    renderWidget();
    await openDialog();
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: W.discardScreenshot }));
    // Cerrar desde el formulario (sin enviar): no hay botón "Cerrar" en este
    // estado (solo existe en la confirmación post-201) — Escape es el cierre
    // estándar de Radix Dialog.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    captureScreenshotMock.mockClear();
    uploadScreenshotMock.mockClear();
    await openDialog();
    await waitFor(() => expect(uploadScreenshotMock).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('img', { name: W.screenshotPreviewAlt })).toBeInTheDocument();
  });
});
