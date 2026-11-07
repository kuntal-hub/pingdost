// shadcn/ui-style dropdown menu and dialog on Radix primitives (keyboard and screen-reader
// support built in), on the PingDost tokens.
import type { LucideIcon } from 'lucide-react';
import { Dialog as DialogPrimitive, DropdownMenu } from 'radix-ui';
import type { ReactNode } from 'react';

import { cn } from '@/lib/cn';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  destructive?: boolean;
  disabled?: boolean;
  shortcut?: string;
  icon?: LucideIcon;
}

export function Menu({
  trigger,
  items,
  header,
  label,
}: {
  trigger: ReactNode;
  items: MenuItem[];
  header?: ReactNode;
  label: string;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild aria-label={label}>
        {trigger}
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={6}
          className="pd-menu pd-floating z-50 min-w-52 origin-(--radix-dropdown-menu-content-transform-origin) rounded-xl p-1.5 text-foreground"
        >
          {header}
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.label}
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={cn(
                'flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-3 font-medium outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-raised',
                item.destructive && 'text-danger',
              )}
            >
              {item.icon && <item.icon aria-hidden size={18} />}
              <span className="flex-1">{item.label}</span>
              {item.shortcut && <span className="text-xs text-muted">{item.shortcut}</span>}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="pd-overlay fixed inset-0 z-40 bg-black/55" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-4">
          <DialogPrimitive.Content className="pd-dialog pd-floating pointer-events-auto flex w-[min(92vw,28rem)] flex-col gap-4 rounded-2xl p-6 text-foreground">
            <DialogPrimitive.Title className="font-display text-xl font-extrabold">
              {title}
            </DialogPrimitive.Title>
            {description ? (
              <DialogPrimitive.Description className="text-muted">
                {description}
              </DialogPrimitive.Description>
            ) : (
              <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
            )}
            {children}
          </DialogPrimitive.Content>
        </div>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
