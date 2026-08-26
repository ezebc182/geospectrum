/**
 * Picks de señal de UNA ventana: lista, alta, baja y mediciones derivadas.
 *
 * El overlay dibuja y captura gestos; este hook habla con la API y mantiene
 * la lista. Las mediciones de pantalla se calculan ACÁ con la copia TS de las
 * fórmulas (feedback inmediato); el CSV las trae del backend (el artefacto).
 *
 * Mismas tres invariantes de use-wave-window.ts — no son estilo, cada una
 * corresponde a un bug que este repo ya tuvo más de una vez.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { seismicAPI, type PickApiRecord } from '@/lib/api';
import {
  computeMeasurements,
  type PickMeasurements,
  type PickPhase,
  type SignalPick,
} from '@/lib/signal-picks';
import type { TimeWindow } from '@/lib/waveform-scale';

export type PicksStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface UseSignalPicksResult {
  picks: SignalPick[];
  measurements: PickMeasurements;
  status: PicksStatus;
  /** Marca una fase en un instante absoluto. La nota es opcional (≤280). */
  addPick(phase: PickPhase, pickTimeMs: number, note?: string | null): Promise<void>;
  removePick(pickId: string): Promise<void>;
}

function toSignalPick(record: PickApiRecord): SignalPick {
  return {
    id: record.id,
    channel: record.channel,
    phase: record.phase,
    pickTime: record.pick_time,
    note: record.note,
  };
}

export function useSignalPicks(
  channel: string,
  window: TimeWindow | null,
): UseSignalPicksResult {
  // INVARIANTE 1 — arranca vacío y se siembra por efecto: la ventana llega
  // de un fetch del helicorder, un useState(derivado) quedaría clavado.
  const [picks, setPicks] = useState<SignalPick[]>([]);
  const [status, setStatus] = useState<PicksStatus>('idle');

  // INVARIANTE 3 — el AbortController vive en un ref pero se USA dentro del
  // mismo efecto que lo crea; ningún efecto lee un ref fuera de sus deps.
  const abortRef = useRef<AbortController | null>(null);

  // Deps por NÚMERO, no por objeto: un literal nuevo por render del padre
  // re-dispararía el efecto en bucle (misma regla que use-wave-window).
  const startMs = window?.startMs;
  const endMs = window?.endMs;

  useEffect(() => {
    if (startMs === undefined || endMs === undefined) {
      setPicks([]);
      setStatus('idle');
      return;
    }

    // ① Abortar el request en vuelo antes de iniciar el siguiente.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      try {
        const response = await seismicAPI.getStationPicks(channel, { startMs, endMs });
        // ④ Respuesta tardía de un efecto ya limpiado: se descarta. La guarda
        //    de ventana vieja está implícita: cambiar la ventana re-corre el
        //    efecto y este cleanup marca `cancelled` antes del siguiente load.
        if (cancelled || controller.signal.aborted) return;
        setPicks(response.picks.map(toSignalPick));
        setStatus('ready');
      } catch {
        if (cancelled || controller.signal.aborted) return;
        setStatus('error');
      }
    };

    load();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [channel, startMs, endMs]);

  const addPick = useCallback(
    async (phase: PickPhase, pickTimeMs: number, note?: string | null) => {
      const record = await seismicAPI.createStationPick(channel, {
        phase,
        pickTimeMs,
        note: note ?? null,
      });
      const pick = toSignalPick(record);
      // El doble clic devuelve el MISMO id (POST idempotente): reemplazar por
      // id evita duplicar la línea en pantalla.
      setPicks((current) => [...current.filter((p) => p.id !== pick.id), pick]);
    },
    [channel],
  );

  const removePick = useCallback(
    async (pickId: string) => {
      await seismicAPI.deleteStationPick(channel, pickId);
      setPicks((current) => current.filter((p) => p.id !== pickId));
    },
    [channel],
  );

  const measurements = useMemo(() => computeMeasurements(picks), [picks]);

  return { picks, measurements, status, addPick, removePick };
}
