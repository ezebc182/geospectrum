/**
 * Componente de visualización de espectrograma sísmico CON DATOS REALES
 * Conecta con backend FDSN para obtener espectrogramas de estaciones sísmicas reales
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import type { SeismicCity } from '@/lib/seismic-cities';
import { Activity, AlertCircle, RefreshCw } from 'lucide-react';
import { seismicAPI } from '@/lib/api';

interface SpectrogramViewRealProps {
  city: SeismicCity;
  height?: number;
  showLabel?: boolean;
  useRealData?: boolean; // Toggle entre datos simulados y reales
}

/**
 * Código del error, no el texto resuelto: el mensaje visible se traduce en el
 * render, así el cambio de idioma en caliente re-traduce un error ya mostrado.
 */
type SpectrogramError = 'noNearbyStation' | 'connectionError';

export function SpectrogramViewReal({
  city,
  height = 120,
  showLabel = true,
  useRealData = true
}: SpectrogramViewRealProps) {
  const t = useTranslations('charts.spectrogram');
  const format = useFormatter();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<SpectrogramError | null>(null);
  const [spectrogramImage, setSpectrogramImage] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<any>(null);
  const [retryCount, setRetryCount] = useState(0);

  const fetchSpectrogram = async () => {
    if (!useRealData) {
      // Fallback a datos simulados
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const result = await seismicAPI.getSpectrogram(
        city.id,
        city.lat,
        city.lon,
        city.network,
        24 // 24 horas de datos
      );

      if (result.success && result.image && result.metadata?.network !== 'SYNTHETIC') {
        setSpectrogramImage(result.image);
        setMetadata(result.metadata);
        setError(null);
      } else {
        // El backend cayó a datos sintéticos (sin estación FDSN real cercana).
        // No mostramos ruido simulado como si fuera señal real: se marca como error.
        setError('noNearbyStation');
        setSpectrogramImage(null);
        setMetadata(null);
      }
    } catch (err) {
      console.error(`Error fetching spectrogram for ${city.name}:`, err);
      setError('connectionError');
      setSpectrogramImage(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSpectrogram();

    // El backend cachea cada espectrograma real por ~45s (spectrogram_cache_ttl_seconds),
    // así que refrescar cada 30s trae imagen nueva sin recalcular FFT en cada ciclo.
    const interval = setInterval(() => {
      fetchSpectrogram();
    }, 30 * 1000);

    return () => clearInterval(interval);
  }, [city.id, useRealData]);

  const handleRetry = () => {
    setRetryCount(prev => prev + 1);
    fetchSpectrogram();
  };

  return (
    <div className="relative bg-black rounded border-2 border-gray-700 overflow-hidden" style={{ height: `${height}px` }}>
      {showLabel && (
        <div className="absolute top-1 left-2 right-2 z-10 flex items-center gap-2 bg-black/80 px-2 py-1 rounded text-xs overflow-hidden">
          <Activity className="h-3 w-3 text-green-400 shrink-0" />
          <span className="text-white font-semibold shrink-0">{city.name}</span>
          <span className="text-gray-400 truncate">{city.country}</span>
          {metadata && metadata.network !== 'SYNTHETIC' && (
            <span className="text-xs text-blue-400 ml-1 shrink-0">
              [{metadata.network}.{metadata.station}]
            </span>
          )}
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
          <div className="flex flex-col items-center gap-2">
            <Activity className="h-8 w-8 animate-spin text-blue-400" />
            <span className="text-gray-400 text-xs">{t('fetchingData')}</span>
          </div>
        </div>
      )}

      {error && !isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 z-20 p-4">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-red-400 text-xs text-center mb-3">{t(error)}</p>
          <button
            onClick={handleRetry}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            {t('retry')}
          </button>
          <p className="text-gray-500 text-[10px] mt-2">
            {t('attempts', { count: retryCount })}
          </p>
        </div>
      )}

      {spectrogramImage && !isLoading && !error && (
        <img
          src={`data:image/png;base64,${spectrogramImage}`}
          alt={t('imageAlt', { city: city.name })}
          className="w-full h-full object-cover"
        />
      )}

      {!useRealData && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-r from-blue-900 to-purple-900">
          <div className="text-center p-4">
            <Activity className="h-12 w-12 text-white/50 mx-auto mb-2" />
            <p className="text-white/70 text-sm">{t('simulatedMode')}</p>
            <p className="text-white/50 text-xs">{t('enableRealData')}</p>
          </div>
        </div>
      )}

      {/* Metadata overlay */}
      {metadata && spectrogramImage && (
        <div className="absolute bottom-1 left-2 z-10 bg-black/60 px-2 py-1 rounded text-[9px] text-gray-300">
          <div>
            {metadata.network === 'SYNTHETIC'
              ? t('simulatedData')
              : t('station', { station: `${metadata.network}.${metadata.station}` })}
          </div>
          <div>
            {t('updated', {
              time: format.dateTime(new Date(metadata.generated_at), 'time'),
            })}
          </div>
        </div>
      )}

      {/* Ejes de referencia */}
      <div className="absolute right-0 top-0 bottom-0 w-10 flex flex-col justify-between text-[9px] text-gray-400 py-1 pointer-events-none">
        <span className="px-1">20Hz</span>
        <span className="px-1">10Hz</span>
        <span className="px-1">5Hz</span>
        <span className="px-1">1Hz</span>
        <span className="px-1">0.1Hz</span>
      </div>

      <div className="absolute bottom-0 left-0 right-12 h-4 flex justify-between items-center text-[9px] text-gray-400 px-2 bg-gradient-to-t from-black/80 to-transparent pointer-events-none">
        <span>-24h</span>
        <span>-18h</span>
        <span>-12h</span>
        <span>-6h</span>
        <span>{t('axisNow')}</span>
      </div>
    </div>
  );
}
