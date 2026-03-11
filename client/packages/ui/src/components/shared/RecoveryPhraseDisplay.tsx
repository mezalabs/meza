import { useState } from 'react';

interface RecoveryPhraseDisplayProps {
  phrase: string;
  onDone: () => void;
  /** Label for the confirm button. Defaults to "Continue". */
  confirmLabel?: string;
}

export function RecoveryPhraseDisplay({
  phrase,
  onDone,
  confirmLabel = 'Continue',
}: RecoveryPhraseDisplayProps) {
  const words = phrase.split(' ');
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(phrase);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      setTimeout(
        () => navigator.clipboard.writeText('').catch(() => {}),
        30000,
      );
    } catch {
      // Clipboard API may not be available in all contexts
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm font-semibold text-text">Recovery Phrase</h3>
      <p className="text-xs text-text-muted">
        Write down these 12 words and store them safely. This is the only way to
        recover your encrypted messages if you lose your password.
      </p>

      <div className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-bg-base p-4">
        {words.map((word, i) => (
          <div
            key={`${i}-${word}`}
            className="flex items-center justify-center"
          >
            <span className="text-sm font-mono text-text">{word}</span>
          </div>
        ))}
      </div>

      <button
        type="button"
        onClick={handleCopy}
        className="w-full rounded-lg border border-border px-4 py-2 text-xs text-text-muted hover:bg-bg-surface transition-colors"
      >
        {copied ? 'Copied!' : 'Copy to clipboard'}
      </button>

      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span className="text-xs text-text-muted">
          I have saved my recovery phrase in a safe place
        </span>
      </label>

      <button
        type="button"
        onClick={onDone}
        disabled={!confirmed}
        className="w-full rounded-lg bg-accent px-5 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
      >
        {confirmLabel}
      </button>
    </div>
  );
}
