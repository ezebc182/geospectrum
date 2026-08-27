/**
 * Panel del hilo de conversación de la ventana. Presentational puro: el
 * estado vive en use-window-comments y acá solo se prueba el contrato de UI —
 * quién ve el botón de borrar, qué dispara enviar, y el hilo en orden.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';

import es from '@/messages/es.json';
import type { WindowComment } from '@/hooks/use-window-comments';
import { WindowCommentsPanel } from './WindowCommentsPanel';

afterEach(cleanup);

const COMMENTS: WindowComment[] = [
  { id: 'c1', body: 'MIRAR ESTO', authorEmail: 'a@example.com', createdAt: '2026-08-24T12:01:00Z' },
  { id: 'c2', body: 'es un telesismo', authorEmail: 'b@example.com', createdAt: '2026-08-24T12:02:00Z' },
];

function renderPanel(over: Partial<Parameters<typeof WindowCommentsPanel>[0]> = {}) {
  const onSend = vi.fn(async () => {});
  const onDelete = vi.fn(async () => {});
  render(
    <NextIntlClientProvider locale="es-AR" messages={es} timeZone="UTC">
      <WindowCommentsPanel
        comments={over.comments ?? COMMENTS}
        status={over.status ?? 'ready'}
        currentUserEmail={over.currentUserEmail ?? 'a@example.com'}
        onSend={over.onSend ?? onSend}
        onDelete={over.onDelete ?? onDelete}
      />
    </NextIntlClientProvider>,
  );
  return { onSend, onDelete };
}

describe('WindowCommentsPanel', () => {
  it('muestra el hilo en orden con autor y mensaje', () => {
    renderPanel();
    const items = screen.getAllByTestId('window-comment');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain('a@example.com');
    expect(items[0].textContent).toContain('MIRAR ESTO');
    expect(items[1].textContent).toContain('es un telesismo');
  });

  it('el botón de borrar aparece SOLO en los mensajes propios', () => {
    renderPanel({ currentUserEmail: 'a@example.com' });
    const items = screen.getAllByTestId('window-comment');
    expect(items[0].querySelector('button')).not.toBeNull();
    // El de b@example.com no es mío: el backend daría 404 igual, pero
    // ofrecer un botón que va a fallar es mentirle al usuario.
    expect(items[1].querySelector('button')).toBeNull();
  });

  it('enviar llama onSend con el texto y limpia el input', async () => {
    const { onSend } = renderPanel();
    const input = screen.getByTestId('window-comment-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'qué frecuencia tiene?' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    expect(onSend).toHaveBeenCalledWith('qué frecuencia tiene?');
    await vi.waitFor(() => expect(input.value).toBe(''));
  });

  it('un envío vacío o de puros espacios no llama a nada', () => {
    const { onSend } = renderPanel();
    const input = screen.getByTestId('window-comment-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);
    expect(onSend).not.toHaveBeenCalled();
  });

  it('borrar un mensaje propio llama onDelete con su id', () => {
    const { onDelete } = renderPanel();
    const propio = screen.getAllByTestId('window-comment')[0];
    fireEvent.click(propio.querySelector('button') as HTMLButtonElement);
    expect(onDelete).toHaveBeenCalledWith('c1');
  });

  it('hilo vacío: invita a arrancar la conversación en vez de quedar mudo', () => {
    renderPanel({ comments: [] });
    expect(screen.getByTestId('window-comments-empty')).toBeTruthy();
  });
});
