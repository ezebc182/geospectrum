import { describe, expect, it, vi } from 'vitest';

// La ruta vieja quedó publicada: hay links guardados y toasts que apuntan ahí.
// Un 404 sería una regresión para quien la tenga en favoritos.
const redirect = vi.fn();
vi.mock('next/navigation', () => ({ redirect }));

describe('/spectrograms-live', () => {
  it('redirige permanentemente a /spectrograms', async () => {
    const { default: Page } = await import('./page');
    Page();
    expect(redirect).toHaveBeenCalledWith('/spectrograms');
  });
});
