/**
 * Shared design tokens for Meza.
 *
 * These tokens are the single source of truth for colors, typography, spacing,
 * and radii across web (Tailwind v4) and mobile (Tailwind v3 + NativeWind).
 *
 * Web uses these values via CSS custom properties in index.css.
 * Mobile imports this file in tailwind.config.js.
 */

/** @type {Record<string, string>} */
const colors = {
  // Background layers (dark theme, ascending lightness)
  'bg-base': 'oklch(0.18 0 0)',
  'bg-surface': 'oklch(0.22 0 0)',
  'bg-elevated': 'oklch(0.26 0 0)',
  'bg-overlay': 'oklch(0.17 0 0)',

  // Mint accent scale
  accent: 'oklch(0.9 0.17 157)',
  'accent-hover': 'oklch(0.93 0.14 157)',
  'accent-muted': 'oklch(0.65 0.11 157)',
  'accent-subtle': 'oklch(0.35 0.05 157)',

  // Text
  text: 'oklch(0.93 0 0)',
  'text-muted': 'oklch(0.65 0 0)',
  'text-subtle': 'oklch(0.45 0 0)',

  // Borders
  border: 'oklch(0.3 0 0)',
  'border-hover': 'oklch(0.4 0 0)',

  // Focus ring
  focus: 'oklch(0.9 0.17 157)',

  // Semantic
  success: 'oklch(0.7 0.15 157)',
  warning: 'oklch(0.75 0.15 85)',
  error: 'oklch(0.65 0.2 25)',
  info: 'oklch(0.7 0.12 230)',

  // Essentials
  white: '#ffffff',
  black: '#000000',
  transparent: 'transparent',
};

/** @type {Record<string, string>} */
const fontSize = {
  xs: '0.75rem',
  sm: '0.8125rem',
  base: '0.875rem',
  lg: '1rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
};

/** @type {Record<string, string>} */
const borderRadius = {
  xs: '4px',
  sm: '6px',
  md: '10px',
  lg: '14px',
  xl: '20px',
  full: '9999px',
};

/** @type {Record<string, string>} */
const fontFamily = {
  sans: ['System', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
  mono: ['monospace'],
};

module.exports = { colors, fontSize, borderRadius, fontFamily };
