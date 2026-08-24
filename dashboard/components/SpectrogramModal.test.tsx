import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import { SpectrogramModal } from './SpectrogramModal';
import messages from '../messages/es.json';

// SpectrogramLarge pega a red y dibuja en canvas: acá se testea el MODAL,
// no el espectrograma. Ese ya tiene sus propios tests.
vi.mock('./SpectrogramLarge', () => ({
  SpectrogramLarge: ({ channel }: { channel: string }) => (
    <div data-testid="spectrogram-large-stub">{channel}</div>
  ),
}));

const renderModal = (props: Partial<Parameters<typeof SpectrogramModal>[0]> = {}) =>
  render(
    <NextIntlClientProvider locale="es" messages={messages}>
      <SpectrogramModal
        channel="AR.TEST..HHZ"
        cityName="Mendoza"
        open
        onClose={vi.fn()}
        {...props}
      />
    </NextIntlClientProvider>,
  );

describe('SpectrogramModal', () => {
  it('no renderiza nada cuando esta cerrado', () => {
    renderModal({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('muestra el espectrograma grande del canal', () => {
    renderModal();
    expect(screen.getByTestId('spectrogram-large-stub')).toHaveTextContent('AR.TEST..HHZ');
  });

  it('muestra el nombre de la ciudad y el canal en el encabezado', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toHaveTextContent('Mendoza');
    expect(screen.getByRole('dialog')).toHaveTextContent('AR.TEST..HHZ');
  });

  it('ofrece un enlace al detalle de estacion', () => {
    renderModal();
    const link = screen.getByTestId('modal-station-link');
    expect(link).toHaveAttribute('href', '/stations/AR.TEST..HHZ');
  });

  it('escapa el canal en el href — un SCNL lleva puntos', () => {
    renderModal({ channel: 'NZ.KHZ.10.HHZ' });
    expect(screen.getByTestId('modal-station-link')).toHaveAttribute(
      'href',
      '/stations/NZ.KHZ.10.HHZ',
    );
  });

  it('cierra con el boton de cerrar', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('modal-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cierra con Escape', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('cierra al hacer clic en el fondo', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('modal-backdrop'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('NO cierra al hacer clic dentro del contenido', () => {
    const onClose = vi.fn();
    renderModal({ onClose });
    fireEvent.click(screen.getByTestId('spectrogram-large-stub'));
    expect(onClose).not.toHaveBeenCalled();
  });
});
