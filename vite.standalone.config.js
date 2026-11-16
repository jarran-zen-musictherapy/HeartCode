import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import pkg from './package.json' with { type: 'json' }
import { viteSingleFile } from 'vite-plugin-singlefile'

// One self-contained HTML file: open it by double-click, no server or Node needed.
export default defineConfig({
  base: './',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [react(), viteSingleFile()],
  build: { outDir: 'standalone', emptyOutDir: true },
})
