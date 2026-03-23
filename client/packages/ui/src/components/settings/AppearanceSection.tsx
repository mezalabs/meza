import { resetDismissedTips, updateProfile, useAuthStore } from '@meza/core';
import { useState } from 'react';
import { useOnboardingStore } from '../../stores/onboarding.ts';
import { useTilingStore } from '../../stores/tiling.ts';

export function AppearanceSection() {
  const user = useAuthStore((s) => s.user);
  const [emojiScale, setEmojiScale] = useState(user?.emojiScale ?? 1);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);
  const simpleMode = user?.simpleMode ?? false;
  const [simpleModeSaving, setSimpleModeSaving] = useState(false);

  const isDirty = emojiScale !== (user?.emojiScale ?? 1);

  async function handleSave() {
    if (!isDirty || saving) return;
    setSaving(true);
    setFeedback(null);
    try {
      await updateProfile({ emojiScale });
      setFeedback({ type: 'success', message: 'Appearance updated.' });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save.',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleSimpleModeToggle() {
    if (simpleModeSaving) return;
    const newValue = !simpleMode;
    setSimpleModeSaving(true);
    try {
      await updateProfile({ simpleMode: newValue });
      if (newValue) {
        useTilingStore.getState().resetLayout();
      }
      setFeedback({
        type: 'success',
        message: newValue ? 'Simple mode enabled.' : 'Simple mode disabled.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to save.',
      });
    } finally {
      setSimpleModeSaving(false);
    }
  }

  const [resetTipsSaving, setResetTipsSaving] = useState(false);

  async function handleResetTips() {
    if (resetTipsSaving) return;
    setResetTipsSaving(true);
    setFeedback(null);
    try {
      await resetDismissedTips();
      useOnboardingStore.getState().reset();
      setFeedback({
        type: 'success',
        message: 'Onboarding tips have been reset.',
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        message: err instanceof Error ? err.message : 'Failed to reset tips.',
      });
    } finally {
      setResetTipsSaving(false);
    }
  }

  if (!user) return null;

  const previewSize = 20 * emojiScale;

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Appearance
      </h2>

      {/* Layout mode */}
      <div className="space-y-3">
        <label
          htmlFor="settings-simple-mode"
          className="block text-sm font-medium text-text"
        >
          Layout Mode
        </label>
        <div className="flex items-center gap-3">
          <button
            id="settings-simple-mode"
            type="button"
            role="switch"
            aria-checked={simpleMode}
            disabled={simpleModeSaving}
            onClick={handleSimpleModeToggle}
            className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full transition-colors disabled:opacity-50 ${
              simpleMode ? 'bg-accent' : 'bg-bg-surface'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                simpleMode ? 'translate-x-5' : 'translate-x-0.5'
              } mt-0.5`}
            />
          </button>
          <span className="text-sm text-text-muted">
            Simple — single pane, no splitting
          </span>
        </div>
      </div>

      {/* Reset onboarding tips */}
      {!simpleMode && (
        <div className="space-y-3">
          <label className="block text-sm font-medium text-text">
            Onboarding Tips
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="rounded-md border border-border px-3 py-1.5 text-sm text-text-muted transition-colors hover:bg-bg-surface hover:text-text disabled:opacity-50"
              disabled={resetTipsSaving}
              onClick={handleResetTips}
            >
              {resetTipsSaving ? 'Resetting\u2026' : 'Reset onboarding tips'}
            </button>
            <span className="text-xs text-text-subtle">
              Show tiling tips again
            </span>
          </div>
        </div>
      )}

      {/* Emoji size */}
      <div className="space-y-3">
        <label
          htmlFor="settings-emoji-scale"
          className="block text-sm font-medium text-text"
        >
          Emoji Size
        </label>
        <div className="flex items-center gap-4">
          <input
            id="settings-emoji-scale"
            type="range"
            min={1}
            max={5}
            step={0.5}
            value={emojiScale}
            onChange={(e) => {
              setEmojiScale(Number(e.target.value));
              setFeedback(null);
            }}
            className="flex-1 accent-accent"
          />
          <span className="w-12 text-right text-sm tabular-nums text-text-muted">
            {emojiScale.toFixed(1)}x
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="inline-block rounded bg-bg-surface px-2 py-1 text-center"
            style={{ fontSize: previewSize }}
          >
            🔥
          </span>
          <span className="text-xs text-text-subtle">
            Preview ({Math.round(previewSize)}px)
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent/90 disabled:opacity-50"
          disabled={!isDirty || saving}
          onClick={handleSave}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>

        {feedback && (
          <output
            className={`text-sm ${
              feedback.type === 'success' ? 'text-success' : 'text-error'
            }`}
          >
            {feedback.message}
          </output>
        )}
      </div>
    </div>
  );
}
