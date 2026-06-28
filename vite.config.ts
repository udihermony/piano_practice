import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Mic capture requires a secure context. `host: true` exposes the dev server on
// the LAN; basicSsl serves it over HTTPS with a self-signed cert so the phone gets
// a secure context (accept the cert warning once) — no Chrome insecure-origin flag
// needed. localhost on the Mac is already a secure context.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5173,
  },
});
