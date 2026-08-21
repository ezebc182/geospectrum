'use client';

import type { WallResponse } from '@/lib/types';
import { SpectronetStrip } from './SpectronetStrip';

interface SpectronetWallProps {
  wall: WallResponse;
  stripWidth: number;
  stripHeight: number;
}

/** Muro estilo SPECTRONET: columnas verticales, grupos por región, tiras sin gap. */
export function SpectronetWall({ wall, stripWidth, stripHeight }: SpectronetWallProps) {
  return (
    <div className="flex h-full justify-center gap-3 overflow-hidden p-3">
      {wall.layout.columns.map((column, ci) => (
        <div key={ci} className="flex flex-col gap-2 overflow-hidden">
          {column.groups.map((group) => (
            <div key={group.title}>
              <div className="border-b border-gray-700 bg-black px-1 py-0.5 text-[10px] font-bold uppercase tracking-widest text-white">
                {group.title}
              </div>
              <div data-testid={`wall-group-${group.title}`} className="flex flex-col gap-0">
                {group.channels.map((ch) => (
                  <SpectronetStrip
                    key={ch.channel}
                    channel={ch.channel}
                    label={ch.label}
                    width={stripWidth}
                    height={stripHeight}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
