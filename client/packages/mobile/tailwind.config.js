const { colors, fontSize, borderRadius, fontFamily } = require('@meza/tailwind-config');

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  presets: [require('nativewind/preset')],
  theme: {
    colors,
    fontSize,
    borderRadius,
    fontFamily,
  },
  plugins: [],
};
