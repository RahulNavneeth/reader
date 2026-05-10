import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fsApiPlugin } from './server/plugin'

export default defineConfig({
  plugins: [react(), fsApiPlugin()],
  server: {
    port: 5174,
    strictPort: false,
  },
})
