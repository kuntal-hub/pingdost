import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      className={cn(
        'min-h-12 w-full rounded-lg border-2 border-border bg-surface px-4 text-base text-foreground transition-colors placeholder:text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'min-h-12 w-full resize-none rounded-lg border-2 border-border bg-surface px-4 py-2 text-base text-foreground transition-colors placeholder:text-muted focus:border-accent focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex min-h-14 cursor-pointer items-center gap-4 py-2">
      <span className="flex-1">
        <span className="block font-bold">{label}</span>
        {description && <span className="block text-sm text-muted">{description}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="pd-switch"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}
