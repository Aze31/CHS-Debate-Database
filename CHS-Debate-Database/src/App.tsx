import { useEffect, useState, type DragEvent } from 'react'
import CHSLogo from './assets/CHS-Logo.png'
import './App.css'

type Tournament = { name: string; date: string; sortDate: number; divisions: string[]; circuits: string[]; location: string }
type SpeechdropFile = { id: string; name: string; size: number; uploadedAt: number }
type SpeechdropRound = { code: string; name: string; expiresAt: number; files: SpeechdropFile[] }

function parseTournamentTable(html: string): Tournament[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return Array.from(document.querySelectorAll('#search_results tbody tr')).flatMap((row) => {
    const cells = row.querySelectorAll('td')
    const dateCell = cells[2]
    const dateValue = dateCell?.getAttribute('data-text') ?? ''
    const parsed = new Date(dateValue)
    if (!cells[0] || !dateCell || Number.isNaN(parsed.getTime()) || parsed.getTime() < today.getTime()) return []
    return [{
      name: cells[0].textContent?.trim().replace(/\s+/g, ' ') ?? 'Unnamed tournament',
      date: dateCell.textContent?.trim().replace(/\s+/g, ' ').replace(/&ndash;/g, '–') ?? '',
      sortDate: parsed.getTime(),
      divisions: Array.from(cells[3]?.querySelectorAll('span') ?? []).map((item) => item.textContent?.trim()).filter((item): item is string => Boolean(item)),
      circuits: Array.from(cells[4]?.querySelectorAll('a, span') ?? []).map((item) => item.textContent?.trim()).filter((item): item is string => Boolean(item)),
      location: cells[1]?.textContent?.trim().replace(/\s+/g, ' ') ?? '',
    }]
  }).sort((a, b) => a.sortDate - b.sortDate)
}

function LinkToTab(): void {
  window.open('https://tabroom.com', '_blank', 'noopener,noreferrer')
}

function LinkToGit(): void {
  window.open('https://github.com/Aze31/CHS-Debate-Database', '_blank', 'noopener,noreferrer')
}

function goToSpeechdrop(path = '/speechdrop'): void {
  window.history.pushState({}, '', path)
  window.dispatchEvent(new PopStateEvent('popstate'))
}

function formatFileSize(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function LoginPage({ code }: { code: string }){
  const [userName, setUsername] = useState('')
  const [PassWord, setPassword] = useState('')
  const [error, setError] = useState('')

  async function loadRound(): Promise<void> {
    const response = await fetch(`/api/loginPage/login${code}`)
    const result = await response.json() as SpeechdropRound & { error?: string }
  }

  return<main className = "directory-login-page">
    <header className="masthead">
            <p className="eyebrow">CHS / Login (TR)</p>
            <h1>Login with Tabroom</h1>
            <p className="intro">Use your tabroom credentials to gain access to more features.</p>
            
    </header>
  </main>
}

function SpeechdropHome() {
  const [roundName, setRoundName] = useState('')
  const [roundCode, setRoundCode] = useState('')
  const [error, setError] = useState('')
  const [createdCode, setCreatedCode] = useState('')

  async function createRound(): Promise<void> {
    setError('')
    const response = await fetch('/api/speechdrop/rounds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: roundName }) })
    const result = await response.json() as { code?: string; error?: string }
    if (!response.ok || !result.code) return setError(result.error ?? 'Could not create the round.')
    setCreatedCode(result.code)
    setRoundName('')
  }

  function joinRound(): void {
    const normalizedCode = roundCode.trim().toUpperCase()
    if (!normalizedCode) return setError('Enter a round code to join.')
    goToSpeechdrop(`/speechdrop/${normalizedCode}`)
  }

  return <main className="directory speechdrop-page">
    <header className="masthead">
      <nav className="top-nav"><button className="tabs" onClick={() => goToSpeechdrop('/')}>Database</button><button className="tabs" onClick={LinkToTab}>TR</button><button className="tabs" onClick={LinkToGit}>Git</button></nav>
      <p className="eyebrow">CHS / Speechdrop</p>
      <h1>Drop cases here</h1>
      <p className="intro">Create a temporary room for a tournament round, then share the code so everyone can exchange PDFs.</p>
    </header>
    <section className="speechdrop-grid" aria-label="Speechdrop round access">
      <form className="speechdrop-panel" onSubmit={(event) => { event.preventDefault(); void createRound() }}>
        <span className="panel-kicker">Start a room</span>
        <h2>Create a round</h2>
        <label htmlFor="round-name">Round or event name</label>
        <input id="round-name" value={roundName} onChange={(event) => setRoundName(event.target.value)} placeholder="JV LD Finals" required />
        <button className="primary-action" type="submit">Generate round code</button>
        {createdCode && <p className="created-code">Share this code: <strong>{createdCode}</strong></p>}
      </form>
      <form className="speechdrop-panel join-panel" onSubmit={(event) => { event.preventDefault(); joinRound() }}>
        <span className="panel-kicker">Join a room</span>
        <h2>Enter a code</h2>
        <label htmlFor="round-code">Round code</label>
        <input id="round-code" value={roundCode} onChange={(event) => setRoundCode(event.target.value)} placeholder="ABC123" maxLength={6} autoCapitalize="characters" required />
        <button className="primary-action" type="submit">Open Speechdrop</button>
      </form>
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    <p className="expiry-note">Rooms and their files are available for one hour.</p>
  </main>
}

function SpeechdropRoom({ code }: { code: string }) {
  const [round, setRound] = useState<SpeechdropRound | null>(null)
  const [error, setError] = useState('Loading room...')
  const [secondsLeft, setSecondsLeft] = useState(3600)
  const [uploading, setUploading] = useState(false)

  async function loadRound(): Promise<void> {
    const response = await fetch(`/api/speechdrop/rounds/${code}`)
    const result = await response.json() as SpeechdropRound & { error?: string }
    if (!response.ok) return setError(result.error ?? 'That round is unavailable.')
    setRound(result); setError(''); setSecondsLeft(Math.max(0, Math.ceil((result.expiresAt - Date.now()) / 1000)))
  }

  useEffect(() => { void loadRound() }, [code])

  useEffect(() => {
    if (!round) return
    const timer = window.setInterval(() => {
      const remaining = Math.max(0, Math.ceil((round.expiresAt - Date.now()) / 1000))
      setSecondsLeft(remaining)
      if (remaining === 0) {
        window.clearInterval(timer)
        goToSpeechdrop('/speechdrop')
      }
    }, 1000)
    return () => window.clearInterval(timer)
  }, [round])

  async function uploadFiles(files: FileList | File[]): Promise<void> {
    const pdfs = Array.from(files).filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'))
    if (!pdfs.length) return setError('Only PDF files can be dropped here.')
    setUploading(true); setError('')
    try {
      for (const file of pdfs) {
        const data = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(String(reader.result))
          reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
          reader.readAsDataURL(file)
        })
        const response = await fetch(`/api/speechdrop/rounds/${code}/files`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, type: 'application/pdf', data }) })
        const result = await response.json() as { error?: string }
        if (!response.ok) throw new Error(result.error ?? `Could not upload ${file.name}.`)
      }
      await loadRound()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Upload failed.') }
    finally { setUploading(false) }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>): void {
    event.preventDefault()
    void uploadFiles(event.dataTransfer.files)
  }

  const minutes = Math.floor(secondsLeft / 60).toString().padStart(2, '0')
  const seconds = (secondsLeft % 60).toString().padStart(2, '0')
  return <main className="directory speechdrop-page room-page">
    <header className="masthead room-header">
      <nav className="top-nav"><button className="tabs" onClick={() => goToSpeechdrop('/speechdrop')}>Speechdrop</button><button className="tabs" onClick={() => goToSpeechdrop('/')}>Database</button></nav>
      <p className="eyebrow">Speechdrop / {code}</p>
      <h1>{round?.name ?? 'Opening round...'}</h1>
      <div className="room-meta"><span>Expires in {minutes}:{seconds}</span><strong>{code}</strong></div>
    </header>
    {error && !round && <section className="empty-state error-state"><strong>{error}</strong><button className="primary-action" onClick={() => goToSpeechdrop('/speechdrop')}>Back to Speechdrop</button></section>}
    {round && <>
      <section className="dropzone" onDragOver={(event) => event.preventDefault()} onDrop={handleDrop}>
        <input id="pdf-upload" type="file" accept="application/pdf,.pdf" multiple onChange={(event) => { if (event.target.files) void uploadFiles(event.target.files) }} />
        <label htmlFor="pdf-upload"><strong>{uploading ? 'Uploading PDFs...' : 'Drop PDFs here'}</strong><span>or click to browse your files</span></label>
      </section>
      {error && <p className="form-error" role="alert">{error}</p>}
      <section className="file-list" aria-label="Shared PDF files"><div className="file-list-header"><h2>Shared files</h2><span>{round.files.length} PDF{round.files.length === 1 ? '' : 's'}</span></div>
        {round.files.length === 0 ? <p className="empty-files">No files have been shared yet.</p> : round.files.map((file) => <a className="file-row" href={`/api/speechdrop/rounds/${code}/files/${file.id}`} key={file.id}><span><strong>{file.name}</strong><small>{formatFileSize(file.size)}</small></span><span className="download-label">Download</span></a>)}
      </section>
    </>}
  </main>
}

function App() {
  const [path, setPath] = useState(window.location.pathname)
  const [tournaments, setTournaments] = useState<Tournament[]>([])
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true
    fetch(`/api/tournaments?year=${new Date().getFullYear()}`).then(async (response) => {
      if (!response.ok) throw new Error((await response.json()).error ?? `Request failed with ${response.status}`)
      return response.text()
    }).then((html) => {
      if (!active) return
      const upcoming = parseTournamentTable(html)
      setTournaments(upcoming); setStatus('ready')
    }).catch((reason: unknown) => {
      if (!active) return
      setError(reason instanceof Error ? reason.message : 'TabroomAPI could not load tournament data.'); setStatus('error')
    })
    return () => { active = false }
  }, [])

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname)
    window.addEventListener('popstate', handlePopState)
    return () => window.removeEventListener('popstate', handlePopState)
  }, [])

  if (path === '/speechdrop') return <SpeechdropHome />
  if (path.startsWith('/speechdrop/')) return <SpeechdropRoom code={path.split('/')[2]?.toUpperCase() ?? ''} />

  return <main className="directory">
    <header className="masthead">
      <button className="tabs" onClick={() => LoginPage()}>Login (TR)</button>
      <button className="tabs">Admin</button>
      <button className = "tabs" onClick={LinkToTab}>TR</button>
      <button className = "tabs" onClick={LinkToGit}>Git</button>
      <button className="tabs" onClick={() => goToSpeechdrop('/speechdrop')}>Drop</button>

      <p className="title">CHS Debate Database (WIP)</p>
      <img src={CHSLogo} alt="CHS logo" style={{
        position: 'absolute',
        top:'80px',
        right:'20px',
        scale:'1.2'}}/>
      <p className="eyebrow">CHS / Debate Database</p>
      <h1>Upcoming tournaments</h1>
      <p className="intro">A live index of National Speech and Debate Association events, organized by the next date on the calendar.</p>
      <div className="meta"><span className="status-dot" />{status === 'loading' ? 'Syncing with TabroomAPI' : status === 'error' ? 'Data unavailable' : `${tournaments.length} upcoming events`}<span className="today">Today · {new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span></div>
    </header>
    <section className="table-shell" aria-label="Upcoming tournaments">
      {status === 'loading' && <div className="empty-state">Loading upcoming tournaments...</div>}
      {status === 'error' && <div className="empty-state error-state"><strong>We could not reach TabroomAPI.</strong><span>{error}</span></div>}
      {status === 'ready' && tournaments.length === 0 && <div className="empty-state">No future tournaments were returned by TabroomAPI.</div>}
      {status === 'ready' && tournaments.length > 0 && <table><thead><tr>
        <th>Tournament</th>
        <th>Divisions</th>
        <th>Circuits</th>
        <th>Date</th></tr>
        </thead><tbody>{tournaments.map((tournament) => <tr key={`${tournament.name}-${tournament.date}`}><td>
            <strong>{tournament.name}</strong><span>{tournament.location}</span></td>
            <td><div className="tag-list">{tournament.divisions.map((division) => <span className="tag" key={division}>{division}</span>)}</div></td>
            <td><div className="tag-list">{tournament.circuits.map((circuit) => <span className="circuit" key={circuit}>{circuit}</span>)}</div></td>
            <td className="date">{tournament.date}</td></tr>)}</tbody></table>}
    </section>
    <footer>Data sourced through <a href="https://github.com/gmitch215/TabroomAPI" target="_blank" rel="noreferrer">TabroomAPI</a></footer>
  </main>
}

export default App