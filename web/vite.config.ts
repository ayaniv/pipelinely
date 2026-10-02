import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// root: web/ so index.html and src/ resolve relative to this workspace, not
// wherever the build was invoked from — build:web can run from the repo
// root (npm workspace scripts don't change cwd). build.outDir points at
// public/dist (outside this root), which is why emptyOutDir is explicit —
// Vite refuses an outDir outside root by default otherwise. server.ts
// serves that directory's assets/ and index.html verbatim; see
// tech-design.md's "Build and serve" step.
export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: '../public/dist',
    emptyOutDir: true,
  },
})
