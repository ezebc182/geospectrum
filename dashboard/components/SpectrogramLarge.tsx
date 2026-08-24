/**
 * Espectrograma grande con ejes y colorbar (PR B del detalle de estación).
 *
 * Reusa el pipeline que ya existe —`/spectrograms/{channel}/history` para
 * pintar el pasado y `/ws/spectrogram/{channel}` para seguir en vivo— y la
 * paleta jet2 con la escala fija 20–120 dB. Lo que agrega es lo que la tira
 * del muro no necesita: ejes rotulados.
 *
 * Y eso cambia una decisión de dibujo. La tira en vivo posiciona cada bin por
 * su ÍNDICE (`i/n`), que alcanza cuando no hay eje. Acá cada bin se posiciona
 * por su FRECUENCIA REAL, porque el rango depende del canal (medido: hay
 * canales que llegan a 10 Hz, otros a 20 y otros a 25) y hasta cambia dentro
 * del mismo canal. Con un eje rotulado al lado, posicionar por índice haría
 * que el gráfico mintiera.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { jet2 } from '@/lib/jet2-palette';
import { powerDbToT } from '@/lib/spectrogram-scale';
import {
  type FrequencyAxis,
  freqToFraction,
  frequencyAxis,
  niceFrequencyTicks,
} from '@/lib/spectrogram-frequency-axis';
import {
  colorbarStops,
  niceTimeTicks,
  timeAxis,
  timeToFraction,
} from '@/lib/spectrogram-time-axis';

interface SpectrogramLargeProps {
  channel: string;
  width?: number;
  height?: number;
  /** Minutos de historial a pedir al montar. */
  minutes?: number;
}

interface SpecColumn {
  channel: string;
  endtime: string;
  freqs: number[];
  power_db: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const WS_BASE = API_BASE.replace(/^http/, 'ws');

const MARGIN_LEFT = 52; // etiquetas de frecuencia
const MARGIN_BOTTOM = 28; // etiquetas de tiempo (UTC)
const MARGIN_TOP = 8;
const MARGIN_RIGHT = 8;

/** Techo de columnas en memoria: una sesión larga no debe crecer sin límite. */
const MAX_COLUMNS = 4000;

export function SpectrogramLarge({
  channel,
  width = 960,
  height = 420,
  minutes = 60,
}: SpectrogramLargeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const t = useTranslations('station');
  const [columns, setColumns] = useState<SpecColumn[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'live' | 'empty' | 'error'>(
    'loading',
  );

  // Historial inicial.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `${API_BASE}/spectrograms/${encodeURIComponent(channel)}/history?minutes=${minutes}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const data: { columns?: SpecColumn[] } = await res.json();
        if (cancelled) return;
        const cols = data.columns ?? [];
        setColumns(cols);
        // Sin columnas no es un error: puede ser un canal que el ingestor no
        // sigue. Decirlo es más útil que mostrar un recuadro negro vacío.
        setStatus(cols.length === 0 ? 'empty' : 'ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [channel, minutes]);

  // Columnas nuevas en vivo.
  useEffect(() => {
    let ws: WebSocket | undefined;
    let cancelled = false;

    try {
      ws = new WebSocket(`${WS_BASE}/ws/spectrogram/${channel}`);
      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const col: SpecColumn = JSON.parse(event.data);
          setColumns((prev) => [...prev, col].slice(-MAX_COLUMNS));
          setStatus('live');
        } catch {
          // columna malformada: se ignora, no corta la conexión
        }
      };
    } catch {
      // sin WS el histórico igual se ve; no se degrada la vista
    }

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [channel]);

  const fAxis: FrequencyAxis = useMemo(
    () => frequencyAxis(columns.map((c) => c.freqs)),
    [columns],
  );
  const tAxis = useMemo(() => timeAxis(columns.map((c) => c.endtime)), [columns]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
    const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#000000';
    ctx.fillRect(MARGIN_LEFT, MARGIN_TOP, plotW, plotH);

    // --- columnas ---
    // El ancho de columna sale del tiempo, no de dividir el ancho por la
    // cantidad: con huecos en la serie, repartir parejo movería los eventos de
    // su hora real.
    const colW = Math.max(1, Math.ceil(plotW / Math.max(1, columns.length)));

    for (const col of columns) {
      const ms = Date.parse(col.endtime);
      if (!Number.isFinite(ms)) continue;
      const x = MARGIN_LEFT + timeToFraction(ms, tAxis) * (plotW - colW);

      const n = Math.min(col.freqs.length, col.power_db.length);
      for (let i = 0; i < n; i++) {
        const hz = col.freqs[i];
        if (!Number.isFinite(hz)) continue;
        // Cada bin cubre hasta el siguiente: sin esto quedan rayas negras
        // entre bins cuando el canvas es más alto que la cantidad de bins.
        const yTop = MARGIN_TOP + freqToFraction(hz, fAxis) * plotH;
        const hzNext = i + 1 < n ? col.freqs[i + 1] : hz;
        const yNext = MARGIN_TOP + freqToFraction(hzNext, fAxis) * plotH;
        const h = Math.max(1, Math.abs(yTop - yNext));

        ctx.fillStyle = jet2(powerDbToT(col.power_db[i]));
        ctx.fillRect(Math.round(x), Math.round(yTop - h), colW, Math.ceil(h));
      }
    }

    // --- eje de frecuencia ---
    ctx.fillStyle = '#cccccc';
    ctx.font = '11px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.strokeStyle = '#444444';

    for (const hz of niceFrequencyTicks(fAxis.fMin, fAxis.fMax)) {
      const y = MARGIN_TOP + freqToFraction(hz, fAxis) * plotH;
      ctx.fillText(`${hz}`, MARGIN_LEFT - 8, y);
      ctx.beginPath();
      ctx.moveTo(MARGIN_LEFT - 4, y);
      ctx.lineTo(MARGIN_LEFT, y);
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(12, MARGIN_TOP + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(t('freqAxis'), 0, 0);
    ctx.restore();

    // --- eje de tiempo (UTC, como el resto de la app) ---
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const ms of niceTimeTicks(tAxis.startMs, tAxis.endMs)) {
      const x = MARGIN_LEFT + timeToFraction(ms, tAxis) * plotW;
      ctx.fillText(new Date(ms).toISOString().slice(11, 16), x, height - MARGIN_BOTTOM + 6);
      ctx.beginPath();
      ctx.moveTo(x, height - MARGIN_BOTTOM);
      ctx.lineTo(x, height - MARGIN_BOTTOM + 4);
      ctx.stroke();
    }
  }, [columns, fAxis, tAxis, width, height, t]);

  if (status === 'error') {
    return (
      <div
        data-testid="spectrogram-large-error"
        className="rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300"
      >
        {t('spectrogramError')}
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-start gap-3">
        <canvas
          data-testid="spectrogram-large-canvas"
          ref={canvasRef}
          width={width}
          height={height}
          className="block rounded"
        />
        <Colorbar height={height - MARGIN_TOP - MARGIN_BOTTOM} label={t('powerAxis')} />
      </div>

      {status === 'empty' && (
        <p data-testid="spectrogram-large-empty" className="mt-2 text-sm text-amber-300">
          {t('spectrogramEmpty')}
        </p>
      )}
      {fAxis.mixedGrid && (
        <p data-testid="spectrogram-mixed-grid" className="mt-2 text-xs text-amber-400">
          {t('mixedGrid')}
        </p>
      )}
    </div>
  );
}

/** Colorbar de la escala fija 20–120 dB, con las etiquetas en los extremos. */
function Colorbar({ height, label }: { height: number; label: string }) {
  const stops = colorbarStops(12);
  return (
    <div className="flex flex-col items-center gap-1" data-testid="spectrogram-colorbar">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <div className="flex items-stretch gap-1">
        <div
          className="w-4 rounded"
          style={{
            height,
            // De arriba (máximo) hacia abajo (mínimo), igual que el eje.
            background: `linear-gradient(to top, ${stops
              .map((s) => s.color)
              .join(', ')})`,
          }}
        />
        <div className="flex flex-col justify-between text-[10px] text-muted-foreground">
          <span>{stops.at(-1)!.db}</span>
          <span>{stops[0].db}</span>
        </div>
      </div>
    </div>
  );
}
