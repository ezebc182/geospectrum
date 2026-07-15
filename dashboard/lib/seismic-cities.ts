/**
 * Top 30 ciudades con mayor riesgo sísmico a nivel mundial
 * Basado en ubicación en zonas de alta actividad sísmica y densidad poblacional
 */

export interface SeismicCity {
  id: string;
  name: string;
  country: string;
  lat: number;
  lon: number;
  population: number;
  riskLevel: 'extreme' | 'high' | 'moderate';
  nearestStation?: string; // Código de estación sísmica cercana
  network?: string; // Red sísmica (IRIS, USGS, etc)
}

export const HIGH_RISK_SEISMIC_CITIES: SeismicCity[] = [
  // Anillo de Fuego del Pacífico - Asia Oriental
  {
    id: 'tokyo',
    name: 'Tokyo',
    country: 'Japan',
    lat: 35.6762,
    lon: 139.6503,
    population: 37400000,
    riskLevel: 'extreme',
    network: 'JP'
  },
  {
    id: 'osaka',
    name: 'Osaka',
    country: 'Japan',
    lat: 34.6937,
    lon: 135.5023,
    population: 19281000,
    riskLevel: 'extreme',
    network: 'JP'
  },
  {
    id: 'manila',
    name: 'Manila',
    country: 'Philippines',
    lat: 14.5995,
    lon: 120.9842,
    population: 13923000,
    riskLevel: 'extreme',
    network: 'PH'
  },
  {
    id: 'jakarta',
    name: 'Jakarta',
    country: 'Indonesia',
    lat: -6.2088,
    lon: 106.8456,
    population: 10770000,
    riskLevel: 'extreme',
    network: 'IA'
  },
  {
    id: 'taipei',
    name: 'Taipei',
    country: 'Taiwan',
    lat: 25.0330,
    lon: 121.5654,
    population: 7871000,
    riskLevel: 'extreme',
    network: 'TW'
  },

  // América del Sur - Zona de Subducción Nazca
  {
    id: 'lima',
    name: 'Lima',
    country: 'Peru',
    lat: -12.0464,
    lon: -77.0428,
    population: 10719000,
    riskLevel: 'extreme',
    network: 'PE'
  },
  {
    id: 'santiago',
    name: 'Santiago',
    country: 'Chile',
    lat: -33.4489,
    lon: -70.6693,
    population: 6767000,
    riskLevel: 'extreme',
    network: 'CL'
  },
  {
    id: 'quito',
    name: 'Quito',
    country: 'Ecuador',
    lat: -0.1807,
    lon: -78.4678,
    population: 2781000,
    riskLevel: 'high',
    network: 'EC'
  },
  {
    id: 'bogota',
    name: 'Bogotá',
    country: 'Colombia',
    lat: 4.7110,
    lon: -74.0721,
    population: 10978000,
    riskLevel: 'high',
    network: 'CO'
  },

  // Norte América - Fallas Activas
  {
    id: 'losangeles',
    name: 'Los Angeles',
    country: 'USA',
    lat: 34.0522,
    lon: -118.2437,
    population: 12458000,
    riskLevel: 'extreme',
    network: 'CI'
  },
  {
    id: 'sanfrancisco',
    name: 'San Francisco',
    country: 'USA',
    lat: 37.7749,
    lon: -122.4194,
    population: 4749000,
    riskLevel: 'extreme',
    network: 'NC'
  },
  {
    id: 'seattle',
    name: 'Seattle',
    country: 'USA',
    lat: 47.6062,
    lon: -122.3321,
    population: 3979000,
    riskLevel: 'high',
    network: 'UW'
  },
  {
    id: 'mexicocity',
    name: 'Mexico City',
    country: 'Mexico',
    lat: 19.4326,
    lon: -99.1332,
    population: 21782000,
    riskLevel: 'extreme',
    network: 'MX'
  },
  {
    id: 'vancouver',
    name: 'Vancouver',
    country: 'Canada',
    lat: 49.2827,
    lon: -123.1207,
    population: 2632000,
    riskLevel: 'high',
    network: 'CN'
  },

  // Asia Central y Medio Oriente
  {
    id: 'tehran',
    name: 'Tehran',
    country: 'Iran',
    lat: 35.6892,
    lon: 51.3890,
    population: 9135000,
    riskLevel: 'extreme',
    network: 'IR'
  },
  {
    id: 'istanbul',
    name: 'Istanbul',
    country: 'Turkey',
    lat: 41.0082,
    lon: 28.9784,
    population: 15462000,
    riskLevel: 'extreme',
    network: 'TU'
  },
  {
    id: 'kathmandu',
    name: 'Kathmandu',
    country: 'Nepal',
    lat: 27.7172,
    lon: 85.3240,
    population: 1442000,
    riskLevel: 'extreme',
    network: 'NP'
  },

  // Oceanía
  {
    id: 'wellington',
    name: 'Wellington',
    country: 'New Zealand',
    lat: -41.2865,
    lon: 174.7762,
    population: 415000,
    riskLevel: 'high',
    network: 'NZ'
  },
  {
    id: 'christchurch',
    name: 'Christchurch',
    country: 'New Zealand',
    lat: -43.5321,
    lon: 172.6362,
    population: 380000,
    riskLevel: 'high',
    network: 'NZ'
  },

  // Otras ciudades de alto riesgo
  {
    id: 'valparaiso',
    name: 'Valparaíso',
    country: 'Chile',
    lat: -33.0472,
    lon: -71.6127,
    population: 935000,
    riskLevel: 'extreme',
    network: 'CL'
  },
  {
    id: 'anchorage',
    name: 'Anchorage',
    country: 'USA',
    lat: 61.2181,
    lon: -149.9003,
    population: 291000,
    riskLevel: 'high',
    network: 'AK'
  },
  {
    id: 'antofagasta',
    name: 'Antofagasta',
    country: 'Chile',
    lat: -23.6509,
    lon: -70.3975,
    population: 425000,
    riskLevel: 'extreme',
    network: 'CL'
  },
  {
    id: 'guam',
    name: 'Guam',
    country: 'USA',
    lat: 13.4443,
    lon: 144.7937,
    population: 168000,
    riskLevel: 'high',
    network: 'IU'
  },
  {
    id: 'portauprince',
    name: 'Port-au-Prince',
    country: 'Haiti',
    lat: 18.5944,
    lon: -72.3074,
    population: 2637000,
    riskLevel: 'extreme',
    network: 'HT'
  },
  {
    id: 'sandiego',
    name: 'San Diego',
    country: 'USA',
    lat: 32.7157,
    lon: -117.1611,
    population: 3338000,
    riskLevel: 'high',
    network: 'CI'
  },
  {
    id: 'portland',
    name: 'Portland',
    country: 'USA',
    lat: 45.5152,
    lon: -122.6784,
    population: 2478000,
    riskLevel: 'high',
    network: 'UW'
  },
  {
    id: 'arequipa',
    name: 'Arequipa',
    country: 'Peru',
    lat: -16.4090,
    lon: -71.5375,
    population: 1080000,
    riskLevel: 'extreme',
    network: 'PE'
  },
  {
    id: 'managua',
    name: 'Managua',
    country: 'Nicaragua',
    lat: 12.1364,
    lon: -86.2514,
    population: 1063000,
    riskLevel: 'high',
    network: 'NU'
  },
  {
    id: 'sanjose',
    name: 'San José',
    country: 'Costa Rica',
    lat: 9.9281,
    lon: -84.0907,
    population: 1401000,
    riskLevel: 'high',
    network: 'CR'
  },
  {
    id: 'auckland',
    name: 'Auckland',
    country: 'New Zealand',
    lat: -36.8485,
    lon: 174.7633,
    population: 1657000,
    riskLevel: 'moderate',
    network: 'NZ'
  },
];

/**
 * Obtener ciudad por ID
 */
export function getCityById(id: string): SeismicCity | undefined {
  return HIGH_RISK_SEISMIC_CITIES.find(city => city.id === id);
}

/**
 * Obtener ciudades por nivel de riesgo
 */
export function getCitiesByRisk(riskLevel: SeismicCity['riskLevel']): SeismicCity[] {
  return HIGH_RISK_SEISMIC_CITIES.filter(city => city.riskLevel === riskLevel);
}

/**
 * Obtener ciudades por país
 */
export function getCitiesByCountry(country: string): SeismicCity[] {
  return HIGH_RISK_SEISMIC_CITIES.filter(city => city.country === country);
}

/**
 * Crea una ubicación custom (no está en HIGH_RISK_SEISMIC_CITIES) a partir de
 * lat/lon libres. El backend busca la estación FDSN más cercana en vivo
 * (ver SpectrogramService._try_real_spectrogram) en vez de depender de una
 * estación preconfigurada por ciudad.
 */
export function createCustomLocation(params: {
  name: string;
  country?: string;
  lat: number;
  lon: number;
}): SeismicCity {
  const slug = params.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

  return {
    id: `custom-${slug}-${params.lat.toFixed(2)}-${params.lon.toFixed(2)}`,
    name: params.name,
    country: params.country || 'Ubicación custom',
    lat: params.lat,
    lon: params.lon,
    population: 0,
    riskLevel: 'moderate',
  };
}

/**
 * Color según nivel de riesgo
 */
export function getRiskColor(riskLevel: SeismicCity['riskLevel']): string {
  switch (riskLevel) {
    case 'extreme':
      return '#ef4444'; // red-500
    case 'high':
      return '#f97316'; // orange-500
    case 'moderate':
      return '#eab308'; // yellow-500
    default:
      return '#6b7280'; // gray-500
  }
}
