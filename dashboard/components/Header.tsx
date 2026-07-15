'use client';

import Link from 'next/link';
import { useTheme } from 'next-themes';
import { Moon, Sun, Activity } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { useEffect, useState } from 'react';

export function Header() {
  const { theme, setTheme } = useTheme();
  const pathname = usePathname();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const routes = [
    { href: '/', label: 'Dashboard' },
    { href: '/explore', label: 'Explorador' },
    { href: '/spectrograms', label: 'Espectrogramas' },
    { href: '/live', label: 'En Vivo' },
    { href: '/analytics', label: 'Análisis' },
  ];

  return (
    <header className="border-b-2 border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900">
      <div className="w-full px-4 sm:px-6 lg:px-8">
        <div className="flex h-16 items-center justify-between">
          <div className="flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 font-bold text-xl">
              <Activity className="h-6 w-6 text-seismic-600" />
              <span className="text-gray-900 dark:text-white">GeoSpectrum</span>
            </Link>

            <nav className="hidden md:flex items-center gap-6">
              {routes.map((route) => (
                <Link
                  key={route.href}
                  href={route.href}
                  className={cn(
                    'text-sm font-medium transition-colors hover:text-seismic-600',
                    pathname === route.href
                      ? 'text-seismic-600'
                      : 'text-gray-600 dark:text-gray-400'
                  )}
                >
                  {route.label}
                </Link>
              ))}
            </nav>
          </div>

          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg p-2 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
            aria-label="Toggle theme"
          >
            {!mounted ? (
              <div className="h-5 w-5" />
            ) : theme === 'dark' ? (
              <Sun className="h-5 w-5 text-yellow-500" />
            ) : (
              <Moon className="h-5 w-5 text-gray-700" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
