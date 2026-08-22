import { useEffect, useState } from 'react'
import './App.css'

type Tournament = { name: string; date: string; sortDate: number; divisions: string[]; circuits: string[]; location: string }
type page = {name : string; reached : number; }
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

function App() {
  const[pages, setCurPage] = useState<page[]>([])
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

  return <main className="directory">
    <header className="masthead">
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
    <footer>Data sourced through <a href="https://github.com/gmitch215/TabroomAPI" target="_blank" rel="noreferrer">TabroomAPI</a> · Future events only</footer>
  </main>
}

export default App