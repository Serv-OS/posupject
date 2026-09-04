import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// PREVIEW_STUB=1 swaps the Supabase client and the timer for in-memory stubs so
// the design harness (preview-mobile.html) renders the real components with
// seeded data and no network. Never set in a real build.
const stubAlias = process.env.PREVIEW_STUB ? [
  { find: /^(.*)\/lib\/supabase(\.js)?$/, replacement: path.resolve(__dirname, 'src/__preview__/stub.js') },
  // lib modules import their sibling as './supabase'
  { find: /^\.\/supabase(\.js)?$/, replacement: path.resolve(__dirname, 'src/__preview__/stub.js') },
  { find: /^(.*)\/lib\/timer(\.js)?$/, replacement: path.resolve(__dirname, 'src/__preview__/timerStub.js') },
] : [];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: stubAlias },
  server: { port: 5173 },
});
