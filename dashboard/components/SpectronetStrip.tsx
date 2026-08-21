'use client';

import { LiveSpectrogramCanvas } from './LiveSpectrogramCanvas';

interface SpectronetStripProps {
  channel: string;
  label: string;
  width: number; // ancho de la tira (sin contar la etiqueta)
  height: number;
}

export const SPECTRONET_LABEL_WIDTH = 96;

/** Tira estilo SPECTRONET: etiqueta blanca sobre negro a la izquierda, tira a la derecha. */
export function SpectronetStrip({ channel, label, width, height }: SpectronetStripProps) {
  return (
    <div className="flex items-stretch" style={{ height }}>
      <div
        className="flex items-center justify-end bg-black pr-1.5 text-right font-mono text-[10px] font-bold uppercase leading-none tracking-tight text-white"
        style={{ width: SPECTRONET_LABEL_WIDTH }}
      >
        {label.toUpperCase()}
      </div>
      <LiveSpectrogramCanvas channel={channel} label={label} width={width} height={height} variant="bare" />
    </div>
  );
}
