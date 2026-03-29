import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://meza.chat',
  output: 'static',
  integrations: [sitemap(), react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
