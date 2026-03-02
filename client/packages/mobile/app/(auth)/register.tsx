import {
  aesGcmEncrypt,
  bootstrapSession,
  clearCryptoStorage,
  createIdentity,
  deriveKeys,
  deriveRecoveryKey,
  encryptRecoveryBundle,
  finalizeRegistration,
  generateRecoveryPhrase,
  persistIdentity,
  register,
  serializeIdentity,
  type StoredUser,
  toStoredUser,
  useAuthStore,
} from '@meza/core';
import { Link, router } from 'expo-router';
import { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';

interface DeferredAuth {
  accessToken: string;
  refreshToken: string;
  user: StoredUser;
}

export default function RegisterScreen() {
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryPhrase, setRecoveryPhrase] = useState<string | null>(null);
  const deferredAuth = useRef<DeferredAuth | null>(null);
  const isLoading = useAuthStore((s) => s.isLoading);
  const serverError = useAuthStore((s) => s.error);

  function validate(): string | null {
    if (!email) return 'Email is required';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Invalid email';
    if (!username) return 'Username is required';
    if (username.length < 3 || username.length > 20)
      return 'Username must be 3-20 characters';
    if (!/^[a-zA-Z0-9_]+$/.test(username))
      return 'Only letters, numbers, and underscores';
    if (!password) return 'Password is required';
    if (password.length < 8) return 'Password must be at least 8 characters';
    if (password !== confirmPassword) return 'Passwords do not match';
    return null;
  }

  async function handleRegister() {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (isLoading) return;

    setError(null);
    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;
    let identityBytes: Uint8Array | undefined;
    let recoveryKey: Uint8Array | undefined;

    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const derived = await deriveKeys(password, salt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;

      const identity = createIdentity();
      identityBytes = serializeIdentity(identity);
      const { ciphertext, iv } = await aesGcmEncrypt(masterKey, identityBytes);

      const phrase = await generateRecoveryPhrase();
      recoveryKey = await deriveRecoveryKey(phrase);
      const recovery = await encryptRecoveryBundle(recoveryKey, identityBytes);

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
        },
        { deferAuth: true },
      );

      await clearCryptoStorage();
      await persistIdentity(identity, masterKey);
      await bootstrapSession(masterKey);

      if (res.user) {
        deferredAuth.current = {
          accessToken: res.accessToken,
          refreshToken: res.refreshToken,
          user: toStoredUser(res.user),
        };
      }

      setRecoveryPhrase(phrase);
    } catch {
      // Error set in auth store
    } finally {
      masterKey?.fill(0);
      authKey?.fill(0);
      identityBytes?.fill(0);
      recoveryKey?.fill(0);
    }
  }

  function handleRecoveryConfirmed() {
    if (deferredAuth.current) {
      const { accessToken, refreshToken, user } = deferredAuth.current;
      deferredAuth.current = null;
      finalizeRegistration(accessToken, refreshToken, user);
    }
    setRecoveryPhrase(null);
    // Auth state is now set — root layout will redirect to (app)
  }

  if (recoveryPhrase) {
    return (
      <RecoveryPhraseDisplay
        phrase={recoveryPhrase}
        onDone={handleRecoveryConfirmed}
      />
    );
  }

  const displayError = error || serverError;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-bg-base"
    >
      <ScrollView
        contentContainerClassName="flex-grow justify-center px-6 py-12"
        keyboardShouldPersistTaps="handled"
      >
        <Text className="mb-2 text-center text-3xl font-bold text-text">
          Meza
        </Text>
        <Text className="mb-8 text-center text-sm text-text-muted">
          Create your account
        </Text>

        {displayError && (
          <View className="mb-4 rounded-lg bg-error/10 px-4 py-3">
            <Text className="text-xs text-error">{displayError}</Text>
          </View>
        )}

        <View className="mb-4 overflow-hidden rounded-lg border border-border">
          <TextInput
            className="bg-bg-surface px-4 py-3.5 text-sm text-text"
            placeholder="Email"
            placeholderTextColor="#888"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoComplete="email"
            keyboardType="email-address"
            editable={!isLoading}
          />
          <View className="h-px bg-border" />
          <TextInput
            className="bg-bg-surface px-4 py-3.5 text-sm text-text"
            placeholder="Username"
            placeholderTextColor="#888"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoComplete="username-new"
            editable={!isLoading}
          />
          <View className="h-px bg-border" />
          <TextInput
            className="bg-bg-surface px-4 py-3.5 text-sm text-text"
            placeholder="Password"
            placeholderTextColor="#888"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password-new"
            editable={!isLoading}
          />
          <View className="h-px bg-border" />
          <TextInput
            className="bg-bg-surface px-4 py-3.5 text-sm text-text"
            placeholder="Confirm password"
            placeholderTextColor="#888"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            secureTextEntry
            editable={!isLoading}
          />
        </View>

        <Pressable
          onPress={handleRegister}
          disabled={isLoading}
          className="mb-4 items-center rounded-lg bg-accent py-3.5 active:bg-accent-hover disabled:opacity-50"
        >
          {isLoading ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text className="text-sm font-medium text-black">
              Create Account
            </Text>
          )}
        </Pressable>

        <Link href="/(auth)/login" asChild>
          <Pressable>
            <Text className="text-center text-xs text-text-muted">
              Already have an account?{' '}
              <Text className="text-accent">Sign In</Text>
            </Text>
          </Pressable>
        </Link>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function RecoveryPhraseDisplay({
  phrase,
  onDone,
}: {
  phrase: string;
  onDone: () => void;
}) {
  const words = phrase.split(' ');
  const [confirmed, setConfirmed] = useState(false);

  return (
    <View className="flex-1 justify-center bg-bg-base px-6">
      <Text className="mb-2 text-lg font-semibold text-text">
        Recovery Phrase
      </Text>
      <Text className="mb-6 text-xs text-text-muted">
        Write down these 12 words and store them safely. This is the only way to
        recover your encrypted messages if you lose your password.
      </Text>

      <View className="mb-6 flex-row flex-wrap rounded-lg border border-border bg-bg-surface p-4">
        {words.map((word, i) => (
          <View key={`${i}-${word}`} className="w-1/3 items-center py-2">
            <Text className="font-mono text-sm text-text">
              {i + 1}. {word}
            </Text>
          </View>
        ))}
      </View>

      <Pressable
        onPress={() => setConfirmed(!confirmed)}
        className="mb-4 flex-row items-center gap-3"
      >
        <View
          className={`h-5 w-5 items-center justify-center rounded border ${
            confirmed
              ? 'border-accent bg-accent'
              : 'border-border bg-bg-surface'
          }`}
        >
          {confirmed && (
            <Text className="text-xs font-bold text-black">✓</Text>
          )}
        </View>
        <Text className="flex-1 text-xs text-text-muted">
          I have saved my recovery phrase in a safe place
        </Text>
      </Pressable>

      <Pressable
        onPress={onDone}
        disabled={!confirmed}
        className="items-center rounded-lg bg-accent py-3.5 active:bg-accent-hover disabled:opacity-50"
      >
        <Text className="text-sm font-medium text-black">Continue</Text>
      </Pressable>
    </View>
  );
}
