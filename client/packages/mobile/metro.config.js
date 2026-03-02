const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Watch workspace packages for hot reload
config.watchFolders = [
  path.resolve(monorepoRoot, 'packages/core'),
  path.resolve(monorepoRoot, 'packages/tailwind-config'),
  path.resolve(monorepoRoot, 'gen'),
];

// Enable pnpm symlink resolution
config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

// Resolution order: app-local → monorepo root → pnpm virtual store
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(monorepoRoot, 'node_modules'),
];

// Pin singletons to prevent "Invalid hook call" and duplicate provider errors
const SINGLETONS = [
  'react',
  'react-native',
  'expo',
  'expo-router',
  'expo-modules-core',
  'expo-constants',
  '@expo/metro-runtime',
];
config.resolver.extraNodeModules = Object.fromEntries(
  SINGLETONS.map((name) => [
    name,
    path.resolve(projectRoot, 'node_modules', name),
  ]),
);

module.exports = withNativeWind(config, { input: './global.css' });
