/**
 * Vista de onda de UNA ventana, con zoom por arrastre.
 *
 * Reparto de responsabilidades, deliberado:
 *   - `waveform-scale.ts` tiene la geometría (instante ↔ píxel, zoom, arrastre)
 *   - `use-wave-window.ts` decide qué ventana se mira y pide el dato
 *   - este componente dibuja y traduce gestos del mouse a llamadas del hook
 *
 * Por eso acá no hay ni una división por duración ni un `fetch`: si aparece
 * alguna de las dos, se está duplicando algo que ya está testeado sin DOM.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { type TimeWindow, dragSelection } from '@/lib/waveform-scale';
import type { WaveformResponse, WaveStatus } from '@/hooks/use-wave-window';
import type { HelicorderFilter } from '@/lib/helicorder-settings';

interface WaveViewProps {
  window: TimeWindow | null;
  data: WaveformResponse | null;
  status: WaveStatus;
  canGoBack: boolean;
  /** Un arrastre válido pide esta ventana nueva. */
  onSelectWindow: (w: TimeWindow) => void;
  onGoBack: () => void;
  onReset: () => void;
  /**
   * El filtro cambia el DATO (lo aplica el backend), a diferencia de los
   * multiplicadores del helicorder que sólo repintan lo que ya está en memoria.
   */
  filter: HelicorderFilter;
  onFilterChange: (f: HelicorderFilter) => void;
  width?: number;
  height?: number;
  /**
   * Capa opcional dibujada SOBRE el canvas (picking, Fase 5). Se monta dentro
   * del contenedor relativo para que comparta la geometría exacta del trazo;
   * sin la prop, el componente se comporta exactamente como antes.
   */
  overlay?: React.ReactNode;
}

// Exportados para que una capa superpuesta (PickingOverlay) use la MISMA
// geometría: dos mapeos instante↔píxel distintos darían un pick corrido.
export const WAVE_MARGIN_LEFT = 56;
export const WAVE_MARGIN_RIGHT = 16;
export const WAVE_MARGIN_TOP = 8;
export const WAVE_MARGIN_BOTTOM = 24;

const MARGIN_LEFT = WAVE_MARGIN_LEFT;
const MARGIN_RIGHT = WAVE_MARGIN_RIGHT;
const MARGIN_TOP = WAVE_MARGIN_TOP;
const MARGIN_BOTTOM = WAVE_MARGIN_BOTTOM;

const TRACE_COLOR = '#1f4e79';
const SELECTION_FILL = 'rgba(31, 78, 121, 0.18)';
const SELECTION_STROKE = '#1f4e79';

/** Etiqueta de eje: hora UTC, que es la referencia del dato sismológico. */
function axisLabel(msEpoch: number): string {
  return `${new Date(msEpoch).toISOString().slice(11, 19)}Z`;
}

export function WaveView({
  window: waveWindow,
  data,
  status,
  canGoBack,
  onSelectWindow,
  onGoBack,
  onReset,
  filter,
  onFilterChange,
  width = 960,
  height = 280,
  overlay,
}: WaveViewProps) {
  const t = useTranslations('station');
  const canvasRef = useRef<HTMLCanvasElement>(null);

  /**
   * El arrastre en curso. Vive en estado y no en un ref porque el rectángulo
   * de selección se dibuja en cada `mousemove`: sin re-render no se ve nada.
   */
  const [drag, setDrag] = useState<{ x1: number; x2: number } | null>(null);

  const plotWidth = width - MARGIN_LEFT - MARGIN_RIGHT;
  const plotHeight = height - MARGIN_TOP - MARGIN_BOTTOM;

  /**
   * La ventana MOSTRADA sale del DATO recibido, no de la pedida. Si el fetch
   * de una ventana nueva falla, el canvas conserva la onda anterior — y
   * rotularla con la ventana que falló sería mentir (visto en prod: onda
   * vieja con etiquetas de la ventana nueva). Mismo principio del helicorder:
   * el eje sale de lo RECIBIDO. El arrastre también mapea sobre esto, para
   * que el zoom seleccione lo que el usuario VE, no lo que se pidió.
   */
  const displayedWindow = useMemo<TimeWindow | null>(() => {
    const startMs = data ? Date.parse(data.starttime) : Number.NaN;
    const endMs = data ? Date.parse(data.endtime) : Number.NaN;
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      return { startMs, endMs };
    }
    return waveWindow;
  }, [data, waveWindow]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    if (!data || !waveWindow) return;

    const centerY = MARGIN_TOP + plotHeight / 2;

    // Escala vertical del máximo absoluto de la ventana. Acá SÍ es correcto
    // escalar por la ventana visible (a diferencia del helicorder, que escala
    // por el día entero): el usuario pidió mirar este tramo, y aplanarlo
    // contra el pico de otro momento sería mostrarle una línea recta.
    let peak = 0;
    for (let i = 0; i < data.mins.length; i++) {
      peak = Math.max(peak, Math.abs(data.mins[i]), Math.abs(data.maxs[i]));
    }
    // Piso positivo: con `peak = 0` (canal mudo) la escala sería Infinity y no
    // se dibujaría nada, en silencio.
    const scale = (plotHeight / 2 - 1) / (peak > 0 ? peak : 1);

    // Eje horizontal
    ctx.strokeStyle = '#cccccc';
    ctx.beginPath();
    ctx.moveTo(MARGIN_LEFT, centerY);
    ctx.lineTo(MARGIN_LEFT + plotWidth, centerY);
    ctx.stroke();

    // Trazo min/max: una columna por par, igual que el helicorder. Un pico de
    // una muestra tiene que sobrevivir a la decimación del backend.
    ctx.strokeStyle = TRACE_COLOR;
    const pairs = data.mins.length;
    for (let i = 0; i < pairs; i++) {
      const x = MARGIN_LEFT + (i / Math.max(1, pairs - 1)) * plotWidth;
      ctx.beginPath();
      ctx.moveTo(x, centerY - data.maxs[i] * scale);
      ctx.lineTo(x, centerY - data.mins[i] * scale);
      ctx.stroke();
    }

    // Etiquetas de tiempo en los extremos de la ventana
    ctx.fillStyle = '#333333';
    ctx.font = '10px monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const labelWindow = displayedWindow ?? waveWindow;
    ctx.fillText(axisLabel(labelWindow.startMs), MARGIN_LEFT, height - MARGIN_BOTTOM + 6);
    ctx.textAlign = 'right';
    ctx.fillText(
      axisLabel(labelWindow.endMs),
      MARGIN_LEFT + plotWidth,
      height - MARGIN_BOTTOM + 6,
    );

    // Rectángulo de selección mientras se arrastra. Es sólo pintura: el fetch
    // sale en el `mouseup`, no acá.
    if (drag) {
      const lo = Math.min(drag.x1, drag.x2);
      const hi = Math.max(drag.x1, drag.x2);
      ctx.fillStyle = SELECTION_FILL;
      ctx.fillRect(lo, MARGIN_TOP, hi - lo, plotHeight);
      ctx.strokeStyle = SELECTION_STROKE;
      ctx.strokeRect(lo, MARGIN_TOP, hi - lo, plotHeight);
    }
  }, [data, waveWindow, displayedWindow, drag, width, height, plotWidth, plotHeight]);

  /** Coordenada del evento en el sistema del canvas (puede estar escalado por CSS). */
  const canvasX = (event: React.MouseEvent<HTMLCanvasElement>): number | null => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return null;
    return ((event.clientX - rect.left) * width) / rect.width;
  };

  const handleMouseDown = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!waveWindow) return;
    const x = canvasX(event);
    if (x === null) return;
    setDrag({ x1: x, x2: x });
  };

  const handleMouseMove = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const x = canvasX(event);
    if (x === null) return;
    setDrag({ x1: drag.x1, x2: x });
  };

  const finishDrag = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!drag || !waveWindow) {
      setDrag(null);
      return;
    }
    const x = canvasX(event);
    setDrag(null);
    if (x === null) return;

    // La traducción a ventana es de la lib pura: normaliza el arrastre
    // invertido y devuelve `null` si fue un clic. Acá no se decide nada.
    // Mapea sobre la ventana MOSTRADA: seleccionar sobre una onda vieja con
    // la geometría de la ventana que falló daría un zoom corrido.
    const selected = dragSelection(
      drag.x1 - MARGIN_LEFT,
      x - MARGIN_LEFT,
      plotWidth,
      displayedWindow ?? waveWindow,
    );
    if (selected) onSelectWindow(selected);
  };

  return (
    <div data-testid="wave-view">
      <div className="mb-3 flex flex-wrap items-center gap-4 text-sm text-foreground">
        <button
          type="button"
          onClick={onGoBack}
          disabled={!canGoBack}
          className="rounded bg-muted px-2 py-0.5 text-foreground hover:bg-muted/80 disabled:opacity-50"
        >
          {t('waveBack')}
        </button>
        <button
          type="button"
          onClick={onReset}
          className="rounded bg-muted px-2 py-0.5 text-foreground hover:bg-muted/80"
        >
          {t('waveReset')}
        </button>

        {/* Igual que en el helicorder: esto vuelve a pedir la onda al backend,
            porque el filtro cambia el dato y no cómo se dibuja. */}
        <label className="flex items-center gap-2">
          <span title={t('filterHint')}>{t('filter')}</span>
          <input
            type="checkbox"
            aria-label={t('filter')}
            checked={filter === 'bp'}
            onChange={(e) => onFilterChange(e.target.checked ? 'bp' : 'none')}
          />
        </label>

        <span className="text-xs text-muted-foreground">{t('waveZoomHint')}</span>
      </div>

      {status === 'error' && (
        <div
          data-testid="wave-error"
          className="mb-3 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
        >
          {t('waveError')}
        </div>
      )}

      <div className="relative rounded bg-white" style={{ width, height }}>
        <canvas
          data-testid="wave-canvas"
          ref={canvasRef}
          width={width}
          height={height}
          className="block cursor-crosshair"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={finishDrag}
          // Soltar fuera del canvas cancela: sin esto el arrastre queda pegado
          // y el próximo movimiento pinta una selección fantasma.
          onMouseLeave={() => setDrag(null)}
        />
        {overlay}
        {status === 'loading' && (
          <div
            data-testid="wave-loading"
            className="absolute inset-0 flex items-center justify-center bg-white/60 text-sm text-slate-700"
          >
            {t('waveLoading')}
          </div>
        )}
      </div>
    </div>
  );
}
