'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter } from 'next-intl';
import {
  scaleFromHistory,
  sliceToWidth,
  updateScale,
  type SpectrogramScale,
} from '@/lib/spectrogram-scale';

interface LiveSpectrogramCanvasProps {
  channel: string; // ej. "IU.MAJO.00.BHZ"
  label: string;
  height?: number;
  width?: number;
  /** 'strip': tira fina apilable (estilo RaspberryShake) — tag chiquito con
   * el nombre, sin código de canal ni hora, para que el dato sea el
   * protagonista y no el cartel. */
  variant?: 'default' | 'strip';
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
// vivo. A 1px por columna y una columna cada ~4-8s, llenar un canvas de
// ~400px necesita ~30-55 minutos de datos: con 5 minutos (el valor anterior)
// el canvas quedaba en negro con una tira de ~40px a la derecha y parecía
// que la app arrancaba de cero en cada apertura.
const HISTORY_MINUTES = 60;

// El piso de ruido en dB varía mucho por estación (ver min/max reales medidos:
// IU.MAJO iba de -34.8 a 56.4, UW.LON de -16.3 a 38.4); umbrales fijos dejaban
// casi todo del mismo color. La escala se calcula global sobre el historial y
// deriva lenta (ver lib/spectrogram-scale.ts) — normalizar por columna hacía
// que el ruido de fondo brillara igual que un sismo.
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

/**
 * Espectrograma en vivo real: consume columnas nuevas por WebSocket
 * (backend -> Redis -> src/services/seedlink_ingestor.py) y las pinta
 * corriendo la imagen existente 1px a la izquierda, igual que un
 * sismógrafo de papel — sin recargar ninguna imagen completa.
 */
export function LiveSpectrogramCanvas({
  channel,
  label,
  height = 120,
  width = 400,
  variant = 'default',
}: LiveSpectrogramCanvasProps) {
  // Hora de última actualización en el formato del locale activo (Decision 6):
  // el toLocaleTimeString() sin locale dependía del runtime, no del idioma
  // elegido por el usuario.
  const format = useFormatter();
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
    // Escala compartida entre historial y vivo. Vive en el closure del efecto
    // (no en un ref del componente) para que un cambio de canal la resetee.
    let scale: SpectrogramScale | null = null;

    const drawColumn = (col: SpecColumn) => {
      // Corre todo el contenido 1px a la izquierda (efecto "cinta que avanza")
      const img = ctx.getImageData(1, 0, width - 1, height);
      ctx.putImageData(img, 0, 0);

      // Sin historial (base caída o canal recién estrenado) la primera
      // columna en vivo inicializa la escala; de ahí en más solo deriva.
      scale = scale === null ? scaleFromHistory([col.power_db]) : updateScale(scale, col.power_db);
      if (scale === null) return;
      const range = scale.vmax - scale.vmin || 1;

      // Pinta la columna nueva en el borde derecho: cada bin de frecuencia
      // ocupa una franja vertical proporcional, grave abajo / agudo arriba.
      const n = col.power_db.length;
      for (let i = 0; i < n; i++) {
        const y = height - Math.round(((i + 1) / n) * height);
        const rowHeight = Math.max(1, Math.ceil(height / n));
        const t = (col.power_db[i] - scale.vmin) / range;
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
        // A 1px por columna, las que exceden el ancho saldrían del canvas
        // apenas pintadas. La escala se inicializa con TODO el recorte antes
        // de dibujar: si no, las primeras columnas se pintan contra una
        // escala a medio construir.
        const columns = sliceToWidth(data.columns, width);
        scale = scaleFromHistory(columns.map((c) => c.power_db));
        for (const col of columns) {
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

  if (variant === 'strip') {
    // Tira apilable: el dato manda. Solo un tag mínimo con el nombre, como
    // las tiras de los streams de referencia (RaspberryShake).
    return (
      <div className="relative overflow-hidden rounded-sm bg-black" style={{ width, height }}>
        <canvas ref={canvasRef} width={width} height={height} className="block" />
        <div className="absolute top-0.5 left-0.5 z-10 flex items-center gap-1 rounded-sm bg-black/70 px-1 py-px">
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              status === 'live' ? 'bg-green-400' : status === 'error' ? 'bg-red-500' : 'bg-yellow-400'
            }`}
          />
          <span className="text-[9px] font-semibold uppercase tracking-wide text-white">
            {label}
          </span>
        </div>
      </div>
    );
  }

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
          {format.dateTime(new Date(lastUpdate), 'time')}
        </div>
      )}
    </div>
  );
}
