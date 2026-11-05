import { useEffect, useState } from 'react'
import { createPublicClient, custom, encodeFunctionData, getAddress, parseAbi, parseEventLogs, zeroAddress } from 'viem'
import { getWallet } from './chain.js'
import { CheckKind } from './checks.js'
import { chain, DEMO_POLL_MS, DEMO_STRANGER, EXPLORER, PRINT_PRICE, PRINTS } from './config.js'
import { zeroGSession, ZG_SPENT } from './credits.js'
import { formatAmount, shortAddress } from './format.js'
import { Dots, Words } from './Motion.jsx'
import CreateVault from './CreateVault.jsx'
import { ReceiptBox } from './Receipt.jsx'
import { Link, ask } from './Replays.jsx'
import { newDeadline, practiceRun, signAndSend, waitForResult } from './run.js'
import { useVault } from './useVault.js'

const SUGGESTION = 'A paper-and-ink fox reading a long receipt, bold black lines on cream paper, one orange accent'
const MAX_SIDE = 1024
const JPEG_QUALITY = 0.88
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
          <p>0G's z-image model draws it inside sealed hardware, paid by your 0G credits when you're signed in on the Pay page.</p>
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
            A PNG or JPEG, shrunk to {MAX_SIDE} px. 0G Storage is public and permanent, so only use a picture you're happy to share.
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

const directoryAbi = parseAbi(['function listed() view returns (address[])'])

const printsAbi = parseAbi([
  'function mint(address to, bytes32 root) payable returns (uint256)',
  'event Minted(uint256 indexed tokenId, address indexed to, bytes32 imageRoot, uint256 paid)',
])

const MINT_WORDS = `Mint it as an NFT. Pay at most ${eth(PRINT_PRICE)} test ETH, and nothing else.`

const MINT_CHECKS = [
  { kind: CheckKind.AtMostLeaves, token: zeroAddress, to: zeroAddress, amount: PRINT_PRICE },
  { kind: CheckKind.AtLeastArrives, token: PRINTS, to: zeroAddress, amount: 1n },
]

const CHECK_WORDS = [`At most ${eth(PRINT_PRICE)} test ETH leaves your vault`, 'At least 1 Verbatim Print arrives in your vault']

function mintRun(vault, root, hacked) {
  const to = hacked ? DEMO_STRANGER : vault.address
  const value = hacked ? PRINT_PRICE * 10n : PRINT_PRICE
  return {
    to,
    value,
    actions: [{ target: PRINTS, value, data: encodeFunctionData({ abi: printsAbi, functionName: 'mint', args: [to, root] }), operation: 0 }],
    checks: MINT_CHECKS,
  }
}

function useTrustsPrints(wallet, vault) {
  const [trusted, setTrusted] = useState(null)
  useEffect(() => {
    if (!wallet || !vault?.directory) return
    let current = true
    const client = createPublicClient({ chain, transport: custom(wallet) })
    client
      .readContract({ address: vault.directory, abi: directoryAbi, functionName: 'listed' })
      .then((list) => current && setTrusted(list.some((a) => getAddress(a) === getAddress(PRINTS))))
      .catch(() => current && setTrusted(false))
    return () => {
      current = false
    }
  }, [wallet, vault?.directory])
  return trusted
}

function refusalWords(failure) {
  if (failure?.checkNumber === 1) return `Check 1 failed: you said at most ${eth(PRINT_PRICE)} test ETH, and it tried to take ${eth(failure.actual)}.`
  if (failure?.checkNumber === 2) return 'Check 2 failed: you said 1 Verbatim Print arrives in your vault, and none did.'
  return failure?.reason ?? 'Your vault refused it.'
}

function HackedAsk({ vault, run }) {
  return (
    <div className="panel warn">
      <p><strong>⚠ The hacked mint site changed what it asks your vault to do</strong></p>
      <ul className="small print-checks">
        <li>Price: you said at most <strong>{eth(PRINT_PRICE)}</strong> test ETH. It asks <strong>{eth(run.value)}</strong>.</li>
        <li>The print goes to: you said <strong>your vault</strong> ({shortAddress(vault.address)}). It sends it to <strong>a stranger, {shortAddress(run.to)}</strong>.</li>
      </ul>
    </div>
  )
}

function MintResult({ result, vault, onReset }) {
  if (result.status === 'signing') return <p className="reading">Confirm in MetaMask. Leave its "Added protection" switch off. <Dots /></p>
  if (result.status === 'pending') return <p className="reading">Sent. Waiting for Sepolia <Dots /> <Link tx={result.hash}>The transaction</Link></p>
  if (result.status === 'error') return <p className="panel warn">{result.error}</p>
  if (result.status !== 'done') return null
  return (
    <>
      {result.ok ? (
        <div className="replay-side safe">
          <h3>Done, exactly as you said</h3>
          <p className="replay-amount">Verbatim Print #{String(result.tokenId ?? '?')} is in your vault</p>
          <p className="small">Your checks passed: at most {eth(PRINT_PRICE)} test ETH left your vault, and 1 Verbatim Print arrived in it.</p>
        </div>
      ) : result.outside ? (
        <div className="replay-side lost">
          <h3>It didn't go through</h3>
          <p className="small">{result.failure?.reason} Nothing left your vault, only the network fee.</p>
        </div>
      ) : (
        <div className="replay-side lost">
          <h3>⚠ This never happens</h3>
          <p className="small"><strong>{refusalWords(result.failure)}</strong></p>
          <p className="small">
            <strong>Without Verbatim:</strong> {eth(result.value)} test ETH gone, and the print goes to a stranger.<br />
            <strong>With Verbatim:</strong> nothing left your vault, only the network fee.
          </p>
        </div>
      )}
      <p className="small">
        <Link tx={result.hash}>The transaction</Link>
        {result.ok && result.tokenId != null && (
          <> · <a href={`${EXPLORER}/nft/${PRINTS}/${result.tokenId}`} target="_blank" rel="noreferrer">The print ↗</a></>
        )}
        {' · '}<Link address={vault.address}>Your vault</Link>
        {' · '}<a href={`#proof/${result.hash}`} target="_blank" rel="noreferrer">The evidence page ↗</a>
      </p>
      <ReceiptBox input={result.receipt} />
      <div className="actions">
        <button className="secondary" onClick={onReset}>Mint again</button>
      </div>
    </>
  )
}

function MintIt({ picture }) {
  const wallet = getWallet()
  const v = useVault()
  const vault = v.vault
  const trusted = useTrustsPrints(wallet, vault)
  const [hacked, setHacked] = useState(false)
  const [practice, setPractice] = useState({ status: 'idle' })
  const [result, setResult] = useState({ status: 'idle' })
  const run = vault && picture ? mintRun(vault, picture.root, hacked) : null
  const ethHeld = vault?.holdings.find((h) => h.token === zeroAddress)?.amount ?? 0n
  const busy = result.status === 'signing' || result.status === 'pending'
  const finished = result.status === 'done'

  useEffect(() => {
    setResult({ status: 'idle' })
  }, [vault?.address, picture?.root, hacked])

  useEffect(() => {
    if (busy || finished) return undefined
    if (!wallet || !vault || !picture || !trusted) {
      setPractice({ status: 'idle' })
      return undefined
    }
    let current = true
    setPractice((now) => (now.status === 'idle' ? { status: 'running' } : now))
    practiceRun(wallet, vault, { ...mintRun(vault, picture.root, hacked), deadline: newDeadline() }).then((outcome) => {
      if (current) setPractice(outcome.pass ? { status: 'pass' } : { status: 'fail', failure: outcome.failure })
    })
    return () => {
      current = false
    }
  }, [wallet, vault?.address, vault?.blockNumber, picture?.root, hacked, trusted, busy, finished])

  const isEveryday = v.role === 'Everyday key'
  const allowed = practice.status === 'pass' || (practice.status === 'fail' && hacked)
  const shortForHack = Boolean(run) && hacked && ethHeld < run.value
  const canSend = Boolean(run) && trusted && isEveryday && allowed && !busy && !finished && !v.smart && ethHeld >= PRINT_PRICE && !shortForHack

  const send = async () => {
    const now = { actions: run.actions, checks: run.checks, deadline: newDeadline() }
    setResult({ status: 'signing' })
    let hash
    try {
      hash = await signAndSend(wallet, vault, now, practice.status !== 'pass')
    } catch (error) {
      setResult({
        status: 'error',
        error: error?.code === 4001 || error?.cause?.code === 4001 ? 'You cancelled in MetaMask. Nothing was sent.' : error?.shortMessage || error?.message || 'Something went wrong.',
      })
      return
    }
    setResult({ status: 'pending', hash })
    try {
      const outcome = await waitForResult(wallet, vault, now, hash)
      const [minted] = outcome.ok ? parseEventLogs({ abi: printsAbi, eventName: 'Minted', logs: outcome.receipt.logs }) : []
      const outside = Boolean(outcome.failure?.outside)
      const failure = !outcome.ok && !outside && !outcome.failure?.checkNumber && practice.failure?.checkNumber ? practice.failure : outcome.failure
      setResult({
        status: 'done',
        hash,
        ok: outcome.ok,
        outside,
        failure,
        value: run.value,
        tokenId: minted?.args.tokenId ?? null,
        receipt: {
          vault: vault.address,
          account: vault.everydayKey,
          chainId: chain.id,
          sentence: MINT_WORDS,
          ai: null,
          checks: now.checks,
          checksInWords: CHECK_WORDS,
          said: null,
          result: { hash, ok: outcome.ok, outside, reason: outcome.ok ? null : refusalWords(failure) },
        },
      })
    } catch (error) {
      setResult({ status: 'error', error: error?.shortMessage || error?.message || 'Something went wrong.' })
    }
    v.refresh()
  }

  return (
    <section className="card column" style={{ animationDelay: '350ms' }}>
      <span className="pill ink loss">Step 2</span>
      <h2>Mint it, safely</h2>
      <p>
        <strong>You say:</strong> "{MINT_WORDS}"
      </p>
      <ul className="small print-checks">
        {CHECK_WORDS.map((words) => <li key={words}>{words}</li>)}
        <li>Nothing else leaves (always on)</li>
      </ul>
      {!v.hasWallet && <p className="panel warn">Open this page in a browser with MetaMask. Minting uses your own vault.</p>}
      {v.hasWallet && !v.account && (
        <div className="actions"><button className="big" onClick={v.connect}>Connect MetaMask</button></div>
      )}
      {v.account && !v.onSepolia && (
        <div className="actions"><button className="big" onClick={v.switchNetwork}>Switch to Sepolia</button></div>
      )}
      {v.account && v.onSepolia && v.vaults?.length === 0 && <p className="panel warn">This key has no vault yet. Create one on the <a href="#">Pay page</a>.</p>}
      {v.vaults?.length > 1 && vault && (
        <label className="scenario">
          <span>Mint with</span>
          <select value={vault.address} onChange={(e) => v.choose(e.target.value)} disabled={busy}>
            {v.vaults.map((option) => (
              <option key={option.address} value={option.address}>{option.ensName ?? shortAddress(option.address)} · {option.role}</option>
            ))}
          </select>
        </label>
      )}
      {vault && trusted === false && (
        <p className="panel warn">This vault can't mint: it was made before version 4, so it doesn't trust the print contract. Pick or create a version 4 vault.</p>
      )}
      {vault && trusted === false && isEveryday && (
        <CreateVault account={v.account} blocked={v.smart} loading={v.loading} onDone={v.refresh} upgrade />
      )}
      {vault && trusted && ethHeld < PRINT_PRICE && (
        <p className="panel warn small">
          Your vault holds {eth(ethHeld)} test ETH. Send it at least {eth(PRINT_PRICE)}: <span className="mono full">{vault.address}</span>
        </p>
      )}
      {vault && v.account && !isEveryday && <p className="muted small">Switch MetaMask to this vault's Everyday key to mint.</p>}
      {!picture && <p className="muted small">Draw a picture or bring your own first.</p>}
      {run && hacked && <HackedAsk vault={vault} run={run} />}
      {shortForHack && (
        <p className="panel warn small">
          For this demo your vault must hold at least {eth(run.value)} test ETH, so the hacked site's ask can reach your checks. It holds {eth(ethHeld)}.
        </p>
      )}
      {run && trusted && practice.status === 'running' && <p className="reading">Practice run against your vault <Dots /></p>}
      {run && trusted && practice.status === 'pass' && <p className="small">✓ Practice run: every check passes.</p>}
      {run && trusted && practice.status === 'fail' && <p className="small"><strong>⚠ Practice run: {refusalWords(practice.failure)}</strong></p>}
      {!finished && (
        <div className="actions">
          <button className="big" onClick={send} disabled={!canSend}>
            {hacked ? 'Send anyway (demo)' : 'Mint with my vault'}
          </button>
        </div>
      )}
      <MintResult result={result} vault={vault} onReset={() => setResult({ status: 'idle' })} />
      <details className="card demo">
        <summary>Demo switches</summary>
        <label className="switch">
          <input type="checkbox" checked={hacked} onChange={(e) => setHacked(e.target.checked)} disabled={busy} />
          <span>
            <strong>Hacked mint site: send it anyway</strong>
            <span className="from">
              The site secretly asks ten times the price and sends the print to a stranger, so you can watch your vault refuse it.
            </span>
          </span>
        </label>
      </details>
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
          <p className="lead">0G's sealed AI draws your picture, or bring your own. Your own vault mints it as an NFT on Sepolia, with your MetaMask, and pays only what you said.</p>
        </div>
      </header>
      <div className="columns">
        <Picture picture={picture} onPicture={setPicture} />
        <MintIt picture={picture} />
      </div>
    </main>
  )
}
