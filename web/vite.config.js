import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true, // Mendukung akses dari HP melalui jaringan IP lokal
    port: 5173,
    open: false
  }
});
