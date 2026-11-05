import { useEffect, useState } from 'react'
import { DEMO_POLL_MS, EXPLORER } from './config.js'
import { zeroGSession, ZG_SPENT } from './credits.js'
import { formatAmount, shortAddress } from './format.js'
import { Dots, Words } from './Motion.jsx'
import { Link, ask, runReplay } from './Replays.jsx'

const SUGGESTION = 'A paper-and-ink fox reading a long receipt, bold black lines on cream paper, one orange accent'
const MAX_SIDE = 1024
const JPEG_QUALITY = 0.88
const PRICE = 100000000000000n
const SLOW_SECONDS = 45
const MISSES_ALLOWED = 5
const DRAWING = ['waiting', 'drawing', 'storing']
const GALILEO_EXPLORER = 'https://chainscan-galileo.0g.ai'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const eth = (value) => formatAmount(BigInt(value), 18, 4)

async function startPicture(path, body, session) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(session ? { 'x-0g-session': session } : {}) },
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!response) throw new Error("The Verbatim server isn't running. Start it from server/ with npm start.")
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? `The server answered ${response.status}.`)
  return json
}

async function makePicture(path, body, onUpdate) {
  const session = path === '/api/image' ? zeroGSession() : null
  let job = await startPicture(path, body, session)
  let misses = 0
  onUpdate(job)
  while (DRAWING.includes(job.status)) {
    await sleep(DEMO_POLL_MS)
    try {
      job = await ask(`/api/image/${job.id}`)
      misses = 0
    } catch (error) {
      if (error.status === 404 || ++misses > MISSES_ALLOWED) throw error
    }
    onUpdate(job)
  }
  if (session) window.dispatchEvent(new Event(ZG_SPENT))
  if (job.status === 'failed') throw new Error(job.error)
  return job.result
}

function Counter({ text, since }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  return (
    <>
      <p className="reading" role="status">
        {text} <Dots /> {seconds} s
      </p>
      {seconds >= SLOW_SECONDS && <p className="muted small">This can take up to 2 minutes when 0G is busy, and nothing is lost.</p>}
    </>
  )
}

function shrink(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      const scale = Math.min(1, MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(image.naturalWidth * scale)
      canvas.height = Math.round(image.naturalHeight * scale)
      const context = canvas.getContext('2d')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/jpeg', JPEG_QUALITY))
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("That file isn't a picture this browser can open."))
    }
    image.src = url
  })
}

function Picture({ picture, onPicture }) {
  const [mode, setMode] = useState('draw')
  const [prompt, setPrompt] = useState(SUGGESTION)
  const [chosen, setChosen] = useState(null)
  const [state, setState] = useState({ status: 'idle' })
  const busy = state.status === 'running'
  const run = async (path, body) => {
    const since = Date.now()
    setState({ status: 'running', since })
    try {
      const result = await makePicture(path, body, (job) => setState((current) => (current.since === since ? { ...current, job } : current)))
      onPicture(result)
      if (result.source === 'upload') setChosen(null)
      setState({ status: 'idle' })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }
  const choose = async (event) => {
    const file = event.target.files?.[0]
    setChosen(null)
    if (!file) return
    try {
      setChosen(await shrink(file))
      setState({ status: 'idle' })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }
  const step = state.job?.status === 'storing' ? 'Saving it on 0G Storage' : "0G's sealed image model is drawing it"
  return (
    <section className="card column" style={{ animationDelay: '200ms' }}>
      <span className="pill ink loss">Step 1</span>
      <h2>{mode === 'draw' ? 'Draw it with 0G' : 'Bring your own picture'}</h2>
      <div className="print-tabs">
        {['draw', 'upload'].map((option) => (
          <button key={option} className={mode === option ? 'tab active' : 'tab'} onClick={() => setMode(option)} disabled={busy}>
            {option === 'draw' ? 'Draw it with 0G' : 'Use my own picture'}
          </button>
        ))}
      </div>
      {mode === 'draw' ? (
        <>
          <p>0G's z-image model draws your picture inside sealed hardware. If you signed in with 0G on the Pay page, your own credits pay.</p>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={300} rows={3} aria-label="Describe the picture" />
          <div className="actions">
            <button className="big" onClick={() => run('/api/image', { prompt })} disabled={busy || prompt.trim().length < 3}>
              {picture ? 'Draw another' : 'Draw it'}
            </button>
          </div>
        </>
      ) : (
        <>
          <p>
            Pick a PNG or JPEG. Your browser shrinks it to {MAX_SIDE} px and drops hidden photo data, like where it was taken. It's saved on 0G
            Storage, which is public and permanent, so only use a picture you're happy to share. Works on the team's laptop only.
          </p>
          <input className="print-file" type="file" accept="image/png,image/jpeg" onChange={choose} disabled={busy} aria-label="Your picture" />
          {chosen && <img className="print-image" src={chosen} alt="Your picture, ready to save" />}
          <div className="actions">
            <button className="big" onClick={() => run('/api/upload', { image: chosen })} disabled={busy || !chosen}>
              Save it on 0G Storage
            </button>
          </div>
        </>
      )}
      {busy && <Counter text={step} since={state.since} />}
      {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      {picture && (
        <div key={picture.root}>
          <img className="print-image" src={picture.image} alt={picture.prompt ?? 'Your picture'} />
          {picture.source === 'upload' ? (
            <p className="small">Your picture, saved on 0G Storage in {(picture.ms / 1000).toFixed(0)} s.</p>
          ) : (
            <p className="small">
              Drawn by {picture.model} on 0G in sealed hardware, in {(picture.ms / 1000).toFixed(0)} s. Paid by{' '}
              {picture.paidBy === 'you' ? 'your 0G credits' : "Verbatim's 0G key"}
              {picture.costUsd ? ` ($${picture.costUsd.toFixed(4)})` : ''}.
            </p>
          )}
          <p className="muted small">
            On 0G Storage: root <span className="mono">{shortAddress(picture.root)}</span> ·{' '}
            {picture.storageTx ? (
              <a href={`${GALILEO_EXPLORER}/tx/${picture.storageTx}`} target="_blank" rel="noreferrer">the upload ↗</a>
            ) : (
              'already there from an earlier upload'
            )}
            {picture.requestId ? ` · 0G request ${picture.requestId.slice(0, 8)}…` : ''}
          </p>
        </div>
      )}
    </section>
  )
}

function Minted({ result }) {
  return (
    <div className="replay-side safe">
      <h3>Minted into your vault</h3>
      <p className="replay-amount">Verbatim Print #{String(result.tokenId)}</p>
      <p className="small">
        Paid {eth(result.paid)} test ETH. Your checks passed: at most {eth(result.price)} left, and 1 print arrived.
      </p>
      <p className="small">
        <Link tx={result.attempt.hash}>The mint</Link> ·{' '}
        <a href={`${EXPLORER}/nft/${result.prints}/${result.tokenId}`} target="_blank" rel="noreferrer">The print ↗</a> ·{' '}
        <Link address={result.vault}>Your vault</Link>
      </p>
    </div>
  )
}

function Refused({ result }) {
  return (
    <div className="replay-side lost">
      <h3>A hacked mint site: refused, nothing paid</h3>
      <p className="replay-amount">{eth(result.asked)} test ETH asked</p>
      <p className="small">
        It asked ten times the price and sent the print to {shortAddress(result.to)}. Your check "{result.attempt.reason}" failed, so the mint never
        happened. Your vault still holds {eth(result.held.after)} test ETH.
      </p>
      <p className="small">
        <Link tx={result.attempt.hash}>Refused</Link> · <Link address={result.vault}>Your vault</Link>
      </p>
    </div>
  )
}

function MintIt({ picture }) {
  const [state, setState] = useState({ status: 'idle' })
  const [results, setResults] = useState({})
  useEffect(() => {
    setResults({})
    setState({ status: 'idle' })
  }, [picture?.root])
  const start = async (hacked) => {
    const since = Date.now()
    setState({ status: 'running', since, hacked })
    try {
      const job = await runReplay('print', (update) => setState((current) => (current.since === since ? { ...current, job: update } : current)), {
        root: picture.root,
        hacked,
      })
      setResults((current) => ({ ...current, [hacked ? 'hacked' : 'honest']: job.result }))
      setState({ status: 'idle' })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }
  const busy = state.status === 'running'
  const text = state.job?.status === 'waiting' && state.job.ahead ? `Waiting for ${state.job.ahead} replay${state.job.ahead === 1 ? '' : 's'} on Sepolia` : state.hacked ? 'A hacked mint site asks your vault' : 'Your vault mints it on Sepolia'
  return (
    <section className="card column" style={{ animationDelay: '350ms' }}>
      <span className="pill ink loss">Step 2</span>
      <h2>Mint it, safely</h2>
      <p>
        <strong>You say:</strong> "Mint it as an NFT. Pay at most {eth(PRICE)} test ETH, and nothing else."
      </p>
      <ul className="small print-checks">
        <li>At most {eth(PRICE)} test ETH leaves your vault</li>
        <li>At least 1 Verbatim Print arrives in your vault</li>
        <li>Nothing else leaves (always on)</li>
      </ul>
      {!picture && <p className="muted small">Draw a picture or bring your own first.</p>}
      <p className="small">
        <strong>
          Free for you: a shared demo vault on Sepolia pays the {eth(PRICE)} test ETH and the network fee, with Verbatim's test keys. No wallet
          approval is needed, and the print stays in that demo vault.
        </strong>
      </p>
      <div className="actions">
        <button className="big" onClick={() => start(false)} disabled={!picture || busy}>
          {results.honest ? 'Mint another' : 'Mint it through my vault'}
        </button>
        <button onClick={() => start(true)} disabled={!picture || busy}>
          Try a hacked mint site
        </button>
      </div>
      {busy && <Counter text={text} since={state.since} />}
      {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      {results.honest && <Minted result={results.honest} />}
      {results.hacked && <Refused result={results.hacked} />}
      {(results.honest || results.hacked) && (
        <p className="muted small">
          Live on Sepolia with test ETH and the demo keys. A picture has no market price, so this vault's fair-price rule is off and your words do
          the work. The vault is Verbatim's real vault code.
        </p>
      )}
    </section>
  )
}

export default function Mint() {
  const [picture, setPicture] = useState(null)
  return (
    <main className="side">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <nav className="nav">
            <a href="#">Pay</a>
            <a href="#phone">Phone</a>
            <a href="#replays">Replays</a>
            <a href="#mint" className="active">Mint</a>
            <a href="#names">Names</a>
          </nav>
        </div>
      </header>
      <header className="side-head">
        <div>
          <h1><Words text="Draw it, then mint it" step={90} /></h1>
          <p className="lead">0G's sealed AI draws your picture, or bring your own. Your vault mints it as an NFT on Sepolia, and pays only what you said.</p>
        </div>
      </header>
      <div className="columns">
        <Picture picture={picture} onPicture={setPicture} />
        <MintIt picture={picture} />
      </div>
    </main>
  )
}
