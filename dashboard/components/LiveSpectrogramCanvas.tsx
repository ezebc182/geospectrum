'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { jet2 } from '@/lib/jet2-palette';
import {
  historyMinutesForWidth,
  powerDbToT,
  sliceToWidth,
} from '@/lib/spectrogram-scale';
import { freshnessOf } from '@/lib/spectrogram-freshness';

interface LiveSpectrogramCanvasProps {
  channel: string; // ej. "IU.MAJO.00.BHZ"
  label: string;
  height?: number;
  width?: number;
  /** 'strip': tira fina apilable (estilo RaspberryShake) — tag chiquito con
   * el nombre, sin código de canal ni hora, para que el dato sea el
   * protagonista y no el cartel.
   * 'bare': tira desnuda para el muro SPECTRONET — solo el canvas + punto de
   * estado, sin tag; la etiqueta vive en SpectronetStrip. */
  variant?: 'default' | 'strip' | 'bare';
}

interface SpecColumn {
  channel: string;
  endtime: string;
  freqs: number[];
  power_db: number[];
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
const WS_BASE = API_BASE.replace(/^http/, 'ws');

// Cada cuánto se re-evalúa la frescura. 15s sobre un umbral de 300s da un
// margen de error del 5% en el peor caso, sin poner a repintar ~74 tiras del
// muro cada segundo.
const FRESHNESS_TICK_MS = 15_000;

// El historial a pedir al montar (antes de conectar el WebSocket) se
// dimensiona al ancho del canvas — ver historyMinutesForWidth: pedir 60 min
// fijos para una tira de 240px tiraba 3/4 del payload, y con ~74 tiras
// montadas en el muro de la cartelera eso se multiplica.

// Escala FIJA 20-120 dB (paridad SWARM): el backend calcula los dB igual que
// SWARM (swarm_spectra.py), así que los valores absolutos son comparables
// entre estaciones y el rojo queda reservado para energía real — ver
// lib/spectrogram-scale.ts para el porqué de la muerte de la escala adaptativa.

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
  const tCommon = useTranslations('common');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting');
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  // Un canal que enmudece deja de disparar renders: sin este tick, la última
  // columna recibida se quedaría rotulada "en vivo" para siempre — que es
  // justamente el bug que la frescura viene a tapar.
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), FRESHNESS_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const freshness = freshnessOf(lastUpdate, now, status);
  const isStale = freshness === 'stale';

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
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

    const drawColumn = (col: SpecColumn) => {
      // Corre todo el contenido 1px a la izquierda (efecto "cinta que avanza")
      const img = ctx.getImageData(1, 0, width - 1, height);
      ctx.putImageData(img, 0, 0);

      // Pinta la columna nueva en el borde derecho: cada bin de frecuencia
      // ocupa una franja vertical proporcional, grave abajo / agudo arriba.
      const n = col.power_db.length;
      for (let i = 0; i < n; i++) {
        const y = height - Math.round(((i + 1) / n) * height);
        const rowHeight = Math.max(1, Math.ceil(height / n));
        ctx.fillStyle = jet2(powerDbToT(col.power_db[i]));
        ctx.fillRect(width - 1, y, 1, rowHeight);
      }
    };

    const connect = () => {
      if (cancelled) return;
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
          reconnectTimer = setTimeout(connect, 3000); // reconexión con backoff simple
        }
      };
    };

    const loadHistoryThenConnect = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/spectrograms/${channel}/history?minutes=${historyMinutesForWidth(width)}`
        );
        const data: { columns: SpecColumn[] } = await res.json();
        if (cancelled) return;
        // A 1px por columna, las que exceden el ancho saldrían del canvas
        // apenas pintadas.
        const columns = sliceToWidth(data.columns, width);
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
      clearTimeout(reconnectTimer);
      ws?.close();
    };
  }, [channel, width, height]);

  if (variant === 'bare') {
    // Tira desnuda para el muro SPECTRONET: la etiqueta vive FUERA, en
    // SpectronetStrip. El punto de estado se conserva (spec §1: una estación
    // caída se ve negra CON punto rojo, y el muro no salta).
    return (
      <div className="relative overflow-hidden bg-black" style={{ width, height }}>
        {/* Atenuar el canvas viejo es lo que se lee de reojo en un muro de ~74
            tiras: un punto de 6px no alcanza para distinguir una estación
            muerta de una viva. */}
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className={`block ${isStale ? 'opacity-40 grayscale' : ''}`}
        />
        {(isStale || status !== 'live') && (
          <span
            title={isStale ? tCommon('live.staleTooltip') : undefined}
            className={`absolute top-1 right-1 h-1.5 w-1.5 rounded-full ${
              isStale ? 'bg-amber-500' : status === 'error' ? 'bg-red-500' : 'bg-yellow-400'
            }`}
          />
        )}
      </div>
    );
  }

  if (variant === 'strip') {
    // Tira apilable: el dato manda. Solo un tag mínimo con el nombre, como
    // las tiras de los streams de referencia (RaspberryShake).
    return (
      <div className="relative overflow-hidden rounded-sm bg-black" style={{ width, height }}>
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          className={`block ${isStale ? 'opacity-40 grayscale' : ''}`}
        />
        <div
          className="absolute top-0.5 left-0.5 z-10 flex items-center gap-1 rounded-sm bg-black/70 px-1 py-px"
          title={isStale ? tCommon('live.staleTooltip') : undefined}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              isStale
                ? 'bg-amber-500'
                : status === 'live'
                  ? 'bg-green-400'
                  : status === 'error'
                    ? 'bg-red-500'
                    : 'bg-yellow-400'
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
    <div
      className={`relative bg-black rounded border-2 overflow-hidden ${
        isStale ? 'border-amber-500/70' : 'border-gray-700'
      }`}
      style={{ width, height }}
    >
      <canvas
        ref={canvasRef}
        width={width}
        height={height}
        className={`block ${isStale ? 'opacity-40 grayscale' : ''}`}
      />

      <div className="absolute top-1 left-2 z-10 flex items-center gap-2 bg-black/80 px-2 py-1 rounded text-xs">
        <span
          className={`h-2 w-2 rounded-full ${
            isStale
              ? 'bg-amber-500'
              : status === 'live'
                ? 'bg-green-400 animate-pulse'
                : 'bg-yellow-400'
          }`}
        />
        <span className="text-white font-semibold">{label}</span>
        <span className="text-gray-400">[{channel}]</span>
      </div>

      {isStale && (
        /* El cartel va SOBRE el canvas y no en un rincón: el fallo caro no es
           no ver el estado, es leer una hora vieja creyendo que es el ahora. */
        <div
          className="absolute inset-x-0 top-1/2 z-10 -translate-y-1/2 text-center"
          title={tCommon('live.staleTooltip')}
        >
          <span className="rounded bg-amber-500/90 px-2 py-1 text-[10px] font-semibold tracking-wide text-black uppercase">
            {tCommon('live.staleLabel')}
          </span>
        </div>
      )}

      {lastUpdate && (
        /* El rótulo UTC no es decorativo: sin él el operador tiene que
           adivinar la zona, y una hora mal atribuida correlaciona mal con
           el catálogo de eventos (que también viene en UTC). */
        <div
          className={`absolute bottom-1 left-2 z-10 rounded px-2 py-1 text-[9px] ${
            isStale ? 'bg-amber-500/90 font-semibold text-black' : 'bg-black/60 text-gray-300'
          }`}
        >
          {format.dateTime(new Date(lastUpdate), 'time')} {tCommon('utcSuffix')}
        </div>
      )}
    </div>
  );
}
