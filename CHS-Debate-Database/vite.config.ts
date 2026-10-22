import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'

type SpeechdropFile = { id: string; name: string; size: number; uploadedAt: number; data: string }
type SpeechdropRound = { name: string; expiresAt: number; files: SpeechdropFile[] }

const speechdropRounds = new Map<string, SpeechdropRound>()
const NSDA_API_ORIGIN = 'https://api.speechanddebate.org/v2/'

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

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  response.statusCode = status
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify(payload))
}

type NSDAApiCredentials = { username: string; password: string }
type NSDAEventPoints = { student_id?: number | null; category_id?: number | null; wins?: number | null; losses?: number | null; nodecisions?: number | null; points?: number | null }

class NSDAApiError extends Error {
  readonly statusCode: number

  constructor(message: string, statusCode: number) {
    super(message)
    this.statusCode = statusCode
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function readText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

async function fetchNsdaJson(path: string, credentials: NSDAApiCredentials): Promise<unknown> {
  const authorization = Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')
  const result = await fetch(new URL(path, NSDA_API_ORIGIN), {
    headers: { Accept: 'application/json', Authorization: `Basic ${authorization}` },
    signal: AbortSignal.timeout(15_000),
  })

  if (result.status === 401) throw new NSDAApiError('The configured NSDA API credentials were rejected.', 502)
  if (result.status === 403) throw new NSDAApiError('The configured NSDA API credentials are not authorized for this member’s data.', 403)
  if (result.status === 404) throw new NSDAApiError('NSDA API could not find the configured member data.', 404)
  if (!result.ok) throw new NSDAApiError(`NSDA API returned ${result.status}.`, 502)

  try {
    return await result.json() as unknown
  } catch {
    throw new NSDAApiError('NSDA API returned invalid JSON.', 502)
  }
}

function nsdaHistoryApi(env: Record<string, string>): Plugin {
  return {
    name: 'nsda-history-api',
    configureServer(server) {
      server.middlewares.use('/api/nsda/history', async (request, response) => {
        response.setHeader('Cache-Control', 'no-store')
        const requestUrl = new URL(request.url ?? '/', 'http://localhost')
        if (requestUrl.pathname !== '/') {
          return sendJson(response, 404, { error: 'NSDA endpoint not found.' })
        }
        if (request.method !== 'GET') return sendJson(response, 405, { error: 'Method not allowed.' })

        const username = env.NSDA_API_USERNAME?.trim()
        const password = env.NSDA_API_PASSWORD
        const userId = requestUrl.searchParams.get('userId')?.trim() ?? ''
        const numericUserId = Number(userId)
        if (!/^\d+$/.test(userId) || !Number.isSafeInteger(numericUserId) || numericUserId < 1) {
          return sendJson(response, 400, { error: 'A valid positive NSDA user ID is required.' })
        }
        if (!username || !password) {
          return sendJson(response, 503, { error: 'NSDA history is not configured. Set NSDA_API_USERNAME and NSDA_API_PASSWORD in the server environment.' })
        }

        try {
          const credentials = { username, password }
          const memberPath = `members/${userId}`
          const [memberValue, rolesValue, pointsValue, honorsValue, categoriesValue] = await Promise.all([
            fetchNsdaJson(memberPath, credentials),
            fetchNsdaJson(`${memberPath}/roles`, credentials),
            fetchNsdaJson(`${memberPath}/points`, credentials),
            fetchNsdaJson(`${memberPath}/honors`, credentials),
            fetchNsdaJson('points/categories', credentials),
          ])
          if (!isRecord(memberValue) || !Array.isArray(rolesValue) || !Array.isArray(pointsValue) || !Array.isArray(honorsValue) || !Array.isArray(categoriesValue)) {
            throw new NSDAApiError('NSDA API returned data in an unexpected format.', 502)
          }
          if (readInteger(memberValue.person_id) !== numericUserId) {
            throw new NSDAApiError('NSDA API returned a different member than the requested user ID.', 502)
          }

          const roles = rolesValue.filter(isRecord)
          const schoolNames = new Map<number, string>()
          const affiliations = roles.flatMap((role) => {
            const schoolId = readInteger(role.school_id)
            const school = readText(role.school_name)
            if (schoolId !== null && school) schoolNames.set(schoolId, school)
            if (!school || readInteger(role.person_id) !== numericUserId) return []
            return [{
              role: readText(role.role) ?? 'Member',
              school,
              gradYear: readInteger(role.grad_year),
              start: readText(role.start),
              end: readText(role.end),
            }]
          })

          const categories = new Map<number, string>()
          for (const value of categoriesValue) {
            if (!isRecord(value)) continue
            const id = readInteger(value.id)
            const name = readText(value.description)
            if (id !== null && name) categories.set(id, name)
          }

          const tournamentRecords = new Map<string, {
            id: string
            name: string
            location: string
            school: string
            events: Map<number, NSDAEventPoints & { category_id: number }>
          }>()
          for (const value of pointsValue) {
            if (!isRecord(value) || !isRecord(value.tourn) || !Array.isArray(value.entries)) continue
            const tournament = value.tourn
            const tournamentId = readInteger(tournament.tourn_id) ?? readInteger(tournament.id)
            const tournamentName = readText(tournament.name) ?? (tournamentId ? `Tournament ${tournamentId}` : 'Tournament')
            const schoolId = readInteger(value.school_id)
            const key = `${tournamentId ?? tournamentName}:${schoolId ?? ''}`
            let record = tournamentRecords.get(key)
            if (!record) {
              record = {
                id: key,
                name: tournamentName,
                location: readText(tournament.location) ?? '',
                school: schoolId === null ? '—' : schoolNames.get(schoolId) ?? `School ${schoolId}`,
                events: new Map(),
              }
              tournamentRecords.set(key, record)
            }
            for (const entryValue of value.entries) {
              if (!isRecord(entryValue)) continue
              const studentId = readInteger(entryValue.student_id)
              if (studentId !== numericUserId) continue
              const categoryId = readInteger(entryValue.category_id)
              if (categoryId === null) continue
              const event = record.events.get(categoryId) ?? { category_id: categoryId, wins: 0, losses: 0, nodecisions: 0, points: 0 }
              event.wins = (event.wins ?? 0) + (readInteger(entryValue.wins) ?? 0)
              event.losses = (event.losses ?? 0) + (readInteger(entryValue.losses) ?? 0)
              event.nodecisions = (event.nodecisions ?? 0) + (readInteger(entryValue.nodecisions) ?? 0)
              event.points = (event.points ?? 0) + (readInteger(entryValue.points) ?? 0)
              record.events.set(categoryId, event)
            }
          }

          const honors = honorsValue.filter(isRecord).flatMap((honor) => {
            const id = readInteger(honor.member_honor_id)
            const honorId = readInteger(honor.honor_id)
            if (id === null || honorId === null || readInteger(honor.person_id) !== numericUserId) return []
            const schoolId = readInteger(honor.school_id)
            return [{
              id,
              honorId,
              school: schoolId === null ? '—' : schoolNames.get(schoolId) ?? `School ${schoolId}`,
              start: readText(honor.start),
              end: readText(honor.end),
              active: honor.status === true,
              note: readText(honor.note) ?? '',
            }]
          })

          const eventsByCategory = (events: Map<number, NSDAEventPoints & { category_id: number }>) =>
            Array.from(events.values()).map((event) => ({
              name: categories.get(event.category_id) ?? `Category ${event.category_id}`,
              wins: event.wins ?? 0,
              losses: event.losses ?? 0,
              noDecisions: event.nodecisions ?? 0,
              points: event.points ?? 0,
            }))
          const tournaments = Array.from(tournamentRecords.values())
            .map((record) => ({ id: record.id, name: record.name, location: record.location, school: record.school, events: eventsByCategory(record.events) }))
            .filter((record) => record.events.length > 0)
            .sort((left, right) => left.name.localeCompare(right.name))
          const memberName = [readText(memberValue.first), readText(memberValue.last)].filter(Boolean).join(' ') || `Member ${userId}`
          const pointTotal = tournaments.flatMap((record) => record.events).reduce((total, event) => total + event.points, 0)

          return sendJson(response, 200, {
            member: { id: numericUserId, name: memberName, points: readInteger(memberValue.points) ?? pointTotal },
            affiliations,
            tournaments,
            honors,
          })
        } catch (error) {
          const status = error instanceof NSDAApiError ? error.statusCode : 502
          const message = error instanceof Error ? error.message : 'NSDA API request failed.'
          return sendJson(response, status, { error: message })
        }
      })
    },
  }
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
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tabroomProxy(), speechdropApi(), nsdaHistoryApi(env)],
  }
})
