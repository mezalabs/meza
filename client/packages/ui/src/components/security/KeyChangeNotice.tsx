import { ShieldWarning } from '@phosphor-icons/react';
import { useDisplayName } from '../../hooks/useDisplayName.ts';
import { useVerificationStore } from '../../stores/verification.ts';

interface KeyChangeNoticeProps {
  userId: string;
  serverId?: string;
}

/**
 * Inline notice shown in DM conversations when a contact's identity key
 * has changed. Ephemeral — dismissed per-session, lost on page reload.
 */
export function KeyChangeNotice({ userId, serverId }: KeyChangeNoticeProps) {
  const hasKeyChanged = useVerificationStore((s) => s.hasKeyChanged(userId));
  const dismiss = useVerificationStore((s) => s.dismissKeyChange);
  const displayName = useDisplayName(userId, serverId);

  if (!hasKeyChanged) return null;

  return (
    <div className="flex items-center justify-center gap-2 py-1 px-4">
      <div className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1.5 text-xs text-warning whitespace-nowrap">
        <ShieldWarning size={14} weight="bold" aria-hidden="true" />
        <span>
          <span className="font-medium">{displayName}</span>
          {"'s security key has changed"}
        </span>
        <button
          type="button"
          className="ml-1 text-text-subtle hover:text-text transition-colors"
          onClick={() => dismiss(userId)}
          aria-label="Dismiss"
        >
          &times;
        </button>
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}
