import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only endpoint: lists MusicXML files in public/library so the in-app picker
// can show a shared library. Both the Mac and the phone hit the same dev server,
// so anything dropped into public/library is available on both — no per-device
// file copying. Files themselves are served statically from /library/<name>.
function libraryManifest(): Plugin {
  return {
    name: 'library-manifest',
    configureServer(server) {
      server.middlewares.use('/library-list', (_req, res) => {
        const dir = path.resolve(import.meta.dirname, 'public/library');
        let files: string[] = [];
        try {
          files = fs.readdirSync(dir).filter((f) => /\.(xml|musicxml|mxl)$/i.test(f));
        } catch {
          /* directory may not exist yet */
        }
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(files.sort()));
      });
    },
  };
}

// Mic capture requires a secure context. `host: true` exposes the dev server on
// the LAN; basicSsl serves over HTTPS with a self-signed cert so the phone gets a
// secure context (accept the cert warning once). localhost on the Mac is secure.
export default defineConfig({
  plugins: [react(), basicSsl(), libraryManifest()],
  server: {
    host: true,
    port: 5173,
  },
});
