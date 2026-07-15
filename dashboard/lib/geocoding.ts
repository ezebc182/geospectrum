/**
 * Geocoding de texto -> lat/lon usando Nominatim (OpenStreetMap), gratuito y sin API key.
 * Uso respetuoso del servicio público: solo se llama con debounce desde el UI,
 * nunca en loop ni por polling.
 */

export interface GeocodingResult {
  displayName: string;
  lat: number;
  lon: number;
}

export async function searchPlace(query: string, signal?: AbortSignal): Promise<GeocodingResult[]> {
  if (!query.trim()) return [];

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '5');

  const response = await fetch(url.toString(), {
    signal,
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Geocoding error: ${response.status}`);
  }

  const data: Array<{ display_name: string; lat: string; lon: string }> = await response.json();

  return data.map(item => ({
    displayName: item.display_name,
    lat: parseFloat(item.lat),
    lon: parseFloat(item.lon),
  }));
}
