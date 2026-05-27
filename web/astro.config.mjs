import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import mdx from '@astrojs/mdx';
import tailwind from '@astrojs/tailwind';

// Cartograph web — Astro host with React islands.
// Dev proxies /api/* to the FastAPI status server on :47777.
export default defineConfig({
  site: 'http://localhost:47777',
  output: 'static',
  trailingSlash: 'ignore',
  integrations: [
    react(),
    mdx(),
    tailwind({ applyBaseStyles: false }),
  ],
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:47777',
          changeOrigin: true,
        },
      },
    },
  },
});
