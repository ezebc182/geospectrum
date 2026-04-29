/**
 * Componente para mostrar KPIs individuales
 */

import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface KPICardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: ReactNode;
  trend?: 'up' | 'down' | 'neutral';
  color?: 'blue' | 'green' | 'yellow' | 'red' | 'gray';
  className?: string;
}

const colorClasses = {
  blue: 'bg-blue-50 dark:bg-blue-950 border-blue-200 dark:border-blue-800',
  green: 'bg-green-50 dark:bg-green-950 border-green-200 dark:border-green-800',
  yellow: 'bg-yellow-50 dark:bg-yellow-950 border-yellow-200 dark:border-yellow-800',
  red: 'bg-red-50 dark:bg-red-950 border-red-200 dark:border-red-800',
  gray: 'bg-gray-50 dark:bg-gray-900 border-gray-200 dark:border-gray-700',
};

const iconColorClasses = {
  blue: 'text-blue-600 dark:text-blue-400',
  green: 'text-green-600 dark:text-green-400',
  yellow: 'text-yellow-600 dark:text-yellow-400',
  red: 'text-red-600 dark:text-red-400',
  gray: 'text-gray-600 dark:text-gray-400',
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
    <div
      className={cn(
        'rounded-lg border-2 p-6 transition-all hover:shadow-lg',
        colorClasses[color],
        className
      )}
    >
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
            {title}
          </p>
          <p className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">
            {value}
          </p>
          {subtitle && (
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {subtitle}
            </p>
          )}
        </div>
        {icon && (
          <div className={cn('text-2xl', iconColorClasses[color])}>
            {icon}
          </div>
        )}
      </div>

      {trend && (
        <div className="mt-4">
          <span
            className={cn(
              'inline-flex items-center text-sm font-medium',
              trend === 'up' && 'text-green-600 dark:text-green-400',
              trend === 'down' && 'text-red-600 dark:text-red-400',
              trend === 'neutral' && 'text-gray-600 dark:text-gray-400'
            )}
          >
            {trend === 'up' && '↑'}
            {trend === 'down' && '↓'}
            {trend === 'neutral' && '→'}
          </span>
        </div>
      )}
    </div>
  );
}
