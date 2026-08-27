/**
 * El hook del hilo de conversación por ventana. La API se mockea entera;
 * el contrato bajo prueba es el del hook (siembra por efecto, alta que
 * agrega al final, borrado que filtra) — no la red.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { seismicAPI, type WindowCommentRecord } from '@/lib/api';
import { useWindowComments } from './use-window-comments';

vi.mock('@/lib/api', () => ({
  seismicAPI: {
    getWindowComments: vi.fn(),
    createWindowComment: vi.fn(),
    deleteWindowComment: vi.fn(),
  },
}));

const T0 = Date.UTC(2026, 7, 24, 12, 0, 0);
const WINDOW = { startMs: T0, endMs: T0 + 600_000 };
const CHANNEL = 'AK.FIRE..BHZ';

function record(id: string, body: string, email = 'a@example.com'): WindowCommentRecord {
  const iso = new Date(T0).toISOString();
  return {
    id,
    channel: CHANNEL,
    window_start: iso,
    window_end: new Date(T0 + 600_000).toISOString(),
    body,
    anchor_time: null,
    author_email: email,
    created_at: iso,
  };
}

afterEach(() => {
  vi.mocked(seismicAPI.getWindowComments).mockReset();
  vi.mocked(seismicAPI.createWindowComment).mockReset();
  vi.mocked(seismicAPI.deleteWindowComment).mockReset();
});

describe('useWindowComments', () => {
  it('sin ventana no pide nada y queda idle', () => {
    const { result } = renderHook(() => useWindowComments(CHANNEL, null));

    expect(result.current.status).toBe('idle');
    expect(result.current.comments).toEqual([]);
    expect(seismicAPI.getWindowComments).not.toHaveBeenCalled();
  });

  it('con ventana siembra el hilo por efecto', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockResolvedValue({
      comments: [record('c1', 'hola'), record('c2', 'qué pico raro', 'b@example.com')],
    });

    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.comments.map((c) => c.body)).toEqual(['hola', 'qué pico raro']);
    expect(result.current.comments[1].authorEmail).toBe('b@example.com');
  });

  it('addComment postea con la ventana y agrega al final del hilo', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockResolvedValue({ comments: [record('c1', 'hola')] });
    vi.mocked(seismicAPI.createWindowComment).mockResolvedValue(record('c2', 'nuevo'));

    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.addComment('nuevo');
    });

    expect(seismicAPI.createWindowComment).toHaveBeenCalledWith(CHANNEL, WINDOW, 'nuevo', null);
    expect(result.current.comments.map((c) => c.body)).toEqual(['hola', 'nuevo']);
  });

  it('removeComment borra en la API y saca el mensaje del hilo', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockResolvedValue({
      comments: [record('c1', 'hola'), record('c2', 'chau')],
    });
    vi.mocked(seismicAPI.deleteWindowComment).mockResolvedValue(undefined);

    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.removeComment('c1');
    });

    expect(seismicAPI.deleteWindowComment).toHaveBeenCalledWith(CHANNEL, 'c1');
    expect(result.current.comments.map((c) => c.body)).toEqual(['chau']);
  });

  it('un fallo del fetch marca error sin romper', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockRejectedValue(new Error('500'));

    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));

    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.comments).toEqual([]);
  });
});

describe('apuntes anclados', () => {
  it('addComment con ancla la pasa a la API y el mensaje la conserva', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockResolvedValue({ comments: [] });
    vi.mocked(seismicAPI.createWindowComment).mockResolvedValue({
      ...record('c9', 'acá arranca'),
      anchor_time: new Date(T0 + 187_000).toISOString(),
    });

    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    await act(async () => {
      await result.current.addComment('acá arranca', T0 + 187_000);
    });

    expect(seismicAPI.createWindowComment).toHaveBeenCalledWith(
      CHANNEL,
      WINDOW,
      'acá arranca',
      T0 + 187_000,
    );
    expect(result.current.comments[0].anchorTimeMs).toBe(T0 + 187_000);
  });

  it('sin ancla, anchorTimeMs es null (mensaje común del hilo)', async () => {
    vi.mocked(seismicAPI.getWindowComments).mockResolvedValue({
      comments: [record('c1', 'hola')],
    });
    const { result } = renderHook(() => useWindowComments(CHANNEL, WINDOW));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.comments[0].anchorTimeMs).toBeNull();
  });
});
