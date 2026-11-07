// shadcn/ui's Button, on the PingDost tokens.
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';
import type { ComponentProps } from 'react';

import { cn } from '@/lib/cn';

const buttonVariants = cva(
  'pd-press inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg px-5 text-base font-bold disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand text-on-primary',
        secondary: 'pd-card text-foreground hover:bg-raised',
        ghost: 'text-accent hover:bg-accent/10',
        danger: 'bg-danger/10 text-danger hover:bg-danger/20',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

export function Button({
  className,
  variant,
  asChild = false,
  ...props
}: ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot.Root : 'button';
  return <Component className={cn(buttonVariants({ variant }), className)} {...props} />;
}

/** A round icon-only control; `aria-label` is its only name, so it is required. */
export function IconButton({
  className,
  tone = 'plain',
  asChild = false,
  ...props
}: ComponentProps<'button'> & {
  'aria-label': string;
  tone?: 'plain' | 'soft' | 'brand';
  asChild?: boolean;
}) {
  const Component = asChild ? Slot.Root : 'button';
  return (
    <Component
      className={cn(
        'pd-press inline-flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full disabled:pointer-events-none disabled:opacity-50',
        tone === 'plain' && 'text-foreground hover:bg-raised',
        tone === 'soft' && 'bg-accent/15 text-accent hover:bg-accent/25',
        tone === 'brand' && 'bg-brand text-on-primary',
        className,
      )}
      {...props}
    />
  );
}
