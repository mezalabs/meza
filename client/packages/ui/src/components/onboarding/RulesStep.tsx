import { useState } from 'react';

interface RulesStepProps {
  rules: string;
  readOnly: boolean;
  acknowledged: boolean;
  onAcknowledge: () => void;
  loading: boolean;
}

export function RulesStep({
  rules,
  readOnly,
  acknowledged,
  onAcknowledge,
  loading,
}: RulesStepProps) {
  const [checked, setChecked] = useState(false);
  const ruleLines = rules.split('\n').filter((line) => line.trim());

  return (
    <div className="flex flex-col">
      <h2 className="mb-4 text-xl font-semibold text-text">Server Rules</h2>

      <ol className="mb-6 space-y-3">
        {ruleLines.map((rule, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rules are static text lines with no reordering
          <li key={i} className="flex gap-3 text-sm text-text-muted">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-surface text-xs font-medium text-text-subtle">
              {i + 1}
            </span>
            <span className="pt-0.5">{rule}</span>
          </li>
        ))}
      </ol>

      {!readOnly && !acknowledged && (
        <div className="mt-auto space-y-4">
          <label className="flex items-center gap-3 text-sm text-text">
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              className="h-4 w-4 rounded border-border bg-bg-surface accent-accent"
            />
            I have read and agree to the server rules
          </label>

          <button
            type="button"
            onClick={onAcknowledge}
            disabled={!checked || loading}
            className="w-full rounded-md bg-accent px-6 py-2 text-sm font-medium text-black hover:bg-accent-hover disabled:opacity-50"
          >
            {loading ? 'Acknowledging...' : 'Acknowledge & Continue'}
          </button>
        </div>
      )}

      {(readOnly || acknowledged) && (
        <p className="mt-4 text-xs text-text-subtle italic">
          Rules acknowledged
        </p>
      )}
    </div>
  );
}
