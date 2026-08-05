/**
 * Componente para mostrar KPIs individuales
 */

import { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  className?: string;
  /** Padding y tipografía reducidos, para grids donde el KPI es contexto secundario. Default: false. */
  compact?: boolean;
}

/** Prop `color` (heredada del inventario de KPIs) remapeada a tokens de severidad. */
const accentClasses = {
  blue: 'text-foreground',
  gray: 'text-muted-foreground',
  green: 'text-severity-ok',
  yellow: 'text-severity-moderate',
  red: 'text-severity-critical',
};

const borderClasses = {
  blue: 'ring-foreground/10',
  gray: 'ring-foreground/10',
  green: 'ring-severity-ok/30',
  yellow: 'ring-severity-moderate/30',
  red: 'ring-severity-critical/30',
};

export function KPICard({
  title,
  value,
  subtitle,
  icon,
  trend,
  color = 'gray',
  className,
  compact = false,
}: KPICardProps) {
  return (
    <Card className={cn('ring-2 transition-all hover:shadow-lg', borderClasses[color], className)}>
      <CardContent className={compact ? 'p-3' : undefined}>
        <div className="flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <p className={cn('truncate font-medium text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
              {title}
            </p>
            <p
              className={cn(
                'font-data font-bold text-foreground',
                compact ? 'mt-1 text-xl' : 'mt-2 text-3xl'
              )}
            >
              {value}
            </p>
            {subtitle && (
              <p className={cn('truncate text-muted-foreground', compact ? 'mt-0.5 text-xs' : 'mt-1 text-sm')}>
                {subtitle}
              </p>
            )}
          </div>
          {icon && (
            <div className={cn(compact ? 'text-lg' : 'text-2xl', accentClasses[color])}>{icon}</div>
          )}
        </div>

        {trend && (
          <div className={compact ? 'mt-2' : 'mt-4'}>
            <span
              className={cn(
                'inline-flex items-center text-sm font-medium',
                trend === 'up' && 'text-severity-ok',
                trend === 'down' && 'text-severity-critical',
                trend === 'neutral' && 'text-muted-foreground'
              )}
            >
              {trend === 'up' && '↑'}
              {trend === 'down' && '↓'}
              {trend === 'neutral' && '→'}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
