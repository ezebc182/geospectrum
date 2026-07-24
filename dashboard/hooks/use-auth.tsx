'use client';

import * as React from 'react';

import {
  deleteAccount as deleteAccountRequest,
  getMe,
  login as loginRequest,
  logout as logoutRequest,
  verifyTotpLogin as verifyTotpLoginRequest,
} from '@/lib/auth';
import type { UserPublic } from '@/lib/types';

interface AuthContextValue {
  user: UserPublic | null;
  loading: boolean;
  /** `true` entre un `login()` que devolvió `requires_2fa` y que el segundo
   * factor se verifique (o se cancele) — la UI de login usa este flag para
   * mostrar el segundo paso (input de código TOTP/backup code). */
  pendingTwoFactor: boolean;
  login: (email: string, password: string) => Promise<void>;
  /** Completa el segundo paso del login (código TOTP o backup code) tras
   * `login()` haber dejado `pendingTwoFactor=true`. En éxito, resuelve la
   * sesión completa igual que `login()` sin 2FA. */
  verifyTwoFactor: (code: string) => Promise<void>;
  /** Cancela el segundo paso pendiente sin completar el login (ej. el
   * usuario quiere volver a intentar con otro email/password). */
  cancelTwoFactor: () => void;
  logout: () => Promise<void>;
  /** Elimina la cuenta propia y limpia el estado local, mismo patrón que
   * `logout()` — el caller (settings page) es responsable de redirigir. */
  deleteAccount: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<UserPublic | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pendingTwoFactor, setPendingTwoFactor] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;

    getMe()
      .then((me) => {
        if (!cancelled) setUser(me);
      })
      .catch(() => {
        // Error de red real (no 401) al hidratar sesión inicial: se trata
        // como "sin sesión" para no bloquear el render del dashboard, pero
        // no se enmascara — queda en consola para diagnóstico.
        if (!cancelled) setUser(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = React.useCallback(async (email: string, password: string) => {
    const result = await loginRequest(email, password);
    if (result.requiresTwoFactor) {
      setPendingTwoFactor(true);
      return;
    }
    setPendingTwoFactor(false);
    setUser(result.user);
  }, []);

  const verifyTwoFactor = React.useCallback(async (code: string) => {
    const me = await verifyTotpLoginRequest(code);
    setPendingTwoFactor(false);
    setUser(me);
  }, []);

  const cancelTwoFactor = React.useCallback(() => {
    setPendingTwoFactor(false);
  }, []);

  const logout = React.useCallback(async () => {
    await logoutRequest();
    setUser(null);
    setPendingTwoFactor(false);
  }, []);

  const deleteAccount = React.useCallback(async () => {
    await deleteAccountRequest();
    setUser(null);
    setPendingTwoFactor(false);
  }, []);

  const value = React.useMemo(
    () => ({
      user,
      loading,
      pendingTwoFactor,
      login,
      verifyTwoFactor,
      cancelTwoFactor,
      logout,
      deleteAccount,
    }),
    [user, loading, pendingTwoFactor, login, verifyTwoFactor, cancelTwoFactor, logout, deleteAccount]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
