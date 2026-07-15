'use client';

import { useEffect, useRef, useState } from 'react';

interface LiveSpectrogramCanvasProps {
  channel: string; // ej. "IU.MAJO.00.BHZ"
  label: string;
  height?: number;
  width?: number;
}

interface SpecColumn {
  channel: string;
  endtime: string;
  freqs: number[];
  power_db: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Minutos de historial a pedir al montar, antes de conectar el WebSocket en
// vivo. Cubre el caso más común (usuario recarga la página) sin pedir horas
// de datos que tardarían en pintar.
const HISTORY_MINUTES = 5;

// El piso de ruido en dB varía mucho por estación (ver min/max reales medidos:
// IU.MAJO iba de -34.8 a 56.4, UW.LON de -16.3 a 38.4). Umbrales fijos dejaban
// casi todo en el mismo color oscuro. Se normaliza por columna, igual criterio
// que matplotlib en el modo estático (percentiles 5-95), con un colormap
// continuo tipo viridis en vez de 4 bloques planos.
const VIRIDIS_STOPS: [number, string][] = [
  [0.0, '#440154'],
  [0.25, '#3b528b'],
  [0.5, '#21918c'],
  [0.75, '#5ec962'],
  [1.0, '#fde725'],
];

function viridis(t: number): string {
  const clamped = Math.max(0, Math.min(1, t));
  for (let i = 0; i < VIRIDIS_STOPS.length - 1; i++) {
    const [t0, c0] = VIRIDIS_STOPS[i];
    const [t1, c1] = VIRIDIS_STOPS[i + 1];
    if (clamped >= t0 && clamped <= t1) {
      const localT = (clamped - t0) / (t1 - t0);
      return lerpColor(c0, c1, localT);
    }
  }
  return VIRIDIS_STOPS[VIRIDIS_STOPS.length - 1][1];
}

function lerpColor(hexA: string, hexB: string, t: number): string {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `rgb(${r},${g},${bl})`;
}

function percentile(sorted: number[], p: number): number {
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Espectrograma en vivo real: consume columnas nuevas por WebSocket
 * (backend -> Redis -> src/services/seedlink_ingestor.py) y las pinta
 * corriendo la imagen existente 1px a la izquierda, igual que un
 * sismógrafo de papel — sin recargar ninguna imagen completa.
 */
export function LiveSpectrogramCanvas({ channel, label, height = 120, width = 400 }: LiveSpectrogramCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, width, height);

    let ws: WebSocket;
    let closedByUs = false;
    let cancelled = false;

    const drawColumn = (col: SpecColumn) => {
      // Corre todo el contenido 1px a la izquierda (efecto "cinta que avanza")
      const img = ctx.getImageData(1, 0, width - 1, height);
      ctx.putImageData(img, 0, 0);

      // Normaliza por percentiles de ESTA columna (igual criterio que
      // matplotlib en el modo estático) — el piso de ruido varía mucho por
      // estación, así que un umbral fijo en dB deja todo del mismo color.
      const sorted = [...col.power_db].sort((a, b) => a - b);
      const vmin = percentile(sorted, 0.05);
      const vmax = percentile(sorted, 0.95);
      const range = vmax - vmin || 1;

      // Pinta la columna nueva en el borde derecho: cada bin de frecuencia
      // ocupa una franja vertical proporcional, grave abajo / agudo arriba.
      const n = col.power_db.length;
      for (let i = 0; i < n; i++) {
        const y = height - Math.round(((i + 1) / n) * height);
        const rowHeight = Math.max(1, Math.ceil(height / n));
        const t = (col.power_db[i] - vmin) / range;
        ctx.fillStyle = viridis(t);
        ctx.fillRect(width - 1, y, 1, rowHeight);
      }
    };

    const connect = () => {
      ws = new WebSocket(`${WS_BASE}/ws/spectrogram/${channel}`);

      ws.onopen = () => setStatus('connecting'); // pasa a 'live' con el primer dato
      ws.onmessage = (event) => {
        try {
          const col: SpecColumn = JSON.parse(event.data);
          drawColumn(col);
          setStatus('live');
          setLastUpdate(col.endtime);
        } catch {
          // columna malformada: se ignora, no corta la conexión
        }
      };
      ws.onerror = () => setStatus('error');
      ws.onclose = () => {
        if (!closedByUs) {
          setStatus('error');
          setTimeout(connect, 3000); // reconexión con backoff simple
        }
      };
    };

    const loadHistoryThenConnect = async () => {
      try {
        const res = await fetch(`${API_BASE}/spectrograms/${channel}/history?minutes=${HISTORY_MINUTES}`);
        const data: { columns: SpecColumn[] } = await res.json();
        if (cancelled) return;
        for (const col of data.columns) {
          drawColumn(col);
          setLastUpdate(col.endtime);
        }
      } catch {
        // sin historial disponible (TimescaleDB no configurado o caído):
        // el canvas arranca en negro y se llena en vivo, igual que antes.
      }
      if (!cancelled) connect();
    };

    loadHistoryThenConnect();

    return () => {
      cancelled = true;
      closedByUs = true;
      ws?.close();
    };
  }, [channel, width, height]);

  return (
    <div className="relative bg-black rounded border-2 border-gray-700 overflow-hidden" style={{ width, height }}>
      <canvas ref={canvasRef} width={width} height={height} className="block" />

      <div className="absolute top-1 left-2 z-10 flex items-center gap-2 bg-black/80 px-2 py-1 rounded text-xs">
        <span
          className={`h-2 w-2 rounded-full ${
            status === 'live' ? 'bg-green-400 animate-pulse' : status === 'error' ? 'bg-red-500' : 'bg-yellow-400'
          }`}
        />
        <span className="text-white font-semibold">{label}</span>
        <span className="text-gray-400">[{channel}]</span>
      </div>

      {lastUpdate && (
        <div className="absolute bottom-1 left-2 z-10 bg-black/60 px-2 py-1 rounded text-[9px] text-gray-300">
          {new Date(lastUpdate).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}
