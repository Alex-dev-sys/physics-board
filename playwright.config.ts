import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  use: { baseURL: 'http://localhost:3000', viewport: { width: 1500, height: 1100 } },
  webServer: [
    { command: 'npm run dev -- --port 3000', url: 'http://localhost:3000', timeout: 120000, reuseExistingServer: true },
    { command: 'npm run sync:dev', url: 'http://127.0.0.1:5858/health', timeout: 30000, reuseExistingServer: true },
  ],
})


