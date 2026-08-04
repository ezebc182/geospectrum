/**
 * Ciudades de referencia para ubicar los eventos en el mapa.
 *
 * La lista original tenía 30 ciudades y las 30 eran sudamericanas: quedó de
 * cuando el proyecto miraba solo los Andes con un bbox fijo. Con la ingesta
 * global eso se volvía un sesgo visible —Tokio sin nombre y Mendoza con
 * nombre— así que se extendió al resto del mundo.
 *
 * El criterio para agregar NO es "las ciudades más grandes": es "las que
 * sirven para ubicar un sismo". Por eso está Wellington con 400 mil habitantes
 * y no está Kinshasa con 15 millones — una está sobre una falla activa y la
 * otra en medio de un cratón estable donde no pasa nada.
 *
 * Vive aparte del componente de mapa porque también la va a querer el globo, y
 * dos listas de ciudades desincronizadas ya nos costó un bug antes.
 */

export interface MajorCity {
  name: string;
  lat: number;
  lon: number;
  population: number;
  country: string;
}

export const MAJOR_CITIES: MajorCity[] = [
  // ── Sudamérica ────────────────────────────────────────────────────────────
  // Argentina
  { name: 'Buenos Aires', lat: -34.6037, lon: -58.3816, population: 15000000, country: 'Argentina' },
  { name: 'Córdoba', lat: -31.4201, lon: -64.1888, population: 1500000, country: 'Argentina' },
  { name: 'Rosario', lat: -32.9468, lon: -60.6393, population: 1300000, country: 'Argentina' },
  { name: 'Mendoza', lat: -32.8895, lon: -68.8458, population: 1100000, country: 'Argentina' },
  { name: 'San Juan', lat: -31.5375, lon: -68.5364, population: 500000, country: 'Argentina' },
  { name: 'San Miguel de Tucumán', lat: -26.8083, lon: -65.2176, population: 900000, country: 'Argentina' },
  { name: 'Salta', lat: -24.7859, lon: -65.4117, population: 600000, country: 'Argentina' },
  { name: 'Neuquén', lat: -38.9516, lon: -68.0591, population: 340000, country: 'Argentina' },
  { name: 'Bariloche', lat: -41.1335, lon: -71.3103, population: 130000, country: 'Argentina' },

  // Chile
  { name: 'Santiago', lat: -33.4489, lon: -70.6693, population: 6800000, country: 'Chile' },
  { name: 'Valparaíso', lat: -33.0472, lon: -71.6127, population: 950000, country: 'Chile' },
  { name: 'Concepción', lat: -36.8201, lon: -73.0444, population: 1000000, country: 'Chile' },
  { name: 'Antofagasta', lat: -23.6509, lon: -70.3975, population: 400000, country: 'Chile' },
  { name: 'La Serena', lat: -29.9027, lon: -71.2520, population: 250000, country: 'Chile' },
  { name: 'Temuco', lat: -38.7359, lon: -72.5904, population: 290000, country: 'Chile' },
  { name: 'Puerto Montt', lat: -41.4693, lon: -72.9424, population: 250000, country: 'Chile' },
  { name: 'Iquique', lat: -20.2307, lon: -70.1355, population: 220000, country: 'Chile' },

  // Perú
  { name: 'Lima', lat: -12.0464, lon: -77.0428, population: 10000000, country: 'Perú' },
  { name: 'Arequipa', lat: -16.4090, lon: -71.5375, population: 1000000, country: 'Perú' },
  { name: 'Cusco', lat: -13.5319, lon: -71.9675, population: 430000, country: 'Perú' },
  { name: 'Trujillo', lat: -8.1116, lon: -79.0288, population: 920000, country: 'Perú' },

  // Bolivia
  { name: 'La Paz', lat: -16.5000, lon: -68.1500, population: 2300000, country: 'Bolivia' },
  { name: 'Santa Cruz', lat: -17.8146, lon: -63.1561, population: 1900000, country: 'Bolivia' },
  { name: 'Cochabamba', lat: -17.3895, lon: -66.1568, population: 1200000, country: 'Bolivia' },

  // Resto de Sudamérica
  { name: 'Asunción', lat: -25.2637, lon: -57.5759, population: 2500000, country: 'Paraguay' },
  { name: 'Montevideo', lat: -34.9011, lon: -56.1645, population: 1900000, country: 'Uruguay' },
  { name: 'Bogotá', lat: 4.7110, lon: -74.0721, population: 10000000, country: 'Colombia' },
  { name: 'Caracas', lat: 10.4806, lon: -66.9036, population: 3000000, country: 'Venezuela' },
  { name: 'Quito', lat: -0.1807, lon: -78.4678, population: 2800000, country: 'Ecuador' },
  { name: 'São Paulo', lat: -23.5505, lon: -46.6333, population: 22000000, country: 'Brasil' },
  { name: 'Río de Janeiro', lat: -22.9068, lon: -43.1729, population: 13000000, country: 'Brasil' },

  // ── Norteamérica y Caribe ─────────────────────────────────────────────────
  { name: 'Ciudad de México', lat: 19.4326, lon: -99.1332, population: 22000000, country: 'México' },
  { name: 'Guadalajara', lat: 20.6597, lon: -103.3496, population: 5200000, country: 'México' },
  { name: 'Acapulco', lat: 16.8531, lon: -99.8237, population: 780000, country: 'México' },
  { name: 'Ciudad de Guatemala', lat: 14.6349, lon: -90.5069, population: 3000000, country: 'Guatemala' },
  { name: 'San Salvador', lat: 13.6929, lon: -89.2182, population: 1800000, country: 'El Salvador' },
  { name: 'San José', lat: 9.9281, lon: -84.0907, population: 1400000, country: 'Costa Rica' },
  { name: 'Puerto Príncipe', lat: 18.5944, lon: -72.3074, population: 2800000, country: 'Haití' },
  { name: 'Los Ángeles', lat: 34.0522, lon: -118.2437, population: 12500000, country: 'Estados Unidos' },
  { name: 'San Francisco', lat: 37.7749, lon: -122.4194, population: 3300000, country: 'Estados Unidos' },
  { name: 'Seattle', lat: 47.6062, lon: -122.3321, population: 4000000, country: 'Estados Unidos' },
  { name: 'Anchorage', lat: 61.2181, lon: -149.9003, population: 290000, country: 'Estados Unidos' },
  { name: 'Nueva York', lat: 40.7128, lon: -74.0060, population: 18800000, country: 'Estados Unidos' },
  { name: 'Vancouver', lat: 49.2827, lon: -123.1207, population: 2600000, country: 'Canadá' },

  // ── Asia ──────────────────────────────────────────────────────────────────
  { name: 'Tokio', lat: 35.6762, lon: 139.6503, population: 37000000, country: 'Japón' },
  { name: 'Osaka', lat: 34.6937, lon: 135.5023, population: 19000000, country: 'Japón' },
  { name: 'Sendai', lat: 38.2682, lon: 140.8694, population: 1100000, country: 'Japón' },
  { name: 'Seúl', lat: 37.5665, lon: 126.9780, population: 26000000, country: 'Corea del Sur' },
  { name: 'Pekín', lat: 39.9042, lon: 116.4074, population: 22000000, country: 'China' },
  { name: 'Shanghái', lat: 31.2304, lon: 121.4737, population: 29000000, country: 'China' },
  { name: 'Chengdu', lat: 30.5728, lon: 104.0668, population: 21000000, country: 'China' },
  { name: 'Taipéi', lat: 25.0330, lon: 121.5654, population: 7000000, country: 'Taiwán' },
  { name: 'Manila', lat: 14.5995, lon: 120.9842, population: 14000000, country: 'Filipinas' },
  { name: 'Yakarta', lat: -6.2088, lon: 106.8456, population: 34000000, country: 'Indonesia' },
  { name: 'Padang', lat: -0.9471, lon: 100.4172, population: 910000, country: 'Indonesia' },
  { name: 'Katmandú', lat: 27.7172, lon: 85.3240, population: 1500000, country: 'Nepal' },
  { name: 'Nueva Delhi', lat: 28.6139, lon: 77.2090, population: 32000000, country: 'India' },
  { name: 'Bombay', lat: 19.0760, lon: 72.8777, population: 21000000, country: 'India' },
  { name: 'Karachi', lat: 24.8607, lon: 67.0011, population: 17000000, country: 'Pakistán' },
  { name: 'Teherán', lat: 35.6892, lon: 51.3890, population: 9500000, country: 'Irán' },
  { name: 'Bangkok', lat: 13.7563, lon: 100.5018, population: 11000000, country: 'Tailandia' },

  // ── Europa, África y Oceanía ──────────────────────────────────────────────
  { name: 'Estambul', lat: 41.0082, lon: 28.9784, population: 16000000, country: 'Turquía' },
  { name: 'Ankara', lat: 39.9334, lon: 32.8597, population: 5700000, country: 'Turquía' },
  { name: 'Atenas', lat: 37.9838, lon: 23.7275, population: 3200000, country: 'Grecia' },
  { name: 'Roma', lat: 41.9028, lon: 12.4964, population: 4300000, country: 'Italia' },
  { name: 'Nápoles', lat: 40.8518, lon: 14.2681, population: 3100000, country: 'Italia' },
  { name: 'Lisboa', lat: 38.7223, lon: -9.1393, population: 2900000, country: 'Portugal' },
  { name: 'Madrid', lat: 40.4168, lon: -3.7038, population: 6700000, country: 'España' },
  { name: 'Londres', lat: 51.5074, lon: -0.1278, population: 9600000, country: 'Reino Unido' },
  { name: 'París', lat: 48.8566, lon: 2.3522, population: 11200000, country: 'Francia' },
  { name: 'Berlín', lat: 52.5200, lon: 13.4050, population: 3700000, country: 'Alemania' },
  { name: 'Moscú', lat: 55.7558, lon: 37.6173, population: 12600000, country: 'Rusia' },
  { name: 'El Cairo', lat: 30.0444, lon: 31.2357, population: 22000000, country: 'Egipto' },
  { name: 'Argel', lat: 36.7538, lon: 3.0588, population: 3400000, country: 'Argelia' },
  { name: 'Nairobi', lat: -1.2921, lon: 36.8219, population: 5300000, country: 'Kenia' },
  { name: 'Lagos', lat: 6.5244, lon: 3.3792, population: 16000000, country: 'Nigeria' },
  { name: 'Johannesburgo', lat: -26.2041, lon: 28.0473, population: 6300000, country: 'Sudáfrica' },
  { name: 'Sídney', lat: -33.8688, lon: 151.2093, population: 5300000, country: 'Australia' },
  { name: 'Melbourne', lat: -37.8136, lon: 144.9631, population: 5100000, country: 'Australia' },
  { name: 'Wellington', lat: -41.2866, lon: 174.7756, population: 420000, country: 'Nueva Zelanda' },
  { name: 'Christchurch', lat: -43.5321, lon: 172.6362, population: 390000, country: 'Nueva Zelanda' },
  { name: 'Port Moresby', lat: -9.4438, lon: 147.1803, population: 400000, country: 'Papúa Nueva Guinea' },
  { name: 'Suva', lat: -18.1416, lon: 178.4419, population: 93000, country: 'Fiyi' },
  { name: 'Reikiavik', lat: 64.1466, lon: -21.9426, population: 140000, country: 'Islandia' },
];
