interface DemoAvatarProps {
  name: string;
  color: string;
  avatarUrl?: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeClasses = {
  sm: 'h-6 w-6 text-xs',
  md: 'h-7 w-7 text-xs',
  lg: 'h-8 w-8 text-sm',
};

export function DemoAvatar({
  name,
  color,
  avatarUrl,
  size = 'md',
}: DemoAvatarProps) {
  const initial = name[0]?.toUpperCase() ?? '?';

  if (avatarUrl) {
    return (
      <img
        src={avatarUrl}
        alt=""
        className={`${sizeClasses[size]} flex-shrink-0 rounded-full object-cover`}
      />
    );
  }

  return (
    <div
      className={`${sizeClasses[size]} flex flex-shrink-0 items-center justify-center rounded-full font-medium text-black`}
      style={{ backgroundColor: color }}
    >
      {initial}
    </div>
  );
}
