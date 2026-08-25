/**
 * Espectro 1D (Power vs Hz) de la ventana seleccionada — el panel que SWARM
 * muestra bajo la onda. El componente NO calcula FFT: el espectro llega del
 * backend, que lo computa sobre la señal SIN decimar (los pares min/max del
 * waveform producirían un espectro falso).
 *
 * El eje de frecuencia se dibuja con `max_freq_hz` de la RESPUESTA. Ninguna
 * constante de frecuencia máxima vive en TS: medido en producción el techo
 * varía entre 10, 20 y 25 Hz según el canal, y un eje constante miente por
 * factor 2,5.
 */

'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { seismicAPI, type SpectrumResponse } from '@/lib/api';
import type { TimeWindow } from '@/lib/waveform-scale';

interface SpectrumViewProps {
  channel: string;
  window: TimeWindow;
  filter: 'none' | 'bp';
  width?: number;
  height?: number;
}

const MARGIN_LEFT = 56; // mismo margen que helicorder/wave: las vistas alinean
const MARGIN_RIGHT = 8;
const MARGIN_TOP = 8;
const MARGIN_BOTTOM = 8;

export function SpectrumView({
  channel,
  window: win,
  filter,
  width = 960,
  height = 240,
}: SpectrumViewProps) {
  const t = useTranslations('station');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [spectrum, setSpectrum] = useState<SpectrumResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setSpectrum(null);
    seismicAPI
      .getStationSpectrum(channel, win, filter)
      .then((resp) => {
        if (cancelled) return;
        setSpectrum(resp);
        setStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
    // Deps por VALOR (startMs/endMs), no por identidad del objeto: la página
    // puede recrear la ventana en cada render sin cambiar el instante.
  }, [channel, win.startMs, win.endMs, filter]);

  useEffect(() => {
    const sp = spectrum;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!sp || !canvas || !ctx || sp.freqs.length === 0) return;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const plotW = width - MARGIN_LEFT - MARGIN_RIGHT;
    const plotH = height - MARGIN_TOP - MARGIN_BOTTOM;
    const maxF = sp.max_freq_hz;
    const dbMin = Math.min(...sp.power_db);
    const dbMax = Math.max(...sp.power_db);
    const dbSpan = Math.max(1e-9, dbMax - dbMin);

    const xOf = (f: number) => MARGIN_LEFT + (f / maxF) * plotW;
    const yOf = (db: number) => MARGIN_TOP + (1 - (db - dbMin) / dbSpan) * plotH;

    // Grilla vertical: paso fino para ejes cortos (canal de 10 Hz), grueso
    // para los de 20-25 Hz — misma densidad visual en ambos.
    const tick = maxF <= 12 ? 2 : 5;
    ctx.strokeStyle = '#dddddd';
    ctx.fillStyle = '#333333';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let f = tick; f < maxF; f += tick) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, MARGIN_TOP);
      ctx.lineTo(x, MARGIN_TOP + plotH);
      ctx.stroke();
      ctx.fillText(String(f), x, MARGIN_TOP + 2);
    }

    // Etiquetas del rango de potencia sobre el margen izquierdo.
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.round(dbMax)}`, MARGIN_LEFT - 6, MARGIN_TOP + 6);
    ctx.fillText(`${Math.round(dbMin)}`, MARGIN_LEFT - 6, MARGIN_TOP + plotH - 6);

    ctx.strokeStyle = '#1d4ed8';
    ctx.beginPath();
    sp.freqs.forEach((f, i) => {
      const x = xOf(f);
      const y = yOf(sp.power_db[i]);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }, [spectrum, width, height]);

  if (status === 'error') {
    return (
      <div
        data-testid="spectrum-error"
        role="alert"
        className="rounded border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300"
      >
        {t('spectrumError')}
      </div>
    );
  }

  const peakHz =
    spectrum && spectrum.freqs.length > 0
      ? spectrum.freqs[
          spectrum.power_db.reduce((imax, db, i, arr) => (db > arr[imax] ? i : imax), 0)
        ]
      : null;

  return (
    <div data-testid="spectrum-view">
      <div className="mb-1 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {t('powerAxis')} · {t('freqAxis')}
        </span>
        {peakHz !== null && (
          <span data-testid="spectrum-peak" className="font-mono">
            {t('spectrumPeak', { hz: Math.round(peakHz * 10) / 10 })}
          </span>
        )}
      </div>

      <div className="relative rounded bg-white" style={{ width, height }}>
        <canvas
          data-testid="spectrum-canvas"
          ref={canvasRef}
          width={width}
          height={height}
          className="block"
        />
        {status === 'loading' && (
          <div
            data-testid="spectrum-loading"
            role="status"
            className="absolute inset-0 flex items-center justify-center gap-3 bg-white/60 text-sm text-slate-700"
          >
            <span
              aria-hidden
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-solid border-current border-r-transparent"
            />
            {t('spectrumLoading')}
          </div>
        )}
      </div>

      {/* El eje en DOM y no sólo en el canvas: legible por lectores de
          pantalla y verificable por tests (jsdom no rasteriza). */}
      {spectrum && (
        <div
          className="flex justify-between font-mono text-xs text-muted-foreground"
          style={{ paddingLeft: MARGIN_LEFT, width }}
        >
          <span>0 Hz</span>
          <span>{spectrum.max_freq_hz} Hz</span>
        </div>
      )}
    </div>
  );
}
