import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock de modern-screenshot: domToBlob es la única función que consume
// captureScreenshot(). El molde vi.mock + vi.hoisted evita el problema de
// referencias inestables entre tests (misma lección de mocks de router).
const { domToBlobMock } = vi.hoisted(() => ({ domToBlobMock: vi.fn() }));
vi.mock('modern-screenshot', () => ({ domToBlob: domToBlobMock }));

import { captureScreenshot, detectWebglCanvas, uploadScreenshot } from './screenshot';

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
  let call = 0;
  const spy = vi.fn((_input: string, _init?: RequestInit) => {
    const { status, body } = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: String(status),
      json: () => Promise.resolve(body ?? null),
    } as Response);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Canvas stub: getContext devuelve un objeto no-null para los ids en
 * `withContext`, null para el resto — así se simulan las combinaciones
 * webgl/webgl2/2d sin depender del soporte WebGL real de jsdom (que no
 * existe: HTMLCanvasElement.prototype.getContext('webgl') es null por
 * default en jsdom). */
function stubCanvases(perCanvasContexts: Array<readonly string[]>) {
  const canvases = perCanvasContexts.map((withContext) => {
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockImplementation(((id: string) =>
      withContext.includes(id) ? {} : null) as typeof canvas.getContext);
    return canvas;
  });
  vi.spyOn(document, 'querySelectorAll').mockReturnValue(canvases as unknown as NodeListOf<Element>);
  return canvases;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('detectWebglCanvas', () => {
  it('un canvas con getContext("webgl") no-null ⇒ true', () => {
    stubCanvases([['webgl']]);
    expect(detectWebglCanvas()).toBe(true);
  });

  it('un canvas con getContext("webgl2") no-null ⇒ true', () => {
    stubCanvases([['webgl2']]);
    expect(detectWebglCanvas()).toBe(true);
  });

  it('getContext devuelve null para webgl y webgl2 en todos los canvases ⇒ false', () => {
    stubCanvases([['2d'], ['2d']]);
    expect(detectWebglCanvas()).toBe(false);
  });

  it('sin ningún canvas en el DOM ⇒ false', () => {
    stubCanvases([]);
    expect(detectWebglCanvas()).toBe(false);
  });
});

describe('uploadScreenshot', () => {
  const blob = new Blob(['x'], { type: 'image/png' });

  it('presign responde 503 ⇒ devuelve null sin lanzar', async () => {
    mockFetch([{ status: 503, body: { detail: 'not configured' } }]);
    await expect(uploadScreenshot(blob)).resolves.toBeNull();
  });

  it('presign 201 pero el PUT a upload_url rechaza (!ok) ⇒ null sin lanzar', async () => {
    mockFetch([
      {
        status: 201,
        body: {
          key: 'feedback-screenshots/abc.png',
          upload_url: 'https://r2.example.com/put',
          expires_at: '2026-09-03T12:05:00Z',
        },
      },
      { status: 500 },
    ]);
    await expect(uploadScreenshot(blob)).resolves.toBeNull();
  });

  it('presign 201 pero el PUT rechaza por network error ⇒ null sin lanzar', async () => {
    let call = 0;
    const spy = vi.fn(() => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          ok: true,
          status: 201,
          statusText: '201',
          json: () =>
            Promise.resolve({
              key: 'feedback-screenshots/abc.png',
              upload_url: 'https://r2.example.com/put',
              expires_at: '2026-09-03T12:05:00Z',
            }),
        } as Response);
      }
      return Promise.reject(new TypeError('network error'));
    });
    vi.stubGlobal('fetch', spy);
    await expect(uploadScreenshot(blob)).resolves.toBeNull();
  });

  it('ambos éxito ⇒ devuelve la key del presign, y el PUT se hizo con el blob y Content-Type: image/png', async () => {
    const spy = mockFetch([
      {
        status: 201,
        body: {
          key: 'feedback-screenshots/abc.png',
          upload_url: 'https://r2.example.com/put',
          expires_at: '2026-09-03T12:05:00Z',
        },
      },
      { status: 200 },
    ]);
    await expect(uploadScreenshot(blob)).resolves.toBe('feedback-screenshots/abc.png');

    const [putUrl, putInit] = spy.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('https://r2.example.com/put');
    expect(putInit.method).toBe('PUT');
    expect(putInit.body).toBe(blob);
    expect((putInit.headers as Record<string, string>)['Content-Type']).toBe('image/png');
  });
});

describe('captureScreenshot', () => {
  it('modern-screenshot lanza ⇒ devuelve null sin propagar la excepción', async () => {
    domToBlobMock.mockRejectedValueOnce(new Error('captura falló'));
    await expect(captureScreenshot()).resolves.toBeNull();
  });

  it('un blob mayor a 2MB tras "comprimir" ⇒ null (descartado por tamaño, no se sube)', async () => {
    const oversized = { size: 2 * 1024 * 1024 + 1, type: 'image/png' } as Blob;
    domToBlobMock.mockResolvedValueOnce(oversized);
    await expect(captureScreenshot()).resolves.toBeNull();
  });

  it('un blob dentro del límite se devuelve tal cual', async () => {
    const ok = { size: 1024, type: 'image/png' } as Blob;
    domToBlobMock.mockResolvedValueOnce(ok);
    await expect(captureScreenshot()).resolves.toBe(ok);
  });
});
