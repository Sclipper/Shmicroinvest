import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.WEB_PORT ?? 5173),
    allowedHosts: true,
    proxy: { '/api': `http://localhost:${process.env.API_PORT ?? 3000}` },
  },
});
