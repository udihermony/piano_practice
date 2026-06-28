import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mic capture requires a secure context. `host: true` exposes the dev server on
// the LAN so the phone can reach it; see HANDOFF.md for the Chrome insecure-origin
// flag needed for plain-HTTP LAN testing (or add mkcert for real HTTPS later).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
  },
});
