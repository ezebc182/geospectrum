/**
 * Hook de polling batch de métricas. `enabled` apaga el polling cuando la
 * vista no las muestra (tab de tarjetas cerrada, showMetrics off) — cero
 * requests de fondo.
 */

'use client';

import useSWR from 'swr';

import { fetchStationMetrics, type StationMetrics } from './station-metrics';

export const METRICS_REFRESH_MS = 15_000;

export function useStationMetrics(
  channels: string[],
  enabled: boolean,
): Record<string, StationMetrics> {
  const key =
    enabled && channels.length > 0 ? ['station-metrics', ...channels] : null;
  const { data } = useSWR(key, () => fetchStationMetrics(channels), {
    refreshInterval: METRICS_REFRESH_MS,
    revalidateOnFocus: false,
    dedupingInterval: 5_000,
  });
  return data ?? {};
}
