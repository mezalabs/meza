/**
 * Crypto polyfill for React Native.
 *
 * Replaces the browser's `crypto.subtle` and `crypto.getRandomValues` with
 * native C++ implementations from react-native-quick-crypto.
 *
 * MUST be imported BEFORE any @meza/core imports that use crypto.
 */
import { install } from 'react-native-quick-crypto';

install();
