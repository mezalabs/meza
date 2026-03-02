import {
  listDevices,
  logout,
  MEZA_VERSION,
  useAuthStore,
  useGatewayStore,
  type Device,
} from '@meza/core';
import { useEffect, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View,
} from 'react-native';
import {
  disableBiometricLock,
  enableBiometricLock,
  isBiometricLockEnabled,
} from '@/lib/biometric-lock';

export default function SettingsScreen() {
  const user = useAuthStore((s) => s.user);
  const gatewayStatus = useGatewayStore((s) => s.status);
  const [biometricEnabled, setBiometricEnabled] = useState(false);
  const [devices, setDevices] = useState<Device[]>([]);

  useEffect(() => {
    isBiometricLockEnabled().then(setBiometricEnabled);
    listDevices()
      .then(setDevices)
      .catch(() => {});
  }, []);

  async function toggleBiometric(value: boolean) {
    if (value) {
      // Need master key from sessionStorage to store securely
      const masterKeyHex = globalThis.sessionStorage?.getItem('meza_master_key');
      if (!masterKeyHex) {
        Alert.alert(
          'Cannot Enable',
          'Master key not available. Please log in again to enable biometric lock.',
        );
        return;
      }
      const bytes = new Uint8Array(masterKeyHex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Number.parseInt(masterKeyHex.slice(i * 2, i * 2 + 2), 16);
      }
      const ok = await enableBiometricLock(bytes);
      bytes.fill(0);
      if (!ok) {
        Alert.alert(
          'Not Available',
          'Biometric authentication is not available on this device.',
        );
        return;
      }
      setBiometricEnabled(true);
    } else {
      await disableBiometricLock();
      setBiometricEnabled(false);
    }
  }

  return (
    <ScrollView className="flex-1 bg-bg-base">
      <View className="px-4 pt-14">
        <Text className="mb-6 text-xl font-bold text-text">Settings</Text>

        {/* User info */}
        <View className="mb-4 rounded-lg border border-border bg-bg-surface p-4">
          <Text className="text-base font-medium text-text">
            {user?.displayName || user?.username || 'Unknown'}
          </Text>
          <Text className="mt-1 text-sm text-text-muted">
            @{user?.username}
          </Text>
        </View>

        {/* Gateway status */}
        <View className="mb-4 rounded-lg border border-border bg-bg-surface p-4">
          <Text className="text-xs text-text-muted">
            Gateway:{' '}
            <Text
              className={
                gatewayStatus === 'connected' ? 'text-success' : 'text-warning'
              }
            >
              {gatewayStatus}
            </Text>
          </Text>
        </View>

        {/* Security section */}
        <Text className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-text-muted">
          Security
        </Text>

        <View className="mb-4 rounded-lg border border-border bg-bg-surface">
          {/* Biometric lock */}
          <View className="flex-row items-center justify-between px-4 py-3">
            <View className="flex-1">
              <Text className="text-sm text-text">Biometric Lock</Text>
              <Text className="mt-0.5 text-xs text-text-muted">
                Require Face ID or fingerprint to open the app
              </Text>
            </View>
            <Switch
              value={biometricEnabled}
              onValueChange={toggleBiometric}
              trackColor={{ true: '#4ade80' }}
            />
          </View>

          {/* Active devices */}
          {devices.length > 0 && (
            <>
              <View className="h-px bg-border" />
              <View className="px-4 py-3">
                <Text className="text-sm text-text">Active Devices</Text>
                {devices.map((d) => (
                  <Text key={d.id} className="mt-1 text-xs text-text-muted">
                    {d.name || 'Unknown device'} ({d.platform})
                  </Text>
                ))}
              </View>
            </>
          )}
        </View>

        {/* About section */}
        <Text className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wider text-text-muted">
          About
        </Text>

        <View className="mb-4 rounded-lg border border-border bg-bg-surface px-4 py-3">
          <Text className="text-sm text-text">Meza Chat</Text>
          <Text className="mt-0.5 text-xs text-text-muted">
            Version {MEZA_VERSION} (Mobile)
          </Text>
          <Text className="mt-0.5 text-xs text-text-muted">
            End-to-end encrypted messaging
          </Text>
        </View>

        {/* Logout */}
        <Pressable
          onPress={() =>
            Alert.alert('Sign Out', 'Are you sure you want to sign out?', [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Sign Out',
                style: 'destructive',
                onPress: () => logout(),
              },
            ])
          }
          className="mb-12 items-center rounded-lg border border-error py-3 active:bg-error/10"
        >
          <Text className="text-sm font-medium text-error">Sign Out</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}
