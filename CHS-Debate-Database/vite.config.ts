import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { TLSSocket } from 'node:tls'
import { load } from 'cheerio'

type SpeechdropFile = { id: string; name: string; size: number; uploadedAt: number; data: string }
type SpeechdropRound = { name: string; expiresAt: number; files: SpeechdropFile[] }
type HistoryBallot = { round: string; result: 'Win' | 'Loss' | 'No result' }
type HistoryTournament = {
  id: string
  name: string
  date: string
  year: number
  division: string
  ballots: HistoryBallot[]
}
type TabroomSession = {
  token: string
  expiresAt: number
  history?: HistoryTournament[]
  historyLoadedAt?: number
  historyLoading?: Promise<HistoryTournament[]>
}

const speechdropRounds = new Map<string, SpeechdropRound>()
const tabroomSessions = new Map<string, TabroomSession>()
const TABROOM_ORIGIN = 'https://www.tabroom.com'
const APP_SESSION_COOKIE = 'chs_tabroom_session'
const APP_SESSION_TTL = 12 * 60 * 60 * 1000
const TABROOM_USER_AGENT = 'CHS Debate Database'

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

function readLoginJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    let tooLarge = false
    request.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      body += chunk.toString()
      if (body.length > 8 * 1024) {
        body = ''
        tooLarge = true
      }
    })
    request.on('end', () => {
      if (tooLarge) {
        reject(new Error('Login request is too large.'))
        return
      }
      try {
        const parsed: unknown = JSON.parse(body)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid JSON request.')
        resolve(parsed as Record<string, unknown>)
      } catch {
        reject(new Error('Invalid JSON request.'))
      }
    })
    request.on('error', reject)
  })
}

function getAppSessionId(request: IncomingMessage): string | undefined {
  return request.headers.cookie
    ?.split(';')
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${APP_SESSION_COOKIE}=`))
    ?.slice(APP_SESSION_COOKIE.length + 1)
}

function getTabroomSession(request: IncomingMessage): TabroomSession | undefined {
  const sessionId = getAppSessionId(request)
  if (!sessionId) return undefined
  const session = tabroomSessions.get(sessionId)
  if (!session || session.expiresAt <= Date.now()) {
    tabroomSessions.delete(sessionId)
    return undefined
  }
  return session
}

function sessionCookie(sessionId: string, maxAge: number, secure: boolean): string {
  return `${APP_SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

function isSecureRequest(request: IncomingMessage): boolean {
  return request.socket instanceof TLSSocket && request.socket.encrypted
}

async function getTabroomDocument(path: string, session: TabroomSession): Promise<string> {
  const response = await fetch(new URL(path, TABROOM_ORIGIN), {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Cookie: `TabroomToken=${encodeURIComponent(session.token)}`,
      'User-Agent': TABROOM_USER_AGENT,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) {
    throw new Error(response.status === 302 ? 'Your Tabroom session has expired. Please sign in again.' : `Tabroom returned ${response.status}.`)
  }
  return response.text()
}

function getHistoryYear(date: string): number {
  const explicitYear = date.match(/\b(?:19|20)\d{2}\b/)
  if (explicitYear) return Number(explicitYear[0])
  const parsed = new Date(date)
  return Number.isNaN(parsed.getTime()) ? 0 : parsed.getFullYear()
}

function parseBallots(html: string): HistoryBallot[] {
  const $ = load(html)
  const ballots: HistoryBallot[] = []

  $('div.main > div.full > table > tbody > tr.row').each((_, row) => {
    const cells = $(row).children()
    const round = cells.eq(0).text().replace(/\s+/g, ' ').trim() || 'Round'
    const ballotRows = cells.eq(6).children().first().children().first().children()
    let foundResult = false

    ballotRows.each((__, ballotRow) => {
      const ballotData = $(ballotRow).children().eq(1)
      if (ballotData.children().length === 0) return
      const decision = ballotData.children().first().text().trim().toUpperCase()
      if (decision !== 'W' && decision !== 'L') return
      ballots.push({ round, result: decision === 'W' ? 'Win' : 'Loss' })
      foundResult = true
    })

    if (!foundResult) ballots.push({ round, result: 'No result' })
  })

  return ballots
}

async function loadHistory(session: TabroomSession): Promise<HistoryTournament[]> {
  const studentPage = await getTabroomDocument('/user/student/index.mhtml', session)
  const $ = load(studentPage)
  const historyRows: Omit<HistoryTournament, 'ballots'>[] = []

  $('div.screens.results > table > tbody > tr').each((_, row) => {
    const cells = $(row).children('td')
    const resultsHref = cells.eq(4).find('a[href]').first().attr('href')
    if (!resultsHref) return

    const resultsUrl = new URL(resultsHref, TABROOM_ORIGIN)
    const tournamentId = resultsUrl.searchParams.get('tourn_id')
    const studentId = resultsUrl.searchParams.get('student_id')
    if (!tournamentId || !studentId || !/^\d+$/.test(tournamentId) || !/^\d+$/.test(studentId)) return

    const date = cells.eq(1).text().replace(/\s+/g, ' ').trim()
    const name = cells.eq(0).text().replace(/\s+/g, ' ').trim()
    historyRows.push({
      id: `${tournamentId}-${studentId}`,
      name: name || 'Tournament',
      date,
      year: getHistoryYear(date),
      division: cells.eq(3).text().replace(/\s+/g, ' ').trim(),
    })
  })

  const history: HistoryTournament[] = []
  for (const item of historyRows) {
    const [tournamentId, studentId] = item.id.split('-')
    const path = `/user/student/history.mhtml?${new URLSearchParams({ tourn_id: tournamentId, student_id: studentId })}`
    const html = await getTabroomDocument(path, session)
    history.push({ ...item, ballots: parseBallots(html) })
  }
  return history
}

async function getSessionHistory(session: TabroomSession): Promise<HistoryTournament[]> {
  if (session.history && session.historyLoadedAt && Date.now() - session.historyLoadedAt <= 5 * 60 * 1000) {
    return session.history
  }
  if (!session.historyLoading) {
    session.historyLoading = loadHistory(session)
      .then((history) => {
        session.history = history
        session.historyLoadedAt = Date.now()
        return history
      })
      .finally(() => { session.historyLoading = undefined })
  }
  return session.historyLoading
}

function tabroomHistoryApi(): Plugin {
  return {
    name: 'tabroom-history-api',
    configureServer(server) {
      server.middlewares.use('/api/tabroom', async (request, response) => {
        const path = new URL(request.url ?? '/', 'http://localhost').pathname
        const parts = path.split('/').filter(Boolean)

        try {
          if (request.method === 'POST' && parts.length === 1 && parts[0] === 'session') {
            const body = await readLoginJson(request)
            const username = typeof body.username === 'string' ? body.username.trim() : ''
            const password = typeof body.password === 'string' ? body.password : ''
            if (!username || !password) return sendJson(response, 400, { error: 'Username and password are required.' })

            const loginPage = await fetch(new URL('/user/login/login.mhtml', TABROOM_ORIGIN), {
              headers: { 'User-Agent': TABROOM_USER_AGENT },
              redirect: 'manual',
              signal: AbortSignal.timeout(15_000),
            })
            if (!loginPage.ok) throw new Error(`Could not load Tabroom login (${loginPage.status}).`)
            const $ = load(await loginPage.text())
            const salt = $('input[name="salt"]').val()
            const sha = $('input[name="sha"]').val()
            if (typeof salt !== 'string' || typeof sha !== 'string') throw new Error('Tabroom login form changed; authentication is unavailable.')

            const loginResponse = await fetch(new URL('/user/login/login_save.mhtml', TABROOM_ORIGIN), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'User-Agent': TABROOM_USER_AGENT,
              },
              body: new URLSearchParams({
                tourn_id: '',
                key: '',
                salt,
                sha,
                category_id: '',
                return: '',
                username,
                password,
              }),
              redirect: 'manual',
              signal: AbortSignal.timeout(15_000),
            })
            if (loginResponse.status !== 302) return sendJson(response, 401, { error: 'Tabroom did not accept those credentials.' })

            const tabroomCookie = loginResponse.headers.getSetCookie()
              .map((cookie) => cookie.split(';', 1)[0])
              .find((cookie) => cookie.startsWith('TabroomToken='))
            if (!tabroomCookie) return sendJson(response, 401, { error: 'Tabroom did not return a valid session.' })

            let token: string
            try {
              token = decodeURIComponent(tabroomCookie.slice('TabroomToken='.length))
            } catch {
              throw new Error('Tabroom returned an invalid session token.')
            }
            if (!token) return sendJson(response, 401, { error: 'Tabroom returned an empty session.' })

            const sessionId = randomBytes(32).toString('base64url')
            const previousSessionId = getAppSessionId(request)
            if (previousSessionId) tabroomSessions.delete(previousSessionId)
            for (const [existingId, existingSession] of tabroomSessions) {
              if (existingSession.expiresAt <= Date.now()) tabroomSessions.delete(existingId)
            }
            tabroomSessions.set(sessionId, { token, expiresAt: Date.now() + APP_SESSION_TTL })
            response.setHeader('Set-Cookie', sessionCookie(sessionId, APP_SESSION_TTL / 1000, isSecureRequest(request)))
            return sendJson(response, 200, { authenticated: true })
          }

          if (request.method === 'GET' && parts.length === 1 && parts[0] === 'session') {
            return sendJson(response, 200, { authenticated: Boolean(getTabroomSession(request)) })
          }

          if (request.method === 'DELETE' && parts.length === 1 && parts[0] === 'session') {
            const sessionId = getAppSessionId(request)
            if (sessionId) tabroomSessions.delete(sessionId)
            response.setHeader('Set-Cookie', sessionCookie('', 0, isSecureRequest(request)))
            return sendJson(response, 200, { authenticated: false })
          }

          const session = getTabroomSession(request)
          if (!session) return sendJson(response, 401, { error: 'Sign in with Tabroom to view tournament history.' })

          if (request.method === 'GET' && parts.length === 1 && parts[0] === 'history') {
            const history = await getSessionHistory(session)
            const tournaments = history.map(({ ballots: _ballots, ...tournament }) => tournament)
            const yearlyStats = new Map<number, { year: number; wins: number; losses: number }>()
            for (const tournament of history) {
              if (!tournament.year) continue
              const stats = yearlyStats.get(tournament.year) ?? { year: tournament.year, wins: 0, losses: 0 }
              for (const ballot of tournament.ballots) {
                if (ballot.result === 'Win') stats.wins++
                if (ballot.result === 'Loss') stats.losses++
              }
              yearlyStats.set(tournament.year, stats)
            }
            return sendJson(response, 200, {
              tournaments,
              yearlyStats: Array.from(yearlyStats.values()).sort((a, b) => b.year - a.year),
            })
          }

          if (request.method === 'GET' && parts.length === 2 && parts[0] === 'history') {
            const history = await getSessionHistory(session)
            const tournament = history.find((item) => item.id === parts[1])
            if (!tournament) return sendJson(response, 404, { error: 'Tournament history was not found. Refresh your history and try again.' })
            return sendJson(response, 200, { ballots: tournament.ballots })
          }

          return sendJson(response, 404, { error: 'Tabroom endpoint not found.' })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Tabroom request failed.'
          const status = message === 'Login request is too large.' ? 413 : 502
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
export default defineConfig({
  plugins: [react(), tabroomProxy(), speechdropApi(), tabroomHistoryApi()],
})
