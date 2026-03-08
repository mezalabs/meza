import {
  aesGcmEncrypt,
  changePassword,
  deriveKeys,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  encryptRecoveryBundle,
  generateRecoveryPhrase,
  getIdentity,
  persistIdentity,
  serializeIdentity,
  useAuthStore,
} from '@meza/core';
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { RecoveryPhraseDisplay } from '../shared/RecoveryPhraseDisplay.tsx';

type View = 'default' | 'change-password' | 'recovery-phrase';

export function SecuritySection() {
  const user = useAuthStore((s) => s.user);
  const [view, setView] = useState<View>('default');
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);

  if (!user) return null;

  // Show recovery phrase display after change password or regenerate
  if (recoveryPhrase) {
    return (
      <div className="max-w-md">
        <RecoveryPhraseDisplay
          phrase={recoveryPhrase}
          onDone={() => {
            setRecoveryPhrase(null);
            setView('default');
          }}
          confirmLabel="Done"
        />
      </div>
    );
  }

  if (view === 'change-password') {
    return (
      <ChangePasswordForm
        onBack={() => setView('default')}
        onRecoveryPhrase={setRecoveryPhrase}
      />
    );
  }

  if (view === 'recovery-phrase') {
    return (
      <RegenerateRecoveryForm
        onBack={() => setView('default')}
        onRecoveryPhrase={setRecoveryPhrase}
      />
    );
  }

  return (
    <div className="max-w-md space-y-6">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
        Security
      </h2>

      {/* Change Password */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text">Password</span>
        <p className="text-xs text-text-muted">
          Change your password and get a new recovery phrase.
        </p>
        <button
          type="button"
          className="rounded-md bg-bg-surface border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-bg-tertiary"
          onClick={() => setView('change-password')}
        >
          Change Password
        </button>
      </div>

      {/* Regenerate Recovery Phrase */}
      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-text">
          Recovery Phrase
        </span>
        <p className="text-xs text-text-muted">
          Generate a new 12-word recovery phrase. This replaces your current
          phrase and is the only way to recover your account if you forget your
          password.
        </p>
        <button
          type="button"
          className="rounded-md bg-bg-surface border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-bg-tertiary"
          onClick={() => setView('recovery-phrase')}
        >
          Regenerate Recovery Phrase
        </button>
      </div>
    </div>
  );
}

const INPUT_CLASS =
  'w-full rounded-lg border border-border bg-bg-surface px-3 py-2.5 text-sm text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';

function ChangePasswordForm({
  onBack,
  onRecoveryPhrase,
}: {
  onBack: () => void;
  onRecoveryPhrase: (phrase: string) => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useAuthStore((s) => s.user);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !user) return;

    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setSubmitting(true);
    setError(null);

    let oldMasterKey: Uint8Array | undefined;
    let oldAuthKey: Uint8Array | undefined;
    let newMasterKey: Uint8Array | undefined;
    let newAuthKey: Uint8Array | undefined;
    let identityBytes: Uint8Array | undefined;
    let recoveryKey: Uint8Array | undefined;
    let recoveryVerifier: Uint8Array | undefined;

    try {
      // Get current identity keypair from session
      const identity = getIdentity();
      if (!identity) {
        setError('Session expired. Please log out and back in.');
        return;
      }
      identityBytes = serializeIdentity(identity);

      // Derive old keys to authenticate
      const oldSalt = await fetchSalt(user.username);
      const oldDerived = await deriveKeys(currentPassword, oldSalt);
      oldMasterKey = oldDerived.masterKey;
      oldAuthKey = oldDerived.authKey;

      // Derive new keys
      const newSalt = crypto.getRandomValues(new Uint8Array(16));
      const newDerived = await deriveKeys(newPassword, newSalt);
      newMasterKey = newDerived.masterKey;
      newAuthKey = newDerived.authKey;

      // Re-encrypt identity with new master key
      const { ciphertext, iv } = await aesGcmEncrypt(
        newMasterKey,
        identityBytes,
      );

      // Generate new recovery phrase
      const phrase = await generateRecoveryPhrase();
      recoveryKey = await deriveRecoveryKey(phrase);
      const recovery = await encryptRecoveryBundle(recoveryKey, identityBytes);
      recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);

      await changePassword({
        oldAuthKey,
        newAuthKey,
        newSalt,
        newEncryptedKeyBundle: ciphertext,
        newKeyBundleIv: iv,
        newRecoveryEncryptedKeyBundle: recovery.ciphertext,
        newRecoveryKeyBundleIv: recovery.iv,
        newRecoveryVerifier: recoveryVerifier,
      });

      // Update local persistence with new master key
      await persistIdentity(identity, newMasterKey);

      // Show the new recovery phrase
      onRecoveryPhrase(phrase);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to change password.',
      );
    } finally {
      setSubmitting(false);
      oldMasterKey?.fill(0);
      oldAuthKey?.fill(0);
      newMasterKey?.fill(0);
      newAuthKey?.fill(0);
      identityBytes?.fill(0);
      recoveryKey?.fill(0);
      recoveryVerifier?.fill(0);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text transition-colors"
        >
          &larr; Back
        </button>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Change Password
        </h2>
      </div>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* Current password */}
        <div className="relative">
          <input
            type={showCurrent ? 'text' : 'password'}
            className={INPUT_CLASS}
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            disabled={submitting}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
            onClick={() => setShowCurrent(!showCurrent)}
            tabIndex={-1}
          >
            {showCurrent ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        </div>

        {/* New password */}
        <div className="relative">
          <input
            type={showNew ? 'text' : 'password'}
            className={INPUT_CLASS}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
            autoComplete="new-password"
          />
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
            onClick={() => setShowNew(!showNew)}
            tabIndex={-1}
          >
            {showNew ? <EyeSlashIcon size={16} /> : <EyeIcon size={16} />}
          </button>
        </div>

        {/* Confirm new password */}
        <input
          type={showNew ? 'text' : 'password'}
          className={INPUT_CLASS}
          placeholder="Confirm new password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          disabled={submitting}
          autoComplete="new-password"
        />

        {error && (
          <div className="rounded-lg bg-error/10 px-4 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={
            submitting || !currentPassword || !newPassword || !confirmPassword
          }
          className="w-full rounded-lg bg-accent px-5 py-3 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {submitting ? 'Changing...' : 'Change Password'}
        </button>
      </form>
    </div>
  );
}

function RegenerateRecoveryForm({
  onBack,
  onRecoveryPhrase,
}: {
  onBack: () => void;
  onRecoveryPhrase: (phrase: string) => void;
}) {
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const user = useAuthStore((s) => s.user);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || !user) return;

    setSubmitting(true);
    setError(null);

    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;
    let identityBytes: Uint8Array | undefined;
    let recoveryKey: Uint8Array | undefined;
    let recoveryVerifier: Uint8Array | undefined;

    try {
      // Get current identity keypair from session
      const identity = getIdentity();
      if (!identity) {
        setError('Session expired. Please log out and back in.');
        return;
      }
      identityBytes = serializeIdentity(identity);

      // Derive keys from password to authenticate
      const salt = await fetchSalt(user.username);
      const derived = await deriveKeys(password, salt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;

      // Re-encrypt identity with same master key (unchanged)
      const { ciphertext, iv } = await aesGcmEncrypt(masterKey, identityBytes);

      // Generate new recovery phrase
      const phrase = await generateRecoveryPhrase();
      recoveryKey = await deriveRecoveryKey(phrase);
      const recovery = await encryptRecoveryBundle(recoveryKey, identityBytes);
      recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);

      // Use changePassword with same password to update only the recovery bundle
      await changePassword({
        oldAuthKey: authKey,
        newAuthKey: authKey,
        newSalt: salt,
        newEncryptedKeyBundle: ciphertext,
        newKeyBundleIv: iv,
        newRecoveryEncryptedKeyBundle: recovery.ciphertext,
        newRecoveryKeyBundleIv: recovery.iv,
        newRecoveryVerifier: recoveryVerifier,
      });

      onRecoveryPhrase(phrase);
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to regenerate recovery phrase.',
      );
    } finally {
      setSubmitting(false);
      masterKey?.fill(0);
      authKey?.fill(0);
      identityBytes?.fill(0);
      recoveryKey?.fill(0);
      recoveryVerifier?.fill(0);
    }
  }

  return (
    <div className="max-w-md space-y-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text transition-colors"
        >
          &larr; Back
        </button>
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-subtle">
          Regenerate Recovery Phrase
        </h2>
      </div>

      <p className="text-xs text-text-muted">
        Enter your password to generate a new recovery phrase. Your current
        phrase will stop working.
      </p>

      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="relative">
          <input
            type={showPassword ? 'text' : 'password'}
            className={INPUT_CLASS}
            placeholder="Current password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={submitting}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted hover:text-text"
            onClick={() => setShowPassword(!showPassword)}
            tabIndex={-1}
          >
            {showPassword ? (
              <EyeSlashIcon size={16} />
            ) : (
              <EyeIcon size={16} />
            )}
          </button>
        </div>

        {error && (
          <div className="rounded-lg bg-error/10 px-4 py-2.5 text-xs text-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !password}
          className="w-full rounded-lg bg-accent px-5 py-3 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        >
          {submitting ? 'Generating...' : 'Generate New Recovery Phrase'}
        </button>
      </form>
    </div>
  );
}

async function fetchSalt(identifier: string): Promise<Uint8Array> {
  const { getSalt } = await import('@meza/core');
  return getSalt(identifier);
}
