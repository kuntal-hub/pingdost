// shadcn/ui's Card and Alert, on the PingDost tokens.
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Card({ className, ...props }: ComponentProps<'section'>) {
  return <section className={cn('pd-card rounded-xl p-6 text-foreground', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>) {
  return <h2 className={cn('font-display text-xl font-extrabold', className)} {...props} />;
}

const ALERT_ICONS = { info: Info, error: CircleAlert, success: CircleCheck };

export function Alert({
  className,
  tone = 'info',
  children,
  ...props
}: ComponentProps<'div'> & { tone?: 'info' | 'error' | 'success' }) {
  const Glyph = ALERT_ICONS[tone];
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-3 rounded-lg px-4 py-3 font-medium',
        tone === 'error' && 'bg-danger/10 text-danger',
        tone === 'success' && 'bg-success/10 text-success',
        tone === 'info' && 'bg-accent/10 text-foreground',
        className,
      )}
      {...props}
    >
      <Glyph aria-hidden size={20} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
