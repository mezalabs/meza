import { DemoAvatar } from './DemoAvatar';
import type { DemoUser } from './types';

interface DemoMemberListProps {
  members: DemoUser[];
}

function PresenceDot({ presence }: { presence: DemoUser['presence'] }) {
  const colors = {
    online: 'bg-success',
    idle: 'bg-warning',
    offline: 'bg-text-subtle',
  };
  return (
    <span
      className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-bg-overlay ${colors[presence]}`}
    />
  );
}

export function DemoMemberList({ members }: DemoMemberListProps) {
  const online = members.filter((m) => m.presence !== 'offline');
  const offline = members.filter((m) => m.presence === 'offline');

  return (
    <div className="hidden w-44 flex-shrink-0 border-l border-border bg-bg-overlay p-3 lg:block">
      {online.length > 0 && (
        <>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            Online — {online.length}
          </div>
          <div className="space-y-1">
            {online.map((user) => (
              <div
                key={user.name}
                className="flex items-center gap-2 rounded-md px-2 py-1 transition-colors hover:bg-bg-surface"
              >
                <div className="relative">
                  <DemoAvatar
                    name={user.name}
                    color={user.avatarColor}
                    avatarUrl={user.avatarUrl}
                    size="sm"
                  />
                  <PresenceDot presence={user.presence} />
                </div>
                <span className="truncate text-sm text-text-muted">
                  {user.name}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      {offline.length > 0 && (
        <>
          <div className="mb-2 mt-4 text-[10px] font-semibold uppercase tracking-wider text-text-subtle">
            Offline — {offline.length}
          </div>
          <div className="space-y-1">
            {offline.map((user) => (
              <div
                key={user.name}
                className="flex items-center gap-2 rounded-md px-2 py-1 opacity-50"
              >
                <div className="relative">
                  <DemoAvatar
                    name={user.name}
                    color={user.avatarColor}
                    size="sm"
                  />
                  <PresenceDot presence={user.presence} />
                </div>
                <span className="truncate text-sm text-text-muted">
                  {user.name}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
