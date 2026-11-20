import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // KANNAKU_API points a second dev copy at another API server (e.g. a separate preview database).
    proxy: { '/api': process.env.KANNAKU_API ?? 'http://127.0.0.1:4000' },
  },
});
