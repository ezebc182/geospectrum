import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiStatusError } from './auth';
import { createWall, deleteWall, listWalls } from './walls';

const LAYOUT = { columns: [{ groups: [] }], showMetrics: false };

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

afterEach(() => vi.unstubAllGlobals());

describe('walls client', () => {
  it('manda credentials include y content-type JSON', async () => {
    const spy = mockFetch(200, []);
    await listWalls();
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('401 devuelve null (sin sesión no es un error)', async () => {
    mockFetch(401);
    expect(await listWalls()).toBeNull();
  });

  it('409 lanza ApiStatusError con el detail del backend', async () => {
    mockFetch(409, { detail: "Wall 'Uno' already exists" });
    const error = await createWall({ name: 'Uno', layout: LAYOUT }).catch((e) => e);
    expect(error).toBeInstanceOf(ApiStatusError);
    expect(error.status).toBe(409);
    expect(error.message).toContain('already exists');
  });

  it('delete con 204 resuelve sin intentar parsear body', async () => {
    mockFetch(204);
    await expect(deleteWall('abc')).resolves.toBeUndefined();
  });
});
