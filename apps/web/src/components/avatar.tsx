import { cn } from '@/lib/cn';
import { useAppearance } from '@/theme';
import { avatarColors, avatarRadius } from '@pingdost/ui-tokens';

function initials(name: string): string {
  const words = name.replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1 ? `${words[0]![0]}${words.at(-1)![0]}` : (words[0] ?? '?').slice(0, 2);
  return letters.toUpperCase();
}

/**
 * A picture, or colorful initials. A person keeps their color across schemes; the shape follows
 * the user's setting. Group pictures are inline bytes from the E2EE group info (`data:` URIs);
 * profile avatars are public URLs.
 */
export function Avatar({
  name,
  url,
  size = 40,
  online = false,
  className,
}: {
  name: string;
  url?: string | null | undefined;
  size?: number;
  /** A small "online" dot on the corner. */
  online?: boolean;
  className?: string;
}) {
  const shape = useAppearance((state) => state.prefs.avatar);
  const borderRadius = avatarRadius(shape, size);
  const colors = avatarColors(name);
  const face = url ? (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      referrerPolicy="no-referrer"
      className={cn('shrink-0 object-cover', className)}
      style={{ width: size, height: size, borderRadius }}
    />
  ) : (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center font-display font-extrabold',
        className,
      )}
      style={{
        width: size,
        height: size,
        borderRadius,
        fontSize: size * 0.38,
        color: colors.on,
        backgroundImage: `linear-gradient(135deg, ${colors.from}, ${colors.to})`,
      }}
    >
      {initials(name)}
    </span>
  );
  if (!online) return face;
  const dot = Math.max(10, Math.round(size * 0.26));
  return (
    <span className="relative inline-flex shrink-0">
      {face}
      <span
        aria-hidden
        className="absolute flex items-center justify-center"
        style={{ right: -dot * 0.15, bottom: -dot * 0.15, width: dot, height: dot }}
      >
        <span className="pd-ring absolute size-full rounded-full bg-success" />
        <span className="relative size-full rounded-full border-2 border-surface bg-success" />
      </span>
    </span>
  );
}
