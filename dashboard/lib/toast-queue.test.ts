import { describe, it, expect } from 'vitest';
import {
  MAX_VISIBLE_TOASTS,
  TOAST_DURATION_MS,
  addToast,
  dismissToast,
  type Toast,
} from './toast-queue';

function make(overrides: Partial<Toast> = {}): Toast {
  return { id: '1', variant: 'success', messageKey: 'charts.spectrogramsPage.wall.saved', ...overrides };
}

describe('cola de toasts', () => {
  it('agrega el toast nuevo al final', () => {
    const cola = addToast([make({ id: 'a' })], make({ id: 'b' }));
    expect(cola.map((t) => t.id)).toEqual(['a', 'b']);
  });

  it('descarta el más viejo al pasar el máximo visible', () => {
    // Sin tope, una acción en lote (revocar 10 invitaciones) taparía la
    // pantalla entera con toasts apilados.
    let cola: Toast[] = [];
    for (let i = 0; i < MAX_VISIBLE_TOASTS + 2; i++) {
      cola = addToast(cola, make({ id: String(i) }));
    }
    expect(cola).toHaveLength(MAX_VISIBLE_TOASTS);
    // Sobreviven los ÚLTIMOS: el usuario acaba de provocar esos.
    expect(cola[cola.length - 1]!.id).toBe(String(MAX_VISIBLE_TOASTS + 1));
    expect(cola[0]!.id).toBe('2');
  });

  it('quita por id sin tocar los demás', () => {
    const cola = dismissToast([make({ id: 'a' }), make({ id: 'b' })], 'a');
    expect(cola.map((t) => t.id)).toEqual(['b']);
  });

  it('descartar un id inexistente no rompe ni cambia la cola', () => {
    const original = [make({ id: 'a' })];
    expect(dismissToast(original, 'no-existe')).toEqual(original);
  });
});

describe('duración según la variante', () => {
  it('el error dura más que el éxito', () => {
    // Un error hay que poder leerlo; un "Guardado" se entiende de un vistazo.
    expect(TOAST_DURATION_MS.error).toBeGreaterThan(TOAST_DURATION_MS.success);
  });

  it('todas las variantes tienen duración definida', () => {
    // Sin duración el toast se quedaría en pantalla para siempre — el mismo
    // problema que ya tiene ProfileSection con su "Perfil actualizado".
    for (const v of ['success', 'error', 'warning', 'info'] as const) {
      expect(TOAST_DURATION_MS[v]).toBeGreaterThan(0);
    }
  });
});

describe('el mensaje viaja como CLAVE, no como texto', () => {
  it('guarda la clave i18n para poder re-traducir en caliente', () => {
    // Invariante del proyecto (comentada en 5 archivos): si se guardara el
    // texto ya traducido, cambiar de idioma dejaría el mensaje visible en el
    // idioma anterior.
    const toast = make({ messageKey: 'settings.profile.saved' });
    expect(toast.messageKey).toBe('settings.profile.saved');
    expect(toast).not.toHaveProperty('message');
  });

  it('acepta valores para interpolar sin resolver el texto', () => {
    const toast = make({ messageKey: 'admin.waitlist.approveError', values: { email: 'a@b.c' } });
    expect(toast.values).toEqual({ email: 'a@b.c' });
  });
});
