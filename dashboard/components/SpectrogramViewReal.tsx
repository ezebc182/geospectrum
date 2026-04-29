/**
 * Componente de visualización de espectrograma sísmico CON DATOS REALES
 * Conecta con backend FDSN para obtener espectrogramas de estaciones sísmicas reales
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import type { SeismicCity } from '@/lib/seismic-cities';
import { Activity, AlertCircle, RefreshCw } from 'lucide-react';
import { seismicAPI } from '@/lib/api';

interface SpectrogramViewRealProps {
  city: SeismicCity;
  height?: number;
  showLabel?: boolean;
  useRealData?: boolean; // Toggle entre datos simulados y reales
}

export function SpectrogramViewReal({
  city,
  height = 120,
  showLabel = true,
  useRealData = true
}: SpectrogramViewRealProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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

      if (result.success && result.image) {
        setSpectrogramImage(result.image);
        setMetadata(result.metadata);
        setError(null);
      } else {
        setError(result.error || 'No se pudo generar el espectrograma');
        setSpectrogramImage(null);
      }
    } catch (err) {
      console.error(`Error fetching spectrogram for ${city.name}:`, err);
      setError('Error al conectar con el servidor');
      setSpectrogramImage(null);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSpectrogram();

    // Recargar cada 5 minutos
    const interval = setInterval(() => {
      fetchSpectrogram();
    }, 5 * 60 * 1000);

    return () => clearInterval(interval);
  }, [city.id, useRealData]);

  const handleRetry = () => {
    setRetryCount(prev => prev + 1);
    fetchSpectrogram();
  };

  return (
    <div className="relative bg-black rounded border-2 border-gray-700 overflow-hidden" style={{ height: `${height}px` }}>
      {showLabel && (
        <div className="absolute top-1 left-2 z-10 flex items-center gap-2 bg-black/80 px-2 py-1 rounded text-xs">
          <Activity className="h-3 w-3 text-green-400" />
          <span className="text-white font-semibold">{city.name}</span>
          <span className="text-gray-400">{city.country}</span>
          {metadata && (
            <span className="text-xs text-blue-400 ml-1">
              [{metadata.network}.{metadata.station}]
            </span>
          )}
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
          <div className="flex flex-col items-center gap-2">
            <Activity className="h-8 w-8 animate-spin text-blue-400" />
            <span className="text-gray-400 text-xs">Obteniendo datos FDSN...</span>
          </div>
        </div>
      )}

      {error && !isLoading && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 z-20 p-4">
          <AlertCircle className="h-8 w-8 text-red-400 mb-2" />
          <p className="text-red-400 text-xs text-center mb-3">{error}</p>
          <button
            onClick={handleRetry}
            className="flex items-center gap-1 px-3 py-1 bg-blue-600 text-white rounded text-xs hover:bg-blue-700 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            Reintentar
          </button>
          <p className="text-gray-500 text-[10px] mt-2">
            Intentos: {retryCount}
          </p>
        </div>
      )}

      {spectrogramImage && !isLoading && !error && (
        <img
          src={`data:image/png;base64,${spectrogramImage}`}
          alt={`Espectrograma de ${city.name}`}
          className="w-full h-full object-cover"
        />
      )}

      {!useRealData && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-r from-blue-900 to-purple-900">
          <div className="text-center p-4">
            <Activity className="h-12 w-12 text-white/50 mx-auto mb-2" />
            <p className="text-white/70 text-sm">Modo simulado</p>
            <p className="text-white/50 text-xs">Activa datos reales</p>
          </div>
        </div>
      )}

      {/* Metadata overlay */}
      {metadata && spectrogramImage && (
        <div className="absolute bottom-1 left-2 z-10 bg-black/60 px-2 py-1 rounded text-[9px] text-gray-300">
          <div>Estación: {metadata.network}.{metadata.station}</div>
          <div>Actualizado: {new Date(metadata.generated_at).toLocaleTimeString()}</div>
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
        <span>Ahora</span>
      </div>
    </div>
  );
}
