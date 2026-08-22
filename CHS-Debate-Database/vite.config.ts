import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function tabroomProxy(): Plugin {
  return {
    name: 'tabroom-search-proxy',
    configureServer(server) {
      server.middlewares.use('/api/tournaments', async (request, response) => {
        const query = new URL(request.url ?? '/', 'http://localhost').searchParams.get('year') ?? String(new Date().getFullYear())
        const body = new URLSearchParams({ tourn_id: '', caller: '/index/index.mhtml', search: query })

        try {
          const tabroomResponse = await fetch('https://www.tabroom.com/index/search.mhtml', {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'Tabroom API v1' },
            body,
          })
          if (!tabroomResponse.ok) throw new Error(`Tabroom returned ${tabroomResponse.status} ${tabroomResponse.statusText}`)
          response.setHeader('Content-Type', 'text/html; charset=utf-8')
          response.end(await tabroomResponse.text())
        } catch (error) {
          response.statusCode = 502
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unable to reach Tabroom.' }))
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tabroomProxy()],
})
