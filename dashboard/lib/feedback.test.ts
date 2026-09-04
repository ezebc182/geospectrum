import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatusError } from './auth';
import {
  FEEDBACK_SWR_KEY,
  FLOW_STATUSES,
  getScreenshotDownloadUrl,
  listFeedbackReports,
  requestScreenshotUploadUrl,
  submitFeedback,
  updateFeedbackComment,
  updateFeedbackStatus,
} from './feedback';

const PAYLOAD = {
  type: 'bug' as const,
  body: 'El helicorder no carga',
  route: '/analytics',
  url: 'http://localhost:3000/analytics?channel=AK.FIRE..BHZ&start=1&end=2',
  user_agent: 'Mozilla/5.0 (test)',
};

const REPORT = {
  id: 'r1',
  type: 'bug',
  body: 'texto',
  route: '/live',
  url: 'http://localhost:3000/live',
  user_agent: 'UA',
  author_email: 'a@example.com',
  created_at: '2026-09-03T12:00:00Z',
  status: 'new',
  status_changed_at: null,
  admin_comment: null,
  admin_comment_updated_at: null,
  screenshot_key: null,
};

function mockFetch(status: number, body: unknown = null) {
  const response = {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: () => Promise.resolve(body),
  } as Response;
  const spy = vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(response));
  vi.stubGlobal('fetch', spy);
  return spy;
}

function lastCall(spy: ReturnType<typeof mockFetch>): [string, RequestInit] {
  return spy.mock.calls[0] as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

describe('feedback client — constantes', () => {
  it('FEEDBACK_SWR_KEY es /feedback', () => {
    expect(FEEDBACK_SWR_KEY).toBe('/feedback');
  });

  it('FLOW_STATUSES tiene los cuatro estados del flujo en orden (sin discarded)', () => {
    expect(FLOW_STATUSES).toEqual(['new', 'in_analysis', 'in_progress', 'done']);
  });
});

describe('submitFeedback', () => {
  it('hace POST /feedback con el payload serializado y credentials include', async () => {
    const spy = mockFetch(201, { id: 'r1', created_at: '2026-09-03T12:00:00Z' });
    const result = await submitFeedback(PAYLOAD);
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual(PAYLOAD);
    expect(result).toEqual({ id: 'r1', created_at: '2026-09-03T12:00:00Z' });
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await submitFeedback(PAYLOAD)).toBeNull();
  });

  it('422 lanza ApiStatusError con status y detail', async () => {
    mockFetch(422, { detail: 'body must not be blank' });
    const error = await submitFeedback(PAYLOAD).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(422);
    expect(error.message).toContain('body must not be blank');
  });
});

describe('listFeedbackReports', () => {
  it('hace GET /feedback y desenvuelve {reports}', async () => {
    const spy = mockFetch(200, { reports: [REPORT] });
    const result = await listFeedbackReports();
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback$/);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.credentials).toBe('include');
    expect(result).toEqual([REPORT]);
  });

  it('tablero vacío ⇒ []', async () => {
    mockFetch(200, { reports: [] });
    expect(await listFeedbackReports()).toEqual([]);
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await listFeedbackReports()).toBeNull();
  });

  it('500 lanza ApiStatusError', async () => {
    mockFetch(500, { detail: 'boom' });
    const error = await listFeedbackReports().catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(500);
    expect(error.message).toContain('boom');
  });
});

describe('updateFeedbackStatus', () => {
  it('hace PUT /feedback/{id}/status con {"status":"done"}', async () => {
    const spy = mockFetch(200, { ...REPORT, status: 'done' });
    const result = await updateFeedbackStatus('r1', 'done');
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback\/r1\/status$/);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ status: 'done' });
    expect(result?.status).toBe('done');
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await updateFeedbackStatus('r1', 'done')).toBeNull();
  });

  it('403 lanza ApiStatusError con status y detail', async () => {
    mockFetch(403, { detail: 'insufficient role' });
    const error = await updateFeedbackStatus('r1', 'done').catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('insufficient role');
  });
});

describe('updateFeedbackComment', () => {
  it('hace PUT /feedback/{id}/comment con {"comment":null} al vaciar', async () => {
    const spy = mockFetch(200, REPORT);
    await updateFeedbackComment('r1', null);
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback\/r1\/comment$/);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body as string)).toEqual({ comment: null });
  });

  it('con texto manda el texto', async () => {
    const spy = mockFetch(200, { ...REPORT, admin_comment: 'Reproducido' });
    const result = await updateFeedbackComment('r1', 'Reproducido');
    const [, init] = lastCall(spy);
    expect(JSON.parse(init.body as string)).toEqual({ comment: 'Reproducido' });
    expect(result?.admin_comment).toBe('Reproducido');
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await updateFeedbackComment('r1', 'x')).toBeNull();
  });

  it('422 lanza ApiStatusError con status y detail', async () => {
    mockFetch(422, { detail: 'String should have at most 2000 characters' });
    const error = await updateFeedbackComment('r1', 'x'.repeat(2001)).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(422);
    expect(error.message).toContain('2000');
  });
});

describe('requestScreenshotUploadUrl', () => {
  it('hace POST /feedback/upload-url y devuelve {key, upload_url, expires_at}', async () => {
    const spy = mockFetch(201, {
      key: 'feedback-screenshots/abc.png',
      upload_url: 'https://r2.example.com/put',
      expires_at: '2026-09-03T12:05:00Z',
    });
    const result = await requestScreenshotUploadUrl();
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback\/upload-url$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(result).toEqual({
      key: 'feedback-screenshots/abc.png',
      upload_url: 'https://r2.example.com/put',
      expires_at: '2026-09-03T12:05:00Z',
    });
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await requestScreenshotUploadUrl()).toBeNull();
  });

  it('503 (R2 sin configurar) lanza ApiStatusError', async () => {
    mockFetch(503, { detail: 'screenshot storage not configured' });
    const error = await requestScreenshotUploadUrl().catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(503);
    expect(error.message).toContain('not configured');
  });
});

describe('getScreenshotDownloadUrl', () => {
  it('hace GET /feedback/{id}/screenshot-url y devuelve {url, expires_at}', async () => {
    const spy = mockFetch(200, { url: 'https://r2.example.com/get', expires_at: '2026-09-03T12:05:00Z' });
    const result = await getScreenshotDownloadUrl('r1');
    const [url, init] = lastCall(spy);
    expect(url).toMatch(/\/feedback\/r1\/screenshot-url$/);
    expect(init.method ?? 'GET').toBe('GET');
    expect(init.credentials).toBe('include');
    expect(result).toEqual({ url: 'https://r2.example.com/get', expires_at: '2026-09-03T12:05:00Z' });
  });

  it('401 devuelve null', async () => {
    mockFetch(401);
    expect(await getScreenshotDownloadUrl('r1')).toBeNull();
  });

  it('404 (sin captura) lanza ApiStatusError', async () => {
    mockFetch(404, { detail: 'not found' });
    const error = await getScreenshotDownloadUrl('r1').catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(404);
  });
});
