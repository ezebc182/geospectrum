/**
 * Componente de visualización de espectrograma sísmico
 * Similar a PNSN: muestra frecuencia vs tiempo con intensidad en color
 */

'use client';

import { useEffect, useRef, useState } from 'react';
import type { SeismicCity } from '@/lib/seismic-cities';
import { Activity, AlertCircle } from 'lucide-react';

interface SpectrogramViewProps {
  city: SeismicCity;
  height?: number;
  showLabel?: boolean;
}

/**
 * Genera datos simulados de espectrograma para demo
 * En producción, estos datos vendrían de FDSN Waveform API
 */
function generateSpectrogramData(width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const imageData = ctx.createImageData(width, height);
  const data = imageData.data;

  // Generar espectrograma con ruido sísmico simulado
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;

      // Frecuencia base (background noise)
      let intensity = Math.random() * 30 + 10;

      // Añadir eventos sísmicos aleatorios
      const eventProb = Math.random();
      if (eventProb > 0.98) {
        // Evento sísmico fuerte
        const eventIntensity = Math.random() * 150 + 100;
        const eventWidth = Math.floor(Math.random() * 20) + 10;
        const eventHeight = Math.floor(Math.random() * 40) + 20;

        if (x % eventWidth < eventWidth / 2 && y > height / 3 && y < height * 2 / 3) {
          intensity += eventIntensity;
        }
      }

      // Ruido de baja frecuencia (más común en la parte inferior del espectrograma)
      if (y > height * 0.7) {
        intensity += Math.random() * 40;
      }

      // Convertir intensidad a color (azul -> verde -> amarillo -> rojo)
      const normalized = Math.min(intensity / 255, 1);
      let r, g, b;

      if (normalized < 0.25) {
        // Azul a Cyan
        r = 0;
        g = Math.floor(normalized * 4 * 255);
        b = 255;
      } else if (normalized < 0.5) {
        // Cyan a Verde
        r = 0;
        g = 255;
        b = Math.floor((1 - (normalized - 0.25) * 4) * 255);
      } else if (normalized < 0.75) {
        // Verde a Amarillo
        r = Math.floor((normalized - 0.5) * 4 * 255);
        g = 255;
        b = 0;
      } else {
        // Amarillo a Rojo
        r = 255;
        g = Math.floor((1 - (normalized - 0.75) * 4) * 255);
        b = 0;
      }

      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  return imageData;
}

export function SpectrogramView({ city, height = 120, showLabel = true }: SpectrogramViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const animationFrameRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Configurar dimensiones
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    setIsLoading(true);

    // Simular carga inicial
    setTimeout(() => {
      try {
        // Generar y dibujar espectrograma inicial
        const spectrogramData = generateSpectrogramData(rect.width, height);
        ctx.putImageData(spectrogramData, 0, 0);
        setIsLoading(false);
      } catch (err) {
        setError('Error al generar espectrograma');
        setIsLoading(false);
      }
    }, 500);

    // Actualizar en tiempo real (scroll horizontal)
    let offset = 0;
    const animate = () => {
      if (!canvas || !ctx) return;

      const rect = canvas.getBoundingClientRect();

      // Scroll: mover imagen 1px a la izquierda
      const imageData = ctx.getImageData(1, 0, rect.width - 1, height);
      ctx.putImageData(imageData, 0, 0);

      // Generar nueva columna de datos
      const newColumn = generateSpectrogramData(1, height);
      ctx.putImageData(newColumn, rect.width - 1, 0);

      offset++;

      // Continuar animación
      animationFrameRef.current = requestAnimationFrame(animate);
    };

    // Iniciar actualización en tiempo real después de 2 segundos
    const timeoutId = setTimeout(() => {
      animationFrameRef.current = requestAnimationFrame(animate);
    }, 2000);

    return () => {
      clearTimeout(timeoutId);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [city.id, height]);

  return (
    <div className="relative bg-black rounded border-2 border-gray-700 overflow-hidden">
      {showLabel && (
        <div className="absolute top-1 left-2 z-10 flex items-center gap-2 bg-black/80 px-2 py-1 rounded text-xs">
          <Activity className="h-3 w-3 text-green-400" />
          <span className="text-white font-semibold">{city.name}</span>
          <span className="text-gray-400">{city.country}</span>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
          <div className="flex items-center gap-2 text-gray-400 text-sm">
            <Activity className="h-4 w-4 animate-pulse" />
            <span>Cargando datos...</span>
          </div>
        </div>
      )}

      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/90 z-20">
          <div className="flex items-center gap-2 text-red-400 text-sm">
            <AlertCircle className="h-4 w-4" />
            <span>{error}</span>
          </div>
        </div>
      )}

      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: `${height}px` }}
        className="block"
      />

      {/* Eje de frecuencia (vertical) */}
      <div className="absolute right-0 top-0 bottom-0 w-10 flex flex-col justify-between text-[9px] text-gray-400 py-1 pointer-events-none">
        <span className="px-1">20Hz</span>
        <span className="px-1">10Hz</span>
        <span className="px-1">5Hz</span>
        <span className="px-1">1Hz</span>
        <span className="px-1">0.1Hz</span>
      </div>

      {/* Barra de tiempo (horizontal) */}
      <div className="absolute bottom-0 left-0 right-12 h-4 flex justify-between items-center text-[9px] text-gray-400 px-2 bg-gradient-to-t from-black/80 to-transparent">
        <span>-24h</span>
        <span>-18h</span>
        <span>-12h</span>
        <span>-6h</span>
        <span>Ahora</span>
      </div>
    </div>
  );
}
