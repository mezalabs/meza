import { Shield, ShieldCheck } from '@phosphor-icons/react';
import { useState } from 'react';
import { useVerificationStore } from '../../stores/verification.ts';
import { SafetyNumberDialog } from './SafetyNumberDialog.tsx';

interface VerificationBadgeProps {
  userId: string;
}

/**
 * Small shield icon that shows verification status for a user.
 * Clicking opens the SafetyNumberDialog.
 */
export function VerificationBadge({ userId }: VerificationBadgeProps) {
  const isVerified = useVerificationStore((s) => s.isVerified(userId));
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`rounded-md p-1 transition-colors ${
          isVerified
            ? 'text-accent hover:text-accent-hover'
            : 'text-text-subtle hover:bg-bg-elevated hover:text-text'
        }`}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setDialogOpen(true);
        }}
        aria-label={isVerified ? 'Verified identity' : 'Verify identity'}
        title={isVerified ? 'Verified identity' : 'Verify identity'}
      >
        {isVerified ? (
          <ShieldCheck size={20} weight="fill" aria-hidden="true" />
        ) : (
          <Shield size={20} aria-hidden="true" />
        )}
      </button>
      <SafetyNumberDialog
        userId={userId}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </>
  );
}
