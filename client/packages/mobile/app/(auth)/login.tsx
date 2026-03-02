import {
  bootstrapSession,
  deriveKeys,
  getIdentity,
  getSalt,
  login,
  registerPublicKey,
  storeKeyBundle,
  useAuthStore,
} from '@meza/core';
import { Link } from 'expo-router';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  Text,
  TextInput,
  View,
} from 'react-native';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isLoading = useAuthStore((s) => s.isLoading);
  const serverError = useAuthStore((s) => s.error);

  async function handleLogin() {
    if (!email || !password || isLoading) return;

    setError(null);
    let masterKey: Uint8Array | undefined;
    let authKey: Uint8Array | undefined;

    try {
      const salt = await getSalt(email);
      if (!salt || salt.length === 0) {
        setError('Account not found');
        return;
      }

      const derived = await deriveKeys(password, salt);
      masterKey = derived.masterKey;
      authKey = derived.authKey;

      const res = await login(email, authKey);

      // Store encrypted key bundle and bootstrap E2EE session
      if (res?.encryptedKeyBundle?.length && res?.keyBundleIv?.length) {
        const packed = new Uint8Array(12 + res.encryptedKeyBundle.length);
        packed.set(res.keyBundleIv, 0);
        packed.set(res.encryptedKeyBundle, 12);
        await storeKeyBundle(packed);
        await bootstrapSession(masterKey);

        const id = getIdentity();
        if (id) registerPublicKey(id.publicKey).catch(() => {});
      }
    } catch {
      // Error set in auth store
    } finally {
      masterKey?.fill(0);
      authKey?.fill(0);
    }
  }

  const displayError = error || serverError;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      className="flex-1 bg-bg-base"
    >
      <View className="flex-1 justify-center px-6">
        <Text className="mb-2 text-center text-3xl font-bold text-text">
          Meza
        </Text>
        <Text className="mb-8 text-center text-sm text-text-muted">
          Sign in to your account
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
            placeholder="Password"
            placeholderTextColor="#888"
            value={password}
            onChangeText={setPassword}
            secureTextEntry
            autoComplete="password"
            editable={!isLoading}
          />
        </View>

        <Pressable
          onPress={handleLogin}
          disabled={isLoading}
          className="mb-4 items-center rounded-lg bg-accent py-3.5 active:bg-accent-hover disabled:opacity-50"
        >
          {isLoading ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text className="text-sm font-medium text-black">Sign In</Text>
          )}
        </Pressable>

        <Link href="/(auth)/register" asChild>
          <Pressable>
            <Text className="text-center text-xs text-text-muted">
              Don't have an account?{' '}
              <Text className="text-accent">Sign Up</Text>
            </Text>
          </Pressable>
        </Link>
      </View>
    </KeyboardAvoidingView>
  );
}
