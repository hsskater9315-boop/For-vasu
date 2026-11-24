interface AvatarProps {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
  online?: boolean;
  showPresence?: boolean;
}

function getInitials(name: string): string {
  const clean = name.trim();
  if (!clean) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

export function Avatar({
  name,
  color,
  size = 'md',
  online = false,
  showPresence = false,
}: AvatarProps) {
  const sizeClasses =
    size === 'sm'
      ? 'h-8 w-8 text-xs'
      : size === 'lg'
        ? 'h-10 w-10 text-sm'
        : 'h-9 w-9 text-xs';

  return (
    <div className="relative inline-flex shrink-0">
      <div
        className={`${sizeClasses} flex items-center justify-center rounded-lg font-semibold tracking-tight text-white select-none`}
        style={{ backgroundColor: color }}
        aria-hidden="true"
      >
        {getInitials(name)}
      </div>
      {showPresence && (
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-white ${
            online ? 'bg-emerald-600' : 'bg-slate-300'
          }`}
          title={online ? 'Online' : 'Offline'}
        />
      )}
    </div>
  );
}
