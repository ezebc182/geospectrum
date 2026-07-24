'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTheme } from 'next-themes';
import { LogOut, Moon, Settings, Sun } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import type { UserPublic, UserRole } from '@/lib/types';

// Etiquetas legibles por rol — cubre el Success Criteria del proposal "La
// UI refleja el rol del usuario autenticado" (design.md Decision 6, 4
// roles jerárquicos).
const ROLE_LABEL: Record<UserRole, string> = {
  superadmin: 'Superadmin',
  admin: 'Admin',
  moderador: 'Moderador',
  viewer: 'Viewer',
};

/**
 * Iniciales de fallback para usuarios sin avatar_url (registro por
 * password, sin foto de Google) — primeras 2 letras del email antes del
 * "@", en mayúsculas. Ej. "ana.perez@example.com" -> "AN".
 */
function initialsFromEmail(email: string): string {
  const localPart = email.split('@')[0] ?? '';
  return localPart.slice(0, 2).toUpperCase() || '??';
}

/** Avatar circular: foto real de Google si existe, si no un círculo con
 * las iniciales del email (fallback para usuarios de password). */
function UserAvatar({ user, className }: { user: UserPublic; className?: string }) {
  if (user.avatar_url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- avatar remoto
      // de Google (dominio externo lh3.googleusercontent.com), no vale la
      // pena configurar next/image remotePatterns solo para esto.
      <img
        src={user.avatar_url}
        alt={user.name ?? user.email}
        // referrerPolicy="no-referrer": sin esto, Google bloquea el request
        // de la imagen (responde error) porque el navegador manda el header
        // Referer completo revelando el origen del dashboard — mismo
        // problema documentado ampliamente para <img> de
        // lh3.googleusercontent.com fuera del dominio de Google.
        referrerPolicy="no-referrer"
        className={cn('h-8 w-8 shrink-0 rounded-full object-cover', className)}
      />
    );
  }

  return (
    <div
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-seismic-600 text-xs font-semibold text-white',
        className
      )}
      aria-hidden="true"
    >
      {initialsFromEmail(user.email)}
    </div>
  );
}

/** User menu del header superior: avatar/nombre + toggle de tema + logout. */
export function UserMenu() {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { user, logout } = useAuth();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  async function handleLogout() {
    await logout();
    router.push('/login');
  }

  if (!user) {
    return null;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
        >
          <UserAvatar user={user} />
          <div className="hidden min-w-0 flex-col sm:flex">
            <span className="truncate text-xs font-medium text-foreground">
              {user.name ?? user.email}
            </span>
            <span className="text-xs text-muted-foreground">{ROLE_LABEL[user.role]}</span>
          </div>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" className="w-56">
        <DropdownMenuLabel>
          <div className="flex flex-col">
            <span className="truncate font-medium">{user.name ?? user.email}</span>
            {user.name && (
              <span className="truncate text-xs font-normal text-gray-500 dark:text-gray-400">
                {user.email}
              </span>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/settings')}>
          <Settings />
          <span>Configuración de cuenta</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
          {!mounted ? (
            <div className="h-4 w-4" />
          ) : theme === 'dark' ? (
            <Sun className="text-severity-moderate" />
          ) : (
            <Moon />
          )}
          <span>{mounted && theme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={handleLogout} variant="destructive">
          <LogOut />
          <span>Cerrar sesión</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
