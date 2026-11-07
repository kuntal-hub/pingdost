// Small shared pieces: a sliding segmented control, filter chips, empty and loading states.
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

/** Choose one of a few; the highlight slides between them. Real radio buttons underneath. */
export function Segmented<Id extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { id: Id; label: string }[];
  value: Id;
  onChange: (id: Id) => void;
  label: string;
}) {
  const index = Math.max(
    0,
    options.findIndex((option) => option.id === value),
  );
  const share = 100 / options.length;
  return (
    <div role="radiogroup" aria-label={label} className="relative flex rounded-full bg-raised p-1">
      <span
        aria-hidden
        className="bg-brand absolute top-1 bottom-1 left-1 rounded-full transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        style={{
          width: `calc((100% - 0.5rem) * ${share / 100})`,
          transform: `translateX(${index * 100}%)`,
        }}
      />
      {options.map((option) => (
        <label
          key={option.id}
          className={cn(
            'relative z-10 flex min-h-10 flex-1 cursor-pointer items-center justify-center rounded-full px-2 text-center font-bold transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent',
            option.id === value ? 'text-on-primary' : 'text-muted hover:text-foreground',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={label}
            checked={option.id === value}
            onChange={() => onChange(option.id)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function Chip({
  label,
  selected,
  count,
  onClick,
}: {
  label: string;
  selected: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'pd-press flex min-h-9 shrink-0 cursor-pointer items-center gap-2 rounded-full px-4 font-bold',
        selected ? 'bg-brand text-on-primary' : 'bg-raised text-foreground hover:bg-border',
      )}
    >
      {label}
      {count !== undefined && count > 0 && (
        <span
          className={cn(
            'min-w-5 rounded-full px-1 text-center text-xs',
            selected ? 'bg-on-primary/20' : 'bg-accent/20 text-accent',
          )}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

export function EmptyState({
  icon: Glyph,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children?: ReactNode;
}) {
  return (
    <div className="pd-rise flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="pd-float flex size-22 items-center justify-center rounded-2xl bg-accent/15 text-accent">
        <Glyph aria-hidden size={40} />
      </div>
      <h3 className="font-display text-2xl font-extrabold">{title}</h3>
      {children && <div className="max-w-sm text-muted">{children}</div>}
    </div>
  );
}

/** Placeholder rows while a list loads, so it does not blink through "No items". */
export function SkeletonRows({ count = 6 }: { count?: number }) {
  return (
    <div aria-busy aria-label="Loading" className="pd-skeleton flex flex-col gap-4 p-4">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <div className="size-12 shrink-0 rounded-lg bg-raised" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3 rounded-full bg-raised" style={{ width: `${60 - index * 6}%` }} />
            <div className="h-3 rounded-full bg-raised" style={{ width: `${90 - index * 8}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
