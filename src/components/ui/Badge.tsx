'use client';

import { HTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { useT } from '@/i18n/client';

function cn(...inputs: Parameters<typeof clsx>) {
  return twMerge(clsx(inputs));
}

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'purple';
}

export function Badge({ className, variant = 'default', children, ...props }: BadgeProps) {
  const variants = {
    default: 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200',
    success: 'bg-green-100 dark:bg-green-900/40 text-green-700 dark:text-green-300',
    warning: 'bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300',
    danger: 'bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300',
    info: 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300',
    purple: 'bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300',
  };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium',
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}

const ROLE_VARIANT: Record<string, BadgeProps['variant']> = {
  ADMIN: 'warning',
  MENTOR: 'success',
  MENTEE: 'info',
  COMPANY: 'purple',
  SOURCE: 'default',
};

export function RoleBadge({ role }: { role: string }) {
  const t = useT();
  const label = (t.usersAdmin as Record<string, string>)[role.toLowerCase()] ?? role;

  return <Badge variant={ROLE_VARIANT[role] ?? 'default'}>{label}</Badge>;
}

export function StatusBadge({ status }: { status: string }) {
  const t = useT();
  const variantByStatus: Record<string, 'success' | 'default'> = {
    ACTIVE: 'success',
    COMPLETED: 'default',
  };
  const variant = variantByStatus[status] ?? 'default';
  const label = t.relationStatus[status as keyof typeof t.relationStatus] ?? status;

  return <Badge variant={variant}>{label}</Badge>;
}
