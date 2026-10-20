// shadcn/ui's Card and Alert, on the PingDost tokens.
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn('rounded-lg border border-border bg-surface p-6 text-foreground', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('text-xl font-semibold', className)} {...props} />;
}

export function Alert({
  className,
  tone = 'info',
  ...props
}: ComponentProps<'div'> & { tone?: 'info' | 'error' | 'success' }) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-md border bg-surface px-4 py-3',
        tone === 'error' && 'border-danger text-danger',
        tone === 'success' && 'border-success text-success',
        tone === 'info' && 'border-border text-foreground',
        className,
      )}
      {...props}
    />
  );
}
