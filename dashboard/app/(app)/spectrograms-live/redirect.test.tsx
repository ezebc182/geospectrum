import { describe, expect, it, vi } from 'vitest';

// La ruta vieja quedó publicada: hay links guardados y toasts que apuntan ahí.
// Un 404 sería una regresión para quien la tenga en favoritos.
const permanentRedirect = vi.fn();
vi.mock('next/navigation', () => ({ permanentRedirect }));

describe('/spectrograms-live', () => {
  it('redirige permanentemente a /spectrograms cuando no hay query params', async () => {
    const { default: Page } = await import('./page');
    await Page({ searchParams: Promise.resolve({}) });
    expect(permanentRedirect).toHaveBeenCalledWith('/spectrograms');
  });

  it('preserva los query params al redirigir (ej. ?tab=wall)', async () => {
    const { default: Page } = await import('./page');
    await Page({ searchParams: Promise.resolve({ tab: 'wall' }) });
    expect(permanentRedirect).toHaveBeenCalledWith('/spectrograms?tab=wall');
  });
});
