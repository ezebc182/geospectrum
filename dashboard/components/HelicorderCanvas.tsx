/**
 * Helicorder de 24 h con paridad visual SWARM (HelicorderRenderer.java, CC0).
 *
 * El helicorder es el gráfico clásico del sismógrafo de tambor: el día se
 * corta en franjas de `timeChunkMinutes` y cada franja se dibuja como una
 * fila, así 24 h entran en una pantalla. Cada columna de píxel es un par
 * (min, max) — por eso el backend decima min/max y no submuestrea: un pico de
 * un segundo tiene que sobrevivir aunque la fila resuma media hora.
 *
 * Toda la geometría vive en `lib/helicorder-layout.ts`, testeada sin canvas.
 * Acá queda sólo el dibujo.
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import {
  HELICORDER_CLIP_COLOR,
  autoClipValue,
  clampToClip,
  majorTickMinutes,
  rowBias,
  rowColor,
  rowCount,
} from '@/lib/helicorder-layout';

interface HelicorderCanvasProps {
  /** SCNL completo, ej. "IU.MAJO..BHZ". */
  channel: string;
  timeChunkMinutes: number;
  width: number;
  height: number;
}

interface WaveformResponse {
  channel: string;
  sampling_rate: number;
  starttime: string;
  endtime: string;
  mins: number[];
  maxs: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const MARGIN_LEFT = 56; // etiquetas de hora local
const MARGIN_RIGHT = 56; // etiquetas UTC
const TOTAL_MINUTES = 1440; // 24 h
/** ~1 par por píxel útil de ancho de fila. */
const PAIRS_PER_ROW = 800;

export function HelicorderCanvas({
  channel,
  timeChunkMinutes,
  width,
  height,
}: HelicorderCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;

    const draw = (wf: WaveformResponse) => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      // Fondo blanco, como el helicorder de SWARM
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      const rows = rowCount(TOTAL_MINUTES, timeChunkMinutes);
      const rowH = height / rows;
      const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
      const pairsPerRow = Math.max(1, Math.floor(wf.mins.length / rows));

      // El clip se calcula sobre el día ENTERO, no por fila: si cada fila
      // tuviera su propia escala, una hora tranquila se vería tan agitada
      // como uno con un sismo y el gráfico mentiría.
      const clipValue = autoClipValue(wf.mins, wf.maxs);
      const startMs = Date.parse(wf.starttime);
      const tickEvery = majorTickMinutes(timeChunkMinutes);
      const scale = (rowH / 2 - 1) / clipValue;

      for (let r = 0; r < rows; r++) {
        const centerY = r * rowH + rowH / 2;
        const from = r * pairsPerRow;
        const to = Math.min(from + pairsPerRow, wf.mins.length);

        // Bias POR FILA (paridad SWARM): una deriva lenta del instrumento no
        // despega las filas de la tarde de su eje.
        const bias = rowBias(wf.mins, wf.maxs, from, to);

        // Ticks mayores de la fila
        ctx.strokeStyle = '#dddddd';
        for (let m = 0; m < timeChunkMinutes; m += tickEvery) {
          const x = MARGIN_LEFT + (m / timeChunkMinutes) * plotW;
          ctx.beginPath();
          ctx.moveTo(x, r * rowH);
          ctx.lineTo(x, (r + 1) * rowH);
          ctx.stroke();
        }

        // Etiquetas: hora local a la izquierda, UTC a la derecha
        const rowDate = new Date(startMs + r * timeChunkMinutes * 60_000);
        ctx.fillStyle = '#333333';
        ctx.font = '10px monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        ctx.fillText(
          rowDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          4,
          centerY,
        );
        ctx.textAlign = 'right';
        ctx.fillText(`${rowDate.toISOString().slice(11, 16)}Z`, width - 4, centerY);
        ctx.textAlign = 'left';

        // Trazas min/max de la fila con el azul cíclico; clip en rojo
        const base = rowColor(r);
        const anchoFila = to - from;
        for (let i = 0; i < anchoFila; i++) {
          const x = MARGIN_LEFT + (i / anchoFila) * plotW;
          const lo = clampToClip(wf.mins[from + i] - bias, clipValue);
          const hi = clampToClip(wf.maxs[from + i] - bias, clipValue);
          ctx.strokeStyle = lo.clipped || hi.clipped ? HELICORDER_CLIP_COLOR : base;
          ctx.beginPath();
          ctx.moveTo(x, centerY - hi.v * scale);
          ctx.lineTo(x, centerY - lo.v * scale);
          ctx.stroke();
        }
      }
    };

    const load = async () => {
      try {
        const points = rowCount(TOTAL_MINUTES, timeChunkMinutes) * PAIRS_PER_ROW;
        // El SCNL va escapado: lleva puntos y algunas estaciones, espacios.
        const res = await fetch(
          `${API_BASE}/stations/${encodeURIComponent(channel)}/waveform` +
            `?minutes=${TOTAL_MINUTES}&points=${points}`,
        );
        if (!res.ok) throw new Error(String(res.status));
        const wf: WaveformResponse = await res.json();
        if (cancelled) return;
        draw(wf);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('error');
      }
    };

    setStatus('loading');
    load();
    return () => {
      cancelled = true;
    };
  }, [channel, timeChunkMinutes, width, height]);

  if (status === 'error') {
    return (
      <div
        data-testid="helicorder-error"
        className="rounded border border-red-800 bg-red-950/40 p-4 text-sm text-red-300"
      >
        {channel}
      </div>
    );
  }

  return (
    <div className="rounded bg-white" style={{ width, height }}>
      <canvas
        data-testid="helicorder-canvas"
        ref={canvasRef}
        width={width}
        height={height}
        className="block"
      />
    </div>
  );
}
