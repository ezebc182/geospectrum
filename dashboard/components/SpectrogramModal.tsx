/**
 * Vista ampliada del espectrograma de una tarjeta del muro.
 *
 * Antes "Ampliar" era un <Link> que NAVEGABA al detalle de estación: se perdía
 * el muro y había que volver con el botón atrás. Acá amplía de verdad —el mismo
 * canvas con ejes y zoom que usa el detalle— y deja ir a la estación como una
 * OPCIÓN, no como el único destino.
 */

'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ExternalLink, X } from 'lucide-react';
import { SpectrogramLarge } from '@/components/SpectrogramLarge';

interface SpectrogramModalProps {
  channel: string;
  cityName: string;
  open: boolean;
  onClose: () => void;
}

export function SpectrogramModal({ channel, cityName, open, onClose }: SpectrogramModalProps) {
  const t = useTranslations('charts.spectrogram');

  // Escape a nivel documento y no en el contenedor: el foco puede estar en el
  // canvas, en el link o en ninguno, y un handler local no lo cubriría.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // El scroll del fondo se bloquea mientras el modal está abierto: sin esto,
  // la rueda del mouse sobre el espectrograma (que ahora hace zoom) también
  // desplazaría la página de atrás.
  useEffect(() => {
    if (!open) return;
    const previo = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previo;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        data-testid="modal-backdrop"
        onClick={onClose}
        className="absolute inset-0 bg-black/80"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('modalTitle', { city: cityName })}
        className="relative z-10 max-h-full w-full max-w-5xl overflow-auto rounded-lg bg-neutral-900 p-4 shadow-xl ring-1 ring-white/10"
      >
        <div className="mb-3 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-white">{cityName}</h2>
            <p className="truncate font-data text-xs text-gray-400">{channel}</p>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Link
              data-testid="modal-station-link"
              href={`/stations/${encodeURIComponent(channel)}`}
              className="flex items-center gap-1 rounded bg-teal-600 px-2 py-1 text-xs font-semibold text-white hover:bg-teal-500"
            >
              <ExternalLink className="h-3 w-3" />
              {t('viewStationDetail')}
            </Link>
            <button
              type="button"
              data-testid="modal-close"
              onClick={onClose}
              aria-label={t('closeModal')}
              title={t('closeModal')}
              className="rounded p-1 text-gray-300 hover:bg-white/10 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <SpectrogramLarge channel={channel} width={880} height={400} minutes={60} />
      </div>
    </div>
  );
}
