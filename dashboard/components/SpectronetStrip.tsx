'use client';

import { LiveSpectrogramCanvas } from './LiveSpectrogramCanvas';

interface SpectronetStripProps {
  channel: string;
  label: string;
  width: number; // ancho de la tira (sin contar la etiqueta)
  height: number;
  /** Banda compacta ya formateada (PR-W3); null/undefined = no mostrarla. */
  metricsLine?: string | null;
}

export const SPECTRONET_LABEL_WIDTH = 96;

/** Tira estilo SPECTRONET: etiqueta blanca sobre negro a la izquierda, tira a la derecha. */
export function SpectronetStrip({
  channel,
  label,
  width,
  height,
  metricsLine,
}: SpectronetStripProps) {
  return (
    <div className="flex items-stretch" style={{ height }}>
      <div
        className="flex items-center justify-end bg-black pr-1.5 text-right font-mono text-[10px] font-bold uppercase leading-none tracking-tight text-white"
        style={{ width: SPECTRONET_LABEL_WIDTH }}
      >
        {label.toUpperCase()}
      </div>
      <div className="relative">
        <LiveSpectrogramCanvas channel={channel} label={label} width={width} height={height} variant="bare" />
        {metricsLine ? (
          /* Overlay absoluto a propósito: el muro de la cartelera está
             dimensionado para entrar sin scroll con ~74 tiras — si la banda
             ocupara flujo, empujaría el layout y desbordaría la pantalla. */
          <div
            data-testid="strip-metrics-band"
            className="pointer-events-none absolute bottom-0 left-0 z-10 bg-black/60 px-1 font-mono text-[8px] leading-3 text-gray-200"
          >
            {metricsLine}
          </div>
        ) : null}
      </div>
    </div>
  );
}
