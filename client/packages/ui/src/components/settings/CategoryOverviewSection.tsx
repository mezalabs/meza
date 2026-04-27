import { updateChannelGroup, useChannelGroupStore } from '@meza/core';
import { useEffect, useMemo, useState } from 'react';

interface CategoryOverviewSectionProps {
  serverId: string;
  channelGroupId: string;
}

export function CategoryOverviewSection({
  serverId,
  channelGroupId,
}: CategoryOverviewSectionProps) {
  const groups = useChannelGroupStore((s) => s.byServer[serverId]);
  const group = useMemo(
    () => groups?.find((g) => g.id === channelGroupId),
    [groups, channelGroupId],
  );

  const [name, setName] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!group) return;
    setName(group.name);
  }, [group]);

  if (!group) {
    return <div className="text-sm text-text-muted">Category not found</div>;
  }

  const trimmed = name.trim();
  const nameValid = trimmed.length >= 1 && trimmed.length <= 100;
  const isDirty = trimmed !== group.name;

  async function handleSave() {
    if (!nameValid || !isDirty) return;
    setIsSaving(true);
    setFeedback(null);
    try {
      await updateChannelGroup(channelGroupId, { name: trimmed });
      setFeedback({ type: 'success', message: 'Category updated' });
    } catch {
      setFeedback({ type: 'error', message: 'Failed to update category' });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="max-w-lg space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Overview
      </h2>

      <div className="space-y-1.5">
        <label
          htmlFor="category-name"
          className="block text-sm font-medium text-text"
        >
          Category Name
        </label>
        <input
          id="category-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          className="w-full rounded-md border border-border bg-bg-surface px-3 py-2 text-sm text-text placeholder:text-text-subtle focus:border-accent focus:outline-none"
          placeholder="Category name"
        />
        {!nameValid && name.length > 0 && (
          <p className="text-xs text-error">
            Category name must be 1–100 characters
          </p>
        )}
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!isDirty || !nameValid || isSaving}
          onClick={handleSave}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? 'Saving...' : 'Save Changes'}
        </button>
        {feedback && (
          <span
            className={`text-sm ${
              feedback.type === 'success' ? 'text-success' : 'text-error'
            }`}
          >
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
}
