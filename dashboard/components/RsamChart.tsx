/**
 * Serie RSAM de la ventana seleccionada — paridad SWARM, ON-DEMAND.
 *
 * El componente NO calcula RSAM: la serie llega del backend, que usa la MISMA
 * fórmula (`rsam_sample`) que alimenta el número instantáneo del muro. Lo
 * único que decide acá es el PERÍODO: el de SWARM (600 s) sobre la ventana de
 * 2 min que abre el clic del helicorder daría una serie VACÍA, así que se
 * adapta a ~60 puntos por ventana (clampeado al `ge=1, le=3600` del endpoint).
 */

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { seismicAPI, type RsamResponse } from '@/lib/api';
import type { TimeWindow } from '@/lib/waveform-scale';

interface RsamChartProps {
  channel: string;
  window: TimeWindow;
  width?: number;
  height?: number;
}

const MARGIN_LEFT = 56; // mismo margen que helicorder/wave/espectro: alinean
const MARGIN_RIGHT = 8;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 8;
const TARGET_POINTS = 60;

/** ~60 puntos por ventana, dentro del rango que acepta el endpoint. */
export function adaptivePeriodSeconds(win: TimeWindow): number {
  const spanSeconds = (win.endMs - win.startMs) / 1000;
  return Math.min(3600, Math.max(1, Math.round(spanSeconds / TARGET_POINTS)));
}

export function RsamChart({
  channel,
  window: win,
  width = 960,
  height = 240,
}: RsamChartProps) {
  const t = useTranslations('station');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [series, setSeries] = useState<RsamResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setSeries(null);
    seismicAPI
      .getStationRsam(channel, win, adaptivePeriodSeconds(win))
      .then((resp) => {
        if (cancelled) return;
        setSeries(resp);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // Deps por VALOR: la página puede recrear el objeto ventana en cada render.
  }, [channel, win.startMs, win.endMs]);

  useEffect(() => {
    const sp = series;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!sp || !canvas || !ctx || sp.samples.length === 0) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
    const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
    const values = sp.samples.map((s) => s.value);
    const vMax = Math.max(...values);
    const vSpan = Math.max(1e-9, vMax); // RSAM es >= 0: el piso del eje es 0

    const xOf = (i: number) =>
      MARGIN_LEFT + (sp.samples.length === 1 ? 0.5 : i / (sp.samples.length - 1)) * plotW;
    const yOf = (v: number) => MARGIN_TOP + (1 - v / vSpan) * plotH;

    // Etiquetas del rango sobre el margen izquierdo (0 abajo, máximo arriba).
    ctx.fillStyle = '#333333';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.round(vMax)), MARGIN_LEFT - 6, MARGIN_TOP + 6);
    ctx.fillText('0', MARGIN_LEFT - 6, MARGIN_TOP + plotH - 6);

    ctx.strokeStyle = '#0f766e';
    ctx.beginPath();
    sp.samples.forEach((s, i) => {
      const x = xOf(i);
      const y = yOf(s.value);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Puntos fechados: cada muestra es una medición, no una interpolación.
    ctx.fillStyle = '#0f766e';
    sp.samples.forEach((s, i) => {
      ctx.beginPath();
      ctx.arc(xOf(i), yOf(s.value), 2, 0, 2 * Math.PI);
      ctx.fill();
    });
  }, [series, width, height]);

  if (status === 'error') {
    return (
      <div
        data-testid="rsam-error"
        role="alert"
        className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        {t('rsamError')}
      </div>
    );
  }

  if (status === 'ready' && series && series.samples.length === 0) {
    return (
      <div
        data-testid="rsam-empty"
        className="rounded border border-border p-4 text-sm text-muted-foreground"
      >
        {t('rsamEmpty')}
      </div>
    );
  }

  return (
    <div data-testid="rsam-chart">
      {series && (
        <div
          data-testid="rsam-info"
          className="mb-1 flex items-center justify-between font-mono text-xs text-muted-foreground"
        >
          <span>{t('rsamAxis')}</span>
          <span>
            {t('rsamInfo', {
              points: series.samples.length,
              seconds: series.period_seconds,
            })}
          </span>
        </div>
      )}

      <div className="relative rounded bg-white" style={{ width, height }}>
        <canvas
          data-testid="rsam-canvas"
          ref={canvasRef}
          width={width}
          height={height}
          className="block"
        />
        {status === 'loading' && (
          <div
            data-testid="rsam-loading"
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-3 bg-white/60 text-sm text-slate-700"
          >
            <span
              aria-hidden
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
            />
            {t('rsamLoading')}
          </div>
        )}
      </div>

      {series && series.samples.length > 0 && (
        <div
          className="flex justify-between font-mono text-xs text-muted-foreground"
          style={{ paddingLeft: MARGIN_LEFT, width }}
        >
          <span>{series.samples[0].t}</span>
          <span>{series.samples[series.samples.length - 1].t}</span>
        </div>
      )}
    </div>
  );
}
