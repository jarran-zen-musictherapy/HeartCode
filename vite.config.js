import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' so the build works from any path (GitHub Pages project sites included)
export default defineConfig({
  base: './',
  plugins: [react()],
})
