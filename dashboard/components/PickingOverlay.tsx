/**
 * Picking de fases P/S/coda sobre el wave view (Fase 5).
 *
 * Dos piezas y un reparto estricto:
 *   - `PickingOverlay`: la capa que se monta DENTRO del contenedor del canvas
 *     (prop `overlay` de WaveView). Dibuja las líneas de fase y captura el
 *     clic cuando hay una fase armada. Usa la MISMA `timeToX`/`xToTime` de
 *     `waveform-scale.ts` que el zoom: dos mapeos distintos darían un pick
 *     corrido.
 *   - `PickingPanel`: botones de armado (UI de UN SOLO NIVEL: marcar P,
 *     marcar S, marcar coda — nada de los menús fase→onset→polaridad→peso de
 *     SWARM), atajos de teclado, nota, lista de picks y mediciones.
 *
 * Ninguna de las dos persiste (eso es del hook) ni calcula fórmulas (eso es
 * de `signal-picks.ts`).
 */

'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  WAVE_MARGIN_BOTTOM,
  WAVE_MARGIN_LEFT,
  WAVE_MARGIN_RIGHT,
  WAVE_MARGIN_TOP,
} from '@/components/WaveView';
import type { PickMeasurements, PickPhase, SignalPick } from '@/lib/signal-picks';
import { type TimeWindow, timeToX, xToTime } from '@/lib/waveform-scale';
import type { PicksStatus } from '@/hooks/use-signal-picks';

/** Colores por fase, fijos: la P se lee igual en cualquier estación. */
const PHASE_COLORS: Record<PickPhase, string> = {
  P: '#0d9488',
  S: '#d97706',
  coda: '#7c3aed',
};

const PHASES: PickPhase[] = ['P', 'S', 'coda'];

interface PickingOverlayProps {
  window: TimeWindow;
  picks: SignalPick[];
  /** Fase lista para marcar; null = la capa no captura nada (el zoom sigue vivo). */
  armedPhase: PickPhase | null;
  onPickAt: (pickTimeMs: number) => void;
  width: number;
  height: number;
}

export function PickingOverlay({
  window: waveWindow,
  picks,
  armedPhase,
  onPickAt,
  width,
  height,
}: PickingOverlayProps) {
  const plotWidth = width - WAVE_MARGIN_LEFT - WAVE_MARGIN_RIGHT;
  const plotHeight = height - WAVE_MARGIN_TOP - WAVE_MARGIN_BOTTOM;

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!armedPhase) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width === 0) return;
    // Misma conversión CSS→canvas que WaveView: el canvas puede estar escalado.
    const x = ((event.clientX - rect.left) * width) / rect.width;
    const tMs = xToTime(x - WAVE_MARGIN_LEFT, waveWindow, plotWidth);
    // Un clic en el margen no señala ningún instante (mismo criterio que el
    // helicorder): se recorta a la ventana en vez de extrapolar.
    const clamped = Math.min(waveWindow.endMs, Math.max(waveWindow.startMs, tMs));
    onPickAt(Math.round(clamped));
  };

  return (
    <div
      data-testid="picking-overlay"
      className="absolute inset-0"
      style={{
        // Sin fase armada la capa es transparente a los gestos: el arrastre de
        // zoom del canvas sigue funcionando exactamente igual.
        pointerEvents: armedPhase ? 'auto' : 'none',
        cursor: armedPhase ? 'crosshair' : undefined,
      }}
      onClick={handleClick}
    >
      {picks
        .map((pick) => ({ pick, ms: new Date(pick.pickTime).getTime() }))
        .filter(({ ms }) => ms >= waveWindow.startMs && ms <= waveWindow.endMs)
        .map(({ pick, ms }) => {
          const x = WAVE_MARGIN_LEFT + timeToX(ms, waveWindow, plotWidth);
          return (
            <div
              key={pick.id}
              data-testid={`pick-line-${pick.phase}`}
              title={pick.note ?? undefined}
              className="absolute"
              style={{
                left: x - 1,
                top: WAVE_MARGIN_TOP,
                width: 2,
                height: plotHeight,
                backgroundColor: PHASE_COLORS[pick.phase],
              }}
            >
              <span
                className="absolute -top-0.5 left-1 font-mono text-[10px] font-bold"
                style={{ color: PHASE_COLORS[pick.phase] }}
              >
                {pick.phase === 'coda' ? 'C' : pick.phase}
              </span>
            </div>
          );
        })}
    </div>
  );
}

interface PickingPanelProps {
  picks: SignalPick[];
  measurements: PickMeasurements;
  status: PicksStatus;
  armedPhase: PickPhase | null;
  onArmPhase: (phase: PickPhase | null) => void;
  onRemovePick: (pickId: string) => void;
  note: string;
  onNoteChange: (note: string) => void;
  /** Detrás de visibleTools(progress).export; sin picks no hay nada que bajar. */
  exportVisible: boolean;
  onExport: () => void;
}

/** Hora del pick para la lista, en UTC explícito. */
function pickLabel(isoTime: string): string {
  const ms = new Date(isoTime).getTime();
  if (!Number.isFinite(ms)) return isoTime;
  return `${new Date(ms).toISOString().slice(11, 23)}Z`;
}

export function PickingPanel({
  picks,
  measurements,
  status,
  armedPhase,
  onArmPhase,
  onRemovePick,
  note,
  onNoteChange,
  exportVisible,
  onExport,
}: PickingPanelProps) {
  const t = useTranslations('station');

  // Atajos de un solo nivel: p/s/c arman, Escape desarma. Se ignoran cuando el
  // foco está en un campo de texto (escribir una nota con la letra "s" no debe
  // armar la fase S).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'p') onArmPhase('P');
      else if (key === 's') onArmPhase('S');
      else if (key === 'c') onArmPhase('coda');
      else if (key === 'escape') onArmPhase(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onArmPhase]);

  const { spSeconds, distanceKm, codaSeconds, codaMagnitude } = measurements;
  // S antes que P: hay dato pero no medición. Se dice explícitamente — nunca
  // un NaN ni una distancia negativa en pantalla.
  const invalidOrder = spSeconds !== null && spSeconds <= 0;

  return (
    <div data-testid="picking-panel" className="mt-4 rounded border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-foreground">
        <span className="font-medium">{t('pickingTitle')}</span>
        {PHASES.map((phase) => (
          <button
            key={phase}
            type="button"
            aria-pressed={armedPhase === phase}
            onClick={() => onArmPhase(armedPhase === phase ? null : phase)}
            className={`rounded px-2 py-0.5 ${
              armedPhase === phase
                ? 'bg-teal-700 text-white'
                : 'bg-muted text-foreground hover:bg-muted/80'
            }`}
          >
            {t(`pickPhase.${phase}`)}
          </button>
        ))}
        <span className="text-xs text-muted-foreground">
          {armedPhase ? t('pickingArmedHint') : t('pickingShortcutsHint')}
        </span>
      </div>

      <label className="mb-3 flex items-center gap-2 text-sm text-foreground">
        <span>{t('pickingNoteLabel')}</span>
        <input
          type="text"
          maxLength={280}
          value={note}
          onChange={(event) => onNoteChange(event.target.value)}
          placeholder={t('pickingNotePlaceholder')}
          aria-label={t('pickingNoteLabel')}
          className="w-64 rounded border border-border bg-background px-2 py-0.5 text-sm"
        />
      </label>

      {status === 'error' && (
        <div data-testid="picking-error" className="mb-2 text-sm text-red-600 dark:text-red-400">
          {t('pickingError')}
        </div>
      )}

      {picks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('pickingEmpty')}</p>
      ) : (
        <ul className="mb-2 space-y-1 text-sm text-foreground">
          {picks.map((pick) => (
            <li key={pick.id} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ backgroundColor: PHASE_COLORS[pick.phase] }}
              />
              <span className="font-mono text-xs">
                {t(`pickPhase.${pick.phase}`)} · {pickLabel(pick.pickTime)}
              </span>
              {pick.note && <span className="text-xs text-muted-foreground">{pick.note}</span>}
              <button
                type="button"
                onClick={() => onRemovePick(pick.id)}
                aria-label={t('pickingRemove', { phase: pick.phase })}
                className="rounded bg-muted px-1.5 text-xs text-foreground hover:bg-muted/80"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div data-testid="picking-measurements" className="text-sm text-foreground">
        {invalidOrder && (
          <p data-testid="picking-invalid-order" className="text-amber-600 dark:text-amber-400">
            {t('pickingInvalidOrder')}
          </p>
        )}
        {!invalidOrder && spSeconds !== null && distanceKm !== null && (
          <p data-testid="picking-distance">
            {t('pickingDistance', {
              sp: spSeconds.toFixed(1),
              km: distanceKm.toFixed(1),
            })}
          </p>
        )}
        {codaSeconds !== null && codaMagnitude !== null && (
          <p data-testid="picking-magnitude">
            {t('pickingMagnitude', {
              seconds: codaSeconds.toFixed(1),
              mc: codaMagnitude.toFixed(2),
            })}
          </p>
        )}
      </div>

      {exportVisible && picks.length > 0 && (
        <button
          type="button"
          onClick={onExport}
          className="mt-2 rounded bg-muted px-3 py-1 text-sm text-foreground hover:bg-muted/80"
        >
          {t('pickingExport')}
        </button>
      )}
    </div>
  );
}
