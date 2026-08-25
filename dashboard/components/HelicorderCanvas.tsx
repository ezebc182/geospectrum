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

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  HELICORDER_CLIP_COLOR,
  autoClipValue,
  majorTickMinutes,
  rowBias,
  rowColor,
  rowCount,
  rowsForWindow,
  splitClippedSegment,
} from '@/lib/helicorder-layout';
import {
  HELICORDER_DEFAULTS,
  effectiveClip,
  type HelicorderFilter,
} from '@/lib/helicorder-settings';
import {
  DEFAULT_WINDOW_SECONDS,
  helicorderHitToWindow,
  type TimeWindow,
} from '@/lib/helicorder-hit';

interface HelicorderCanvasProps {
  /** SCNL completo, ej. "IU.MAJO..BHZ". */
  channel: string;
  timeChunkMinutes: number;
  width: number;
  height: number;
  /** Multiplicador del clip automático (SWARM: clip manual). Default 1. */
  clipMult?: number;
  /** Exageración de amplitud al dibujar (SWARM `barMult`). Default 1. */
  barMult?: number;
  /** Filtro que aplica el backend. 'bp' = Butterworth 1-10 Hz. Default 'none'. */
  filter?: HelicorderFilter;
  /**
   * Se llama al hacer clic sobre la señal, con la ventana centrada en el
   * instante señalado. Opcional a propósito: sin esta prop el helicorder se
   * comporta exactamente como antes (sin cursor de mano ni handler).
   */
  onSelectWindow?: (window: TimeWindow) => void;
  /** Ancho de la ventana que abre un clic. Default 120 s. */
  selectionWindowSeconds?: number;
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
/**
 * Tope de `points` del endpoint (`le=50000` en /stations/{channel}/waveform).
 * Con franjas de 15 min serían 96 × 800 = 76.800 y FastAPI rechaza con 422
 * antes de llegar al handler. Clampear no cuesta resolución: 50.000 repartidos
 * en 96 filas siguen siendo ~520 pares contra ~848 px de ancho útil.
 */
const MAX_POINTS = 50000;

export function HelicorderCanvas({
  channel,
  timeChunkMinutes,
  width,
  height,
  clipMult = HELICORDER_DEFAULTS.clipMult,
  barMult = HELICORDER_DEFAULTS.barMult,
  filter = HELICORDER_DEFAULTS.filter,
  onSelectWindow,
  selectionWindowSeconds = DEFAULT_WINDOW_SECONDS,
}: HelicorderCanvasProps) {
  const t = useTranslations('station');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 'noData' y 'failed' son errores DISTINTOS para el operador: el 404 del
  // backend significa "FDSN no tiene señal de este canal" (pasa seguido con
  // estaciones dadas de baja) y no se arregla reintentando.
  const [status, setStatus] = useState<'loading' | 'ready' | 'noData' | 'failed'>('loading');
  // La onda se guarda en estado para que mover los sliders repinte SIN volver
  // a pedir 24 h al backend: clipMult y barMult no cambian el dato, sólo cómo
  // se dibuja.
  const [waveform, setWaveform] = useState<WaveformResponse | null>(null);

  // Efecto 1: traer el dato. Depende sólo de lo que cambia el dato.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const points = Math.min(
          MAX_POINTS,
          rowCount(TOTAL_MINUTES, timeChunkMinutes) * PAIRS_PER_ROW,
        );
        // El SCNL va escapado: lleva puntos y algunas estaciones, espacios.
        const res = await fetch(
          `${API_BASE}/stations/${encodeURIComponent(channel)}/waveform` +
            `?minutes=${TOTAL_MINUTES}&points=${points}&filter=${filter}`,
        );
        if (!res.ok) {
          if (!cancelled) setStatus(res.status === 404 ? 'noData' : 'failed');
          return;
        }
        const wf: WaveformResponse = await res.json();
        if (cancelled) return;
        setWaveform(wf);
        setStatus('ready');
      } catch {
        if (!cancelled) setStatus('failed');
      }
    };

    setStatus('loading');
    setWaveform(null);
    load();
    return () => {
      cancelled = true;
    };
    // `filter` va acá y NO junto a clipMult/barMult: esos dos sólo cambian el
    // dibujo y repintan con lo que ya está en memoria, mientras que filtrar
    // cambia la onda misma y exige pedirla de nuevo.
  }, [channel, timeChunkMinutes, filter]);

  // Efecto 2: dibujar. Depende del dato Y de todo lo que afecta el dibujo.
  useEffect(() => {
    const wf = waveform;
    if (!wf) return;

    const draw = () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;

      // Fondo blanco, como el helicorder de SWARM
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);

      // Las filas salen de la ventana RECIBIDA, no de las 24 h pedidas: FDSN
      // suele no tener las últimas horas y repartir ese dato sobre 96 filas
      // desplaza el eje de tiempo. Fallback a 24 h si los timestamps no
      // parsean, para no quedarnos sin dibujar nada.
      const rows =
        rowsForWindow(
          Date.parse(wf.starttime),
          Date.parse(wf.endtime),
          timeChunkMinutes,
        ) || rowCount(TOTAL_MINUTES, timeChunkMinutes);
      const rowH = height / rows;
      const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
      const pairsPerRow = Math.max(1, Math.floor(wf.mins.length / rows));

      // El clip se calcula sobre el día ENTERO, no por fila: si cada fila
      // tuviera su propia escala, una hora tranquila se vería tan agitada
      // como uno con un sismo y el gráfico mentiría.
      //
      // El percentil es sólo el punto de partida — un sismo real vive en esa
      // cola y salía clampado en rojo. `clipMult` es la palabra del operador.
      const clipValue = effectiveClip(autoClipValue(wf.mins, wf.maxs), clipMult);
      const startMs = Date.parse(wf.starttime);
      const tickEvery = majorTickMinutes(timeChunkMinutes);
      // `barMult` exagera lo dibujado SIN mover el umbral de saturación: por
      // eso multiplica la escala y no el clip. Subir el clip deja de saturar,
      // subir barMult agranda lo que ya entra — son controles distintos.
      const scale = ((rowH / 2 - 1) / clipValue) * barMult;

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
          // El trazo se parte en cuerpo (azul) y puntas desbordadas (rojo).
          // Teñir la columna entera hacía que la parte fuerte de un sismo
          // saliera como bloque rojo sólido y tapara la forma de onda.
          for (const seg of splitClippedSegment(
            wf.mins[from + i] - bias,
            wf.maxs[from + i] - bias,
            clipValue,
          )) {
            ctx.strokeStyle = seg.clipped ? HELICORDER_CLIP_COLOR : base;
            ctx.beginPath();
            ctx.moveTo(x, centerY - seg.hi * scale);
            ctx.lineTo(x, centerY - seg.lo * scale);
            ctx.stroke();
          }
        }
      }
    };

    draw();
    // clipMult/barMult van en las deps a propósito: son lo que el operador
    // mueve, y sin ellas el slider no repintaría nunca.
  }, [waveform, timeChunkMinutes, width, height, clipMult, barMult]);

  if (status === 'noData' || status === 'failed') {
    return (
      <div
        data-testid="helicorder-error"
        role="alert"
        className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        <span className="font-mono">{channel}</span>
        {' — '}
        {t(status === 'noData' ? 'helicorderNoData' : 'helicorderError')}
      </div>
    );
  }

  /**
   * Traduce el clic a una ventana y la delega. El cálculo vive en la lib pura
   * `helicorder-hit`: acá sólo se resuelven las coordenadas relativas al canvas.
   */
  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onSelectWindow || !waveform) return;

    // `clientX/Y` son de página: hay que restarles la posición del canvas. Y el
    // canvas puede estar escalado por CSS, así que las coordenadas se llevan al
    // sistema de `width`/`height` con el que se dibujó.
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    const selected = helicorderHitToWindow({
      x: ((event.clientX - rect.left) * width) / rect.width,
      y: ((event.clientY - rect.top) * height) / rect.height,
      width,
      height,
      marginLeft: MARGIN_LEFT,
      marginRight: MARGIN_RIGHT,
      // Mismo cálculo que el dibujo: si acá se usaran 96 filas y el canvas
      // dibujó 75, el clic señalaría una fila distinta de la que el usuario ve.
      rows:
        rowsForWindow(
          Date.parse(waveform.starttime),
          Date.parse(waveform.endtime),
          timeChunkMinutes,
        ) || rowCount(TOTAL_MINUTES, timeChunkMinutes),
      timeChunkMinutes,
      startMs: Date.parse(waveform.starttime),
      windowSeconds: selectionWindowSeconds,
    });

    if (selected) onSelectWindow(selected);
  };

  return (
    <div className="relative rounded bg-white" style={{ width, height }}>
      <canvas
        data-testid="helicorder-canvas"
        ref={canvasRef}
        width={width}
        height={height}
        className={onSelectWindow ? 'block cursor-pointer' : 'block'}
        onClick={onSelectWindow ? handleClick : undefined}
      />
      {status === 'loading' && (
        <div
          data-testid="helicorder-loading"
          role="status"
          className="absolute inset-0 flex items-center justify-center gap-3 bg-white/60 text-sm text-slate-700"
        >
          <span
            aria-hidden
            className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
          />
          {t('helicorderLoading')}
        </div>
      )}
    </div>
  );
}
