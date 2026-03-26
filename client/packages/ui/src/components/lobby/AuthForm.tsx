import {
  aesGcmEncrypt,
  bootstrapSession,
  clearCryptoStorage,
  createIdentity,
  decryptRecoveryBundle,
  deriveKeys,
  deriveRecoveryKey,
  deriveRecoveryVerifier,
  deserializeIdentity,
  encryptRecoveryBundle,
  finalizeRegistration,
  generateRecoveryPhrase,
  getIdentity,
  getRecoveryBundle,
  getSalt,
  login,
  persistIdentity,
  recoverAccount,
  register,
  registerPublicKey,
  type StoredUser,
  serializeIdentity,
  storeKeyBundle,
  toStoredUser,
  useAuthStore,
  validateRecoveryPhrase,
} from '@meza/core';
import { EyeIcon, EyeSlashIcon } from '@phosphor-icons/react';
import { type InputHTMLAttributes, useCallback, useRef, useState } from 'react';
import { RecoveryPhraseDisplay } from '../shared/RecoveryPhraseDisplay.tsx';

type Mode = 'register' | 'login' | 'recover';

interface DeferredAuth {
  accessToken: string;
  refreshToken: string;
  user: StoredUser;
}

export function AuthForm() {
  const [mode, setMode] = useState<Mode>('register');
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const deferredAuth = useRef<DeferredAuth | null>(null);
  const isLoading = useAuthStore((s) => s.isLoading);
  const serverError = useAuthStore((s) => s.error);

  function switchMode(m: Mode) {
    useAuthStore.getState().setError(null);
    setMode(m);
  }

  const handleRecoveryConfirmed = useCallback(() => {
    // Finalize auth state now that the user has saved their phrase
    if (deferredAuth.current) {
      const { accessToken, refreshToken, user } = deferredAuth.current;
      deferredAuth.current = null;
      finalizeRegistration(accessToken, refreshToken, user);
    }
    setRecoveryPhrase(null);
  }, []);

  if (recoveryPhrase) {
    return (
      <RecoveryPhraseDisplay
        phrase={recoveryPhrase}
        onDone={handleRecoveryConfirmed}
      />
    );
  }

  if (mode === 'recover') {
    return (
      <RecoverAccountForm
        onBack={() => switchMode('login')}
        onRecoveryPhrase={setRecoveryPhrase}
        deferredAuthRef={deferredAuth}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Tab toggle */}
      <div className="flex">
        <button
          type="button"
          disabled={isLoading}
          className={`relative flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
            mode === 'register'
              ? 'text-text'
              : 'text-text-muted hover:text-text'
          } ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={() => switchMode('register')}
        >
          Sign Up
          {mode === 'register' && (
            <span className="absolute bottom-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-full bg-accent" />
          )}
        </button>
        <button
          type="button"
          disabled={isLoading}
          className={`relative flex-1 px-3 py-2 text-xs font-semibold uppercase tracking-wider transition-colors ${
            mode === 'login' ? 'text-text' : 'text-text-muted hover:text-text'
          } ${isLoading ? 'opacity-50 pointer-events-none' : ''}`}
          onClick={() => switchMode('login')}
        >
          Sign In
          {mode === 'login' && (
            <span className="absolute bottom-0 left-1/2 h-0.5 w-8 -translate-x-1/2 rounded-full bg-accent" />
          )}
        </button>
      </div>

      {/* Server error */}
      {serverError && (
        <div className="rounded-lg bg-error/10 px-4 py-2.5 text-xs text-error">
          {serverError}
        </div>
      )}

      {mode === 'register' ? (
        <RegisterForm
          isLoading={isLoading}
          onRecoveryPhrase={setRecoveryPhrase}
          deferredAuthRef={deferredAuth}
        />
      ) : (
        <LoginForm
          isLoading={isLoading}
          onRecover={() => switchMode('recover')}
        />
      )}
    </div>
  );
}

const INPUT_CLASS =
  'w-full border border-border bg-bg-surface text-text placeholder:text-text-muted focus:border-accent focus:outline-none disabled:opacity-50';

const JOINED_INPUT_CLASS =
  'w-full rounded-none bg-bg-surface text-text placeholder:text-text-muted focus:outline-none disabled:opacity-50';

function RegisterForm({
  isLoading,
  onRecoveryPhrase,
  deferredAuthRef,
}: {
  isLoading: boolean;
  onRecoveryPhrase: (phrase: string) => void;
  deferredAuthRef: React.RefObject<DeferredAuth | null>;
}) {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const busy = isLoading || submitting;

  function validate(): boolean {
    const errs: Record<string, string> = {};

    if (!email) {
      errs.email = 'Email is required';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errs.email = 'Invalid email format';
    }

    if (!username) {
      errs.username = 'Username is required';
    } else if (username.length < 3 || username.length > 20) {
      errs.username = 'Username must be 3-20 characters';
    } else if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      errs.username = 'Only letters, numbers, and underscores';
    }

    if (!password) {
      errs.password = 'Password is required';
    } else if (password.length < 8) {
      errs.password = 'Password must be at least 8 characters';
    }

    if (password !== confirmPassword) {
      errs.confirmPassword = 'Passwords do not match';
    }

    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate() || busy) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    setSubmitting(true);
    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;
    let identityBytes: Uint8Array | undefined;
    let recoveryKey: Uint8Array | undefined;
    let recoveryVerifier: Uint8Array | undefined;
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));

      // Two-key derivation: master_key (encrypts identity) + auth_key (sent to server)
      const derived = await deriveKeys(password, salt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;

      // Generate Ed25519 identity keypair and encrypt with master key
      const identity = createIdentity();
      identityBytes = serializeIdentity(identity);
      const { ciphertext, iv } = await aesGcmEncrypt(masterKey, identityBytes);

      // Generate recovery phrase and encrypt identity with recovery key
      const phrase = await generateRecoveryPhrase();
      recoveryKey = await deriveRecoveryKey(phrase);
      const recovery = await encryptRecoveryBundle(recoveryKey, identityBytes);
      recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);

      const res = await register(
        {
          email,
          username,
          authKey,
          salt,
          encryptedKeyBundle: ciphertext,
          keyBundleIv: iv,
          recoveryEncryptedKeyBundle: recovery.ciphertext,
          recoveryKeyBundleIv: recovery.iv,
          recoveryVerifier,
        },
        { deferAuth: true },
      );

      // Clear any stale crypto state from a previous session
      await clearCryptoStorage();

      // Persist identity and bootstrap E2EE session
      await persistIdentity(identity, masterKey);
      const bootstrapped = await bootstrapSession(masterKey);
      if (!bootstrapped) {
        console.error('[RegisterForm] E2EE session bootstrap failed');
        useAuthStore
          .getState()
          .setError('Failed to initialize encryption. Please try logging in.');
        return;
      }

      // Stash auth credentials — they'll be set after the user confirms the phrase
      if (res.user) {
        deferredAuthRef.current = {
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          user: toStoredUser(res.user),
        };
      }

      // Show recovery phrase — auth will be finalized when user confirms
      onRecoveryPhrase(phrase);
    } catch (err) {
      console.error('[RegisterForm] registration failed:', err);
      if (!useAuthStore.getState().error) {
        useAuthStore
          .getState()
          .setError(
            'Unable to reach the server. Please check your connection.',
          );
      }
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
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <div className="overflow-hidden rounded-lg border border-border">
          <input
            type="email"
            className={JOINED_INPUT_CLASS}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <div className="border-t border-border" />
          <input
            type="text"
            className={JOINED_INPUT_CLASS}
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
          <div className="border-t border-border" />
          <PasswordInput
            className={JOINED_INPUT_CLASS}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
          <div className="border-t border-border" />
          <PasswordInput
            className={JOINED_INPUT_CLASS}
            placeholder="Confirm password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        {(errors.email ||
          errors.username ||
          errors.password ||
          errors.confirmPassword) && (
          <p className="mt-1 text-xs text-error">
            {errors.email ||
              errors.username ||
              errors.password ||
              errors.confirmPassword}
          </p>
        )}
      </div>
      <button
        type="submit"
        className="mt-1 w-full rounded-lg bg-accent px-5 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        disabled={busy}
      >
        {busy ? 'Creating account...' : 'Create Account'}
      </button>
    </form>
  );
}

function LoginForm({
  isLoading,
  onRecover,
}: {
  isLoading: boolean;
  onRecover: () => void;
}) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const busy = isLoading || submitting;

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!identifier) errs.identifier = 'Email or username is required';
    if (!password) errs.password = 'Password is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate() || busy) return;

    // Dismiss the keyboard before async work begins — prevents it from
    // lingering after the auth form unmounts on successful login.
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    setSubmitting(true);
    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;
    try {
      const salt = await getSalt(identifier);

      // Two-key derivation: master_key (decrypts key bundle) + auth_key (sent to server)
      const derived = await deriveKeys(password, salt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;
      const res = await login(identifier, authKey);

      // Store encrypted key bundle from server locally and bootstrap E2EE session
      if (res?.encryptedKeyBundle?.length && res?.keyBundleIv?.length) {
        // Pack as [12B iv][ciphertext] — same format persistIdentity uses
        const packed = new Uint8Array(12 + res.encryptedKeyBundle.length);
        packed.set(res.keyBundleIv, 0);
        packed.set(res.encryptedKeyBundle, 12);
        await storeKeyBundle(packed);
        const bootstrapped = await bootstrapSession(masterKey);
        if (!bootstrapped) {
          console.error('[LoginForm] E2EE session bootstrap failed');
          useAuthStore.getState().clearAuth();
          useAuthStore
            .getState()
            .setError('Failed to initialize encryption. Please try again.');
          return;
        }
        // Register public key so other users can encrypt for us
        const id = getIdentity();
        if (id) registerPublicKey(id.publicKey).catch(() => {});
      } else {
        // Server didn't return key bundle — can't establish E2EE session
        console.error('[LoginForm] Login response missing key bundle');
        useAuthStore.getState().clearAuth();
        useAuthStore
          .getState()
          .setError('Login failed: missing encryption data. Please try again.');
        return;
      }
    } catch (err) {
      console.error('[LoginForm] login failed:', err);
      // getSalt() doesn't set the store error — surface it here
      if (!useAuthStore.getState().error) {
        useAuthStore
          .getState()
          .setError(
            'Unable to reach the server. Please check your connection.',
          );
      }
    } finally {
      setSubmitting(false);
      masterKey?.fill(0);
      authKey?.fill(0);
    }
  }

  return (
    <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <div className="overflow-hidden rounded-lg border border-border">
          <input
            type="text"
            className={JOINED_INPUT_CLASS}
            placeholder="Email or username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            disabled={busy}
          />
          <div className="border-t border-border" />
          <PasswordInput
            className={JOINED_INPUT_CLASS}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </div>
        {(errors.identifier || errors.password) && (
          <p className="mt-1 text-xs text-error">
            {errors.identifier || errors.password}
          </p>
        )}
      </div>
      <button
        type="submit"
        className="mt-1 w-full rounded-lg bg-accent px-5 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
        disabled={busy}
      >
        {busy ? 'Signing in...' : 'Sign In'}
      </button>
      <button
        type="button"
        onClick={onRecover}
        className="w-full text-xs text-text-muted hover:text-text transition-colors"
      >
        Forgot password? Recover with recovery phrase
      </button>
    </form>
  );
}

function RecoverAccountForm({
  onBack,
  onRecoveryPhrase,
  deferredAuthRef,
}: {
  onBack: () => void;
  onRecoveryPhrase: (phrase: string) => void;
  deferredAuthRef: React.RefObject<DeferredAuth | null>;
}) {
  const [email, setEmail] = useState('');
  const [phrase, setPhrase] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  function validate(): boolean {
    const errs: Record<string, string> = {};
    if (!email) errs.email = 'Email is required';
    if (!phrase.trim()) errs.phrase = 'Recovery phrase is required';
    if (!newPassword) {
      errs.newPassword = 'New password is required';
    } else if (newPassword.length < 8) {
      errs.newPassword = 'Password must be at least 8 characters';
    }
    if (newPassword !== confirmPassword) {
      errs.confirmPassword = 'Passwords do not match';
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!validate() || submitting) return;

    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    setSubmitting(true);
    setFormError(null);

    let recoveryKey: Uint8Array | undefined;
    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;
    let keyBundle: Uint8Array | undefined;
    let newRecoveryKey: Uint8Array | undefined;
    let recoveryVerifier: Uint8Array | undefined;
    let newRecoveryVerifier: Uint8Array | undefined;
    try {
      // Validate phrase
      const valid = await validateRecoveryPhrase(phrase);
      if (!valid) {
        setErrors({ phrase: 'Invalid recovery phrase' });
        return;
      }

      // Fetch recovery bundle from server
      const bundle = await getRecoveryBundle(email);

      // Derive recovery key and decrypt the key bundle
      recoveryKey = await deriveRecoveryKey(phrase);
      keyBundle = await decryptRecoveryBundle(
        recoveryKey,
        bundle.recoveryEncryptedKeyBundle,
        bundle.recoveryKeyBundleIv,
      );

      // Derive verifier from the old recovery key to prove phrase knowledge
      recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);

      // Derive new credentials from new password
      const newSalt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await deriveKeys(newPassword, newSalt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;

      // Re-encrypt key bundle with new master key
      const { ciphertext, iv } = await aesGcmEncrypt(masterKey, keyBundle);

      // Generate new recovery phrase and encrypt with it
      const newPhrase = await generateRecoveryPhrase();
      newRecoveryKey = await deriveRecoveryKey(newPhrase);
      const newRecovery = await encryptRecoveryBundle(
        newRecoveryKey,
        keyBundle,
      );
      newRecoveryVerifier = await deriveRecoveryVerifier(newRecoveryKey);

      // Submit recovery to server (resets credentials + returns session)
      const res = await recoverAccount(
        {
          email,
          newAuthKey: authKey,
          newSalt,
          newEncryptedKeyBundle: ciphertext,
          newKeyBundleIv: iv,
          newRecoveryEncryptedKeyBundle: newRecovery.ciphertext,
          newRecoveryKeyBundleIv: newRecovery.iv,
          recoveryVerifier,
          newRecoveryVerifier,
        },
        { deferAuth: true },
      );

      // Bootstrap E2EE session with recovered key bundle
      if (res) {
        await clearCryptoStorage();
        const identity = deserializeIdentity(keyBundle);
        await persistIdentity(identity, masterKey);
        const bootstrapped = await bootstrapSession(masterKey);
        if (!bootstrapped) {
          // Don't block — the user MUST save the new recovery phrase.
          // The old phrase is already invalidated on the server.
          // They can log in manually after, which will re-attempt bootstrap.
          console.error(
            '[RecoverForm] E2EE session bootstrap failed — proceeding to show phrase',
          );
        }

        // Stash auth credentials — they'll be set after the user confirms the new phrase
        if (res.user) {
          deferredAuthRef.current = {
            accessToken: res.accessToken,
            refreshToken: res.refreshToken,
            user: toStoredUser(res.user),
          };
        }
      }

      // Show new recovery phrase
      onRecoveryPhrase(newPhrase);
    } catch (err) {
      setFormError(
        err instanceof Error && err.message
          ? err.message
          : 'Recovery failed. Please check your phrase and try again.',
      );
    } finally {
      setSubmitting(false);
      recoveryKey?.fill(0);
      masterKey?.fill(0);
      authKey?.fill(0);
      keyBundle?.fill(0);
      newRecoveryKey?.fill(0);
      recoveryVerifier?.fill(0);
      newRecoveryVerifier?.fill(0);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-text-muted hover:text-text transition-colors"
        >
          &larr; Back
        </button>
        <h3 className="text-sm font-semibold text-text">Recover Account</h3>
      </div>
      <p className="text-xs text-text-muted">
        Enter your recovery phrase and set a new password to regain access to
        your account and encrypted messages.
      </p>
      {formError && (
        <div className="rounded-lg bg-error/10 px-4 py-2.5 text-xs text-error">
          {formError}
        </div>
      )}
      <form noValidate onSubmit={handleSubmit} className="flex flex-col gap-3">
        <div>
          <input
            type="email"
            className={INPUT_CLASS}
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={submitting}
          />
          {errors.email && (
            <p className="mt-1 text-xs text-error">{errors.email}</p>
          )}
        </div>
        <div>
          <textarea
            className={`${INPUT_CLASS} resize-none`}
            placeholder="Enter your 12-word recovery phrase"
            rows={3}
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
            disabled={submitting}
          />
          {errors.phrase && (
            <p className="mt-1 text-xs text-error">{errors.phrase}</p>
          )}
        </div>
        <div>
          <PasswordInput
            className={INPUT_CLASS}
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            disabled={submitting}
          />
          {errors.newPassword && (
            <p className="mt-1 text-xs text-error">{errors.newPassword}</p>
          )}
        </div>
        <div>
          <PasswordInput
            className={INPUT_CLASS}
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            disabled={submitting}
          />
          {errors.confirmPassword && (
            <p className="mt-1 text-xs text-error">{errors.confirmPassword}</p>
          )}
        </div>
        <button
          type="submit"
          className="mt-1 w-full rounded-lg bg-accent px-5 py-3.5 text-sm font-medium text-black transition-colors hover:bg-accent-hover disabled:opacity-50"
          disabled={submitting}
        >
          {submitting ? 'Recovering...' : 'Recover Account'}
        </button>
      </form>
    </div>
  );
}

function PasswordInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        {...props}
        type={visible ? 'text' : 'password'}
        className={className}
      />
      <button
        type="button"
        tabIndex={-1}
        onClick={() => setVisible((v) => !v)}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text transition-colors"
        aria-label={visible ? 'Hide password' : 'Show password'}
      >
        {visible ? (
          <EyeSlashIcon size={16} aria-hidden="true" />
        ) : (
          <EyeIcon size={16} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
