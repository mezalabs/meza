import {
  blockUser,
  type ReportCategoryKey,
  reportMessage,
  reportUser,
} from '@meza/core';
import * as Dialog from '@radix-ui/react-dialog';
import { useState } from 'react';

type ReportTarget =
  | { kind: 'message'; messageId: string; targetUserId: string }
  | { kind: 'user'; userId: string; serverId?: string };

interface ReportModalProps {
  open: boolean;
  onClose: () => void;
  target: ReportTarget;
}

interface CategoryOption {
  value: ReportCategoryKey;
  label: string;
  description: string;
}

const CATEGORIES: ReadonlyArray<CategoryOption> = [
  {
    value: 'spam',
    label: 'Spam',
    description: 'Unwanted advertising, scams, or repeated unsolicited content',
  },
  {
    value: 'harassment',
    label: 'Harassment or bullying',
    description: 'Targeted insults, threats, or coordinated abuse',
  },
  {
    value: 'hate',
    label: 'Hate speech',
    description: 'Slurs or attacks based on identity',
  },
  {
    value: 'sexual',
    label: 'Sexual content',
    description: 'Sexually explicit content or unwanted advances',
  },
  {
    value: 'violence',
    label: 'Violence',
    description: 'Threats of physical harm or graphic violence',
  },
  {
    value: 'self_harm',
    label: 'Self-harm',
    description: 'Content promoting suicide or self-injury',
  },
  {
    value: 'illegal',
    label: 'Illegal activity',
    description: 'Content depicting or promoting illegal acts',
  },
  {
    value: 'other',
    label: 'Something else',
    description: 'If none of the above fit',
  },
];

const REASON_MAX = 1000;

type SubmissionState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'success' }
  | { kind: 'error'; message: string };

export function ReportModal({ open, onClose, target }: ReportModalProps) {
  const [category, setCategory] = useState<ReportCategoryKey | null>(null);
  const [reason, setReason] = useState('');
  const [state, setState] = useState<SubmissionState>({ kind: 'idle' });
  const [blocking, setBlocking] = useState(false);

  const reset = () => {
    setCategory(null);
    setReason('');
    setState({ kind: 'idle' });
    setBlocking(false);
  };

  const handleClose = () => {
    if (state.kind === 'submitting') return;
    reset();
    onClose();
  };

  const targetUserId =
    target.kind === 'message' ? target.targetUserId : target.userId;

  const handleSubmit = async () => {
    if (!category) {
      setState({ kind: 'error', message: 'Please select a category.' });
      return;
    }
    setState({ kind: 'submitting' });
    try {
      if (target.kind === 'message') {
        await reportMessage({
          messageId: target.messageId,
          category,
          reason: reason.trim() || undefined,
        });
      } else {
        await reportUser({
          userId: target.userId,
          serverId: target.serverId,
          category,
          reason: reason.trim() || undefined,
          idempotencyKey: `${target.userId}-${Date.now()}`,
        });
      }
      setState({ kind: 'success' });
    } catch (err) {
      setState({
        kind: 'error',
        message:
          err instanceof Error ? err.message : 'Could not submit report.',
      });
    }
  };

  const handleBlockToo = async () => {
    if (!targetUserId || blocking) return;
    setBlocking(true);
    try {
      await blockUser(targetUserId);
    } catch {
      // Block failure is non-fatal — user can retry from the profile sheet.
    } finally {
      setBlocking(false);
      handleClose();
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(o: boolean) => !o && handleClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 max-h-[90vh] w-full max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl bg-bg-elevated p-6 shadow-lg animate-scale-in"
          onEscapeKeyDown={(e) => {
            if (state.kind === 'submitting') e.preventDefault();
          }}
          aria-describedby="report-modal-description"
        >
          {state.kind === 'success' ? (
            <SuccessView
              onBlock={targetUserId ? handleBlockToo : undefined}
              onClose={handleClose}
              blocking={blocking}
            />
          ) : (
            <FormView
              category={category}
              setCategory={setCategory}
              reason={reason}
              setReason={setReason}
              state={state}
              isMessage={target.kind === 'message'}
              onSubmit={handleSubmit}
              onClose={handleClose}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

interface FormViewProps {
  category: ReportCategoryKey | null;
  setCategory: (c: ReportCategoryKey) => void;
  reason: string;
  setReason: (r: string) => void;
  state: SubmissionState;
  isMessage: boolean;
  onSubmit: () => void;
  onClose: () => void;
}

function FormView({
  category,
  setCategory,
  reason,
  setReason,
  state,
  isMessage,
  onSubmit,
  onClose,
}: FormViewProps) {
  const isSubmitting = state.kind === 'submitting';
  return (
    <>
      <Dialog.Title className="text-lg font-semibold text-text">
        Report {isMessage ? 'message' : 'user'}
      </Dialog.Title>
      <Dialog.Description
        id="report-modal-description"
        className="mt-1 text-sm text-text-muted"
      >
        Tell us what's wrong. Reports go to moderators only — the reported
        person will not see your name.
      </Dialog.Description>

      <fieldset className="mt-4 space-y-1">
        <legend className="sr-only">Report category</legend>
        {CATEGORIES.map((opt) => {
          const selected = category === opt.value;
          return (
            <label
              key={opt.value}
              className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2 transition-colors ${
                selected
                  ? 'border-accent bg-accent-subtle'
                  : 'border-border hover:border-border-hover'
              }`}
            >
              <input
                type="radio"
                name="report-category"
                value={opt.value}
                checked={selected}
                onChange={() => setCategory(opt.value)}
                className="mt-1 h-4 w-4"
                aria-label={opt.label}
              />
              <span className="flex-1 text-sm">
                <span className="block font-medium text-text">{opt.label}</span>
                <span className="block text-xs text-text-muted">
                  {opt.description}
                </span>
              </span>
            </label>
          );
        })}
      </fieldset>

      <label className="mt-4 block text-sm text-text-muted">
        <span className="mb-1 block">Additional context (optional)</span>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX))}
          rows={3}
          maxLength={REASON_MAX}
          placeholder="Anything moderators should know?"
          className="w-full resize-none rounded-md border border-border bg-bg-surface px-2 py-1.5 text-sm text-text outline-none focus:border-accent"
        />
        <span className="mt-1 block text-right text-xs text-text-muted">
          {reason.length}/{REASON_MAX}
        </span>
      </label>

      {state.kind === 'error' && (
        <p
          className="mt-2 rounded-md bg-error/10 px-3 py-2 text-sm text-error"
          role="alert"
        >
          {state.message}
        </p>
      )}

      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          disabled={isSubmitting}
          onClick={onClose}
          className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={isSubmitting || !category}
          onClick={onSubmit}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent/80 disabled:opacity-50"
        >
          {isSubmitting ? 'Submitting…' : 'Submit report'}
        </button>
      </div>
    </>
  );
}

function SuccessView({
  onBlock,
  onClose,
  blocking,
}: {
  onBlock?: () => void;
  onClose: () => void;
  blocking: boolean;
}) {
  return (
    <>
      <Dialog.Title className="text-lg font-semibold text-text">
        Thanks for the report
      </Dialog.Title>
      <output className="mt-3 block text-sm text-text-muted">
        Our team will review it. You won't get a status update, but action will
        be taken if our policies are broken.
      </output>
      {onBlock && (
        <p className="mt-3 text-sm text-text-muted">
          Want to also block this user so you don't see their messages?
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        {onBlock && (
          <button
            type="button"
            disabled={blocking}
            onClick={onBlock}
            className="rounded-md bg-bg-surface px-3 py-1.5 text-sm text-text-muted hover:bg-bg-elevated hover:text-text disabled:opacity-50"
          >
            {blocking ? 'Blocking…' : 'Block user'}
          </button>
        )}
        <button
          type="button"
          onClick={onClose}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black hover:bg-accent/80"
        >
          Done
        </button>
      </div>
    </>
  );
}
