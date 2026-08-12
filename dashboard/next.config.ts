import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

// i18n sin routing (design i18n-dashboard, Decision 1): el plugin solo
// registra ./i18n/request.ts como resolutor de locale por request —
// middleware, rutas y callbacks de OAuth quedan intactos.
const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  },
};

export default withNextIntl(nextConfig);
