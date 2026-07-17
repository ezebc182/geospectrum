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
}: KPICardProps) {
  return (
    <Card className={cn('ring-2 transition-all hover:shadow-lg', borderClasses[color], className)}>
      <CardContent>
        <div className="flex items-start justify-between">
          <div className="flex-1">
            <p className="text-sm font-medium text-muted-foreground">{title}</p>
            <p className={cn('mt-2 font-data text-3xl font-bold text-foreground')}>
              {value}
            </p>
            {subtitle && (
              <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
            )}
          </div>
          {icon && <div className={cn('text-2xl', accentClasses[color])}>{icon}</div>}
        </div>

        {trend && (
          <div className="mt-4">
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
