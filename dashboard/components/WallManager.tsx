'use client';

/**
 * Gestión de muros guardados (spec §2): lista + armador + preview en vivo.
 * El outcome de guardado se guarda como CLAVE i18n (patrón del repo), no
 * como texto resuelto. El muro "Global" no es editable: solo se duplica.
 */

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { seismicAPI } from '@/lib/api';
import { ApiStatusError } from '@/lib/auth';
import { HIGH_RISK_SEISMIC_CITIES } from '@/lib/seismic-cities';
import type { WallChannel, WallLayout } from '@/lib/types';
import { createEmptyLayout } from '@/lib/wall-editor';
import { createWall, deleteWall, listWalls, updateWall } from '@/lib/walls';
import { SpectronetWall } from './SpectronetWall';
import { WallBuilder } from './WallBuilder';

const CITY_NAME_BY_ID = new Map(HIGH_RISK_SEISMIC_CITIES.map((c) => [c.id, c.name]));

type SaveOutcome = 'saved' | 'nameTaken' | 'invalidLayout' | 'saveError' | null;

/** Copia pendiente de aplicar en el próximo pase del efecto de selección
 * (spec §2 duplicar): evitar un setTimeout(0), frágil en jsdom, para pisar
 * el reset de "nuevo" con el contenido copiado. */
interface PendingDuplicate {
  name: string;
  layout: WallLayout;
}

export function WallManager() {
  const t = useTranslations('charts.spectrogramsPage.wall');
  const { data: walls, mutate } = useSWR('walls-list', () => listWalls(), {
    revalidateOnFocus: false,
  });
  const { data: globalWall } = useSWR('walls-global', () => seismicAPI.getGlobalWall(), {
    revalidateOnFocus: false,
  });
  const { data: liveChannels } = useSWR('walls-catalog', () => seismicAPI.getLiveChannels(), {
    revalidateOnFocus: false,
  });

  const [selectedId, setSelectedId] = useState<'new' | string>('new');
  const [name, setName] = useState('');
  const [layout, setLayout] = useState<WallLayout>(createEmptyLayout);
  const [saving, setSaving] = useState(false);
  const [outcome, setOutcome] = useState<SaveOutcome>(null);
  const [pendingDuplicate, setPendingDuplicate] = useState<PendingDuplicate | null>(null);

  const noSession = walls === null;

  const catalog: WallChannel[] = useMemo(
    () =>
      (liveChannels ?? []).map((c) => ({
        channel: c.channel,
        label: CITY_NAME_BY_ID.get(c.city_id) ?? c.city_id,
      })),
    [liveChannels]
  );

  // Cargar el muro elegido en el editor (o resetear en "nuevo"). Ojo: NO
  // depende de `pendingDuplicate` — si dependiera, consumirlo (setearlo a
  // null) dispararía el efecto de nuevo con selectedId aún en 'new' y
  // pisaría el nombre recién cargado con el reset vacío. En su lugar, este
  // efecto solo resetea cuando el cambio de selección NO trae una copia
  // pendiente (ver el efecto siguiente, que aplica la copia una única vez).
  useEffect(() => {
    if (selectedId === 'new') {
      setName((prev) => (pendingDuplicate ? prev : ''));
      setLayout((prev) => (pendingDuplicate ? prev : createEmptyLayout()));
      return;
    }
    const wall = walls?.find((w) => w.id === selectedId);
    if (wall) {
      setName(wall.name);
      setLayout(wall.layout);
    }
    // Deliberadamente sin `pendingDuplicate` en deps (ver comentario arriba).
  }, [selectedId, walls]);

  // Aplica la copia pendiente (si hay) UNA vez que selectedId ya está en
  // 'new' y el efecto de arriba corrió (o no hizo nada por haber copia
  // pendiente). Se consume acá, en un efecto separado, para no competir con
  // el reset del efecto anterior.
  useEffect(() => {
    if (selectedId !== 'new' || !pendingDuplicate) return;
    setName(pendingDuplicate.name);
    setLayout(pendingDuplicate.layout);
    setPendingDuplicate(null);
  }, [selectedId, pendingDuplicate]);

  const handleSave = async () => {
    setSaving(true);
    setOutcome(null);
    try {
      const payload = { name: name.trim(), layout };
      const saved = selectedId === 'new' ? await createWall(payload) : await updateWall(selectedId, payload);
      if (saved) setSelectedId(saved.id);
      setOutcome('saved');
      await mutate();
    } catch (error) {
      if (error instanceof ApiStatusError && error.status === 409) setOutcome('nameTaken');
      else if (error instanceof ApiStatusError && error.status === 422) setOutcome('invalidLayout');
      else setOutcome('saveError');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (selectedId === 'new') return;
    try {
      await deleteWall(selectedId);
      setSelectedId('new');
      await mutate();
    } catch {
      // Mismo criterio que handleSave: se reusa la clave genérica de error
      // de guardado (no hay una dedicada a "no se pudo borrar") y NO se
      // resetea la selección ni se revalida la lista — el muro sigue
      // existiendo del lado del servidor, así que seguir mostrándolo
      // seleccionado es lo correcto.
      setOutcome('saveError');
    }
  };

  const handleDuplicate = () => {
    // Duplica el muro seleccionado; con "nuevo" seleccionado duplica el Global
    // (spec §2: "duplicar un muro existente (incluido duplicar el default)")
    const source = selectedId === 'new' ? globalWall : walls?.find((w) => w.id === selectedId);
    if (!source) return;
    setPendingDuplicate({ name: `${source.name} (copia)`, layout: source.layout });
    setSelectedId('new');
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{t('wallsTitle')}</span>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={() => setSelectedId('new')}>
          {t('newWall')}
        </button>
        <button type="button" className="rounded border border-border px-2 py-1 text-xs" onClick={handleDuplicate}>
          {t('duplicate')}
        </button>
        {(walls ?? []).map((wall) => (
          <button
            key={wall.id}
            type="button"
            className={`rounded border px-2 py-1 text-xs ${selectedId === wall.id ? 'border-teal-500' : 'border-border'}`}
            onClick={() => setSelectedId(wall.id)}
          >
            {wall.name}
          </button>
        ))}
      </div>

      {noSession && <p className="text-sm text-amber-500">{t('needSession')}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <input
          className="w-56 rounded border border-border bg-background px-2 py-1 text-sm"
          aria-label={t('name')}
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="button"
          className="rounded bg-teal-600 px-3 py-1 text-sm text-white disabled:opacity-40"
          disabled={noSession || saving || !name.trim()}
          onClick={handleSave}
        >
          {saving ? t('saving') : t('save')}
        </button>
        {selectedId !== 'new' && (
          <button type="button" className="rounded border border-destructive px-2 py-1 text-xs text-destructive" onClick={handleDelete}>
            {t('delete')}
          </button>
        )}
        {outcome === 'saved' && <span className="text-xs text-teal-500">{t('saved')}</span>}
        {outcome && outcome !== 'saved' && <span className="text-xs text-destructive">{t(outcome)}</span>}
      </div>

      <WallBuilder layout={layout} onChange={setLayout} catalog={catalog} />

      <div>
        <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{t('preview')}</div>
        <div className="rounded-md border border-border bg-black">
          <SpectronetWall wall={{ id: 'preview', name: name || t('namePlaceholder'), layout }} stripWidth={240} stripHeight={28} />
        </div>
      </div>
    </div>
  );
}
