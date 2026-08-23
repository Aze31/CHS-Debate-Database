import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

type SpeechdropFile = { id: string; name: string; size: number; uploadedAt: number; data: string }
type SpeechdropRound = { name: string; expiresAt: number; files: SpeechdropFile[] }

const speechdropRounds = new Map<string, SpeechdropRound>()

function readJson(request: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString() })
    request.on('end', () => {
      try { resolve(JSON.parse(body) as Record<string, string>) } catch { reject(new Error('Invalid JSON request.')) }
    })
    request.on('error', reject)
  })
}

function speechdropApi(): Plugin {
  return {
    name: 'speechdrop-api',
    configureServer(server) {
      server.middlewares.use('/api/speechdrop', async (request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const parts = path.split('/').filter(Boolean)
        const code = parts[1]?.toUpperCase()
        const round = code ? speechdropRounds.get(code) : undefined

        for (const [storedCode, storedRound] of speechdropRounds) {
          if (storedRound.expiresAt <= Date.now()) speechdropRounds.delete(storedCode)
        }

        const sendJson = (status: number, payload: unknown) => {
          response.statusCode = status
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify(payload))
        }

        try {
          if (request.method === 'POST' && parts.length === 1) {
            const body = await readJson(request)
            const name = body.name?.trim()
            if (!name) return sendJson(400, { error: 'A round name is required.' })
            let newCode = ''
            do { newCode = randomBytes(4).toString('hex').slice(0, 6).toUpperCase() } while (speechdropRounds.has(newCode))
            const newRound = { name, expiresAt: Date.now() + 60 * 60 * 1000, files: [] }
            speechdropRounds.set(newCode, newRound)
            return sendJson(201, { code: newCode, name, expiresAt: newRound.expiresAt })
          }

          if (!round || !code) return sendJson(404, { error: 'That round code is missing or expired.' })
          if (request.method === 'GET' && parts.length === 2) {
            return sendJson(200, { code, name: round.name, expiresAt: round.expiresAt, files: round.files.map(({ data, ...file }) => file) })
          }
          if (request.method === 'POST' && parts.length === 3 && parts[2] === 'files') {
            const body = await readJson(request)
            if (!body.name || body.type !== 'application/pdf' || !body.data) return sendJson(400, { error: 'Only PDF files are accepted.' })
            const data = body.data.replace(/^data:application\/pdf;base64,/, '')
            const size = Buffer.byteLength(data, 'base64')
            if (size > 25 * 1024 * 1024) return sendJson(413, { error: 'PDF files must be 25 MB or smaller.' })
            const file = { id: randomBytes(8).toString('hex'), name: body.name, size, uploadedAt: Date.now(), data }
            round.files.push(file)
            return sendJson(201, { id: file.id, name: file.name, size: file.size, uploadedAt: file.uploadedAt })
          }
          if (request.method === 'GET' && parts.length === 4 && parts[2] === 'files') {
            const file = round.files.find((item) => item.id === parts[3])
            if (!file) return sendJson(404, { error: 'File not found.' })
            response.setHeader('Content-Type', 'application/pdf')
            response.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`)
            return response.end(Buffer.from(file.data, 'base64'))
          }
          return sendJson(404, { error: 'Speechdrop endpoint not found.' })
        } catch (error) {
          return sendJson(400, { error: error instanceof Error ? error.message : 'Speechdrop request failed.' })
        }
      })
    },
  }
}

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
  plugins: [react(), tabroomProxy(), speechdropApi()],
})
