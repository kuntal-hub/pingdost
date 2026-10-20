import { cn } from '@/lib/cn';

/**
 * A round picture or the name's first letter. Group pictures are inline bytes from the E2EE
 * group info (`data:` URIs); profile avatars are public URLs.
 */
export function Avatar({
  name,
  url,
  size = 40,
  className,
}: {
  name: string;
  url?: string | null | undefined;
  size?: number;
  className?: string;
}) {
  const letter = name.replace(/^@/, '').charAt(0).toUpperCase() || '?';
  if (url) {
    return (
      <img
        src={url}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        className={cn('shrink-0 rounded-full object-cover', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full bg-primary font-semibold text-on-primary',
        className,
      )}
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {letter}
    </span>
  );
}
