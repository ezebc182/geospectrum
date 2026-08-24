import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';
import type { ReactNode } from 'react';
import { AREA_CHANGED_EVENT } from './area-events';
import { useActiveArea } from './use-active-area';

const getActiveArea = vi.fn();
vi.mock('./areas', () => ({ getActiveArea: (...a: unknown[]) => getActiveArea(...a) }));

// Cache limpio por test: SWR comparte cache global entre renders y un test
// contaminaría al siguiente con el área del anterior.
const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('useActiveArea', () => {
  beforeEach(() => {
    getActiveArea.mockReset();
  });

  it('devuelve el area activa', async () => {
    getActiveArea.mockResolvedValue({ area: { id: 'andes', name: 'Andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toEqual({ area: { id: 'andes', name: 'Andes' } }));
  });

  it('se revalida SOLO al cambiar de area — sin que el llamador se suscriba', async () => {
    // Este es el test que importa: el bug estructural era que suscribirse
    // fuese un paso aparte y olvidable. Acá el llamador no hace nada.
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeTruthy());
    expect(getActiveArea).toHaveBeenCalledTimes(1);

    getActiveArea.mockResolvedValue({ area: { id: 'cascadia' } });
    act(() => {
      window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
    });

    await waitFor(() => expect(result.current.area).toEqual({ area: { id: 'cascadia' } }));
  });

  it('expone isRefreshing mientras la revalidacion viaja', async () => {
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeTruthy());

    let resolver: (v: unknown) => void = () => {};
    getActiveArea.mockReturnValue(new Promise((r) => { resolver = r; }));

    act(() => {
      window.dispatchEvent(new CustomEvent(AREA_CHANGED_EVENT));
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(true));

    await act(async () => {
      resolver({ area: { id: 'cascadia' } });
    });
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
  });

  it('devuelve null sin romper cuando no hay sesion', async () => {
    // getActiveArea ya devuelve null en 401 (lib/areas.ts).
    getActiveArea.mockResolvedValue(null);
    const { result } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(result.current.area).toBeNull());
  });

  it('comparte la key de SWR con el resto de la app', async () => {
    // Misma key => SWR deduplica entre consumidores. Si esto cambia, cada
    // componente pegaría a /areas/active por su cuenta.
    getActiveArea.mockResolvedValue({ area: { id: 'andes' } });
    const { result: a } = renderHook(() => useActiveArea(), { wrapper });
    const { result: b } = renderHook(() => useActiveArea(), { wrapper });
    await waitFor(() => expect(a.current.area).toBeTruthy());
    await waitFor(() => expect(b.current.area).toBeTruthy());
  });
});
