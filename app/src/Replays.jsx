import { useEffect, useState } from 'react'
import { DEMO_POLL_MS, EXPLORER } from './config.js'
import { formatAmount, shortAddress } from './format.js'
import { Dots, Words } from './Motion.jsx'

const MAINNET_EXPLORER = 'https://etherscan.io'
const HOOK_REPORT = 'https://cryptoslate.com/malicious-uniswap-v4-hooks-are-baiting-defi-traders-with-fake-swap-quotes/'
const SLOW_SECONDS = 30
const MISSES_ALLOWED = 5
const ACTIVE = ['waiting', 'preparing', 'running']
const NAMES = { bybit: 'Bybit', aave: 'Aave', hook: 'Uniswap hook' }

const CARDS = {
  bybit: {
    title: 'Bybit, 21 Feb 2025',
    pill: 'Lost: $1.5 billion',
    intro: "Bybit's signers approved what looked like a routine move. It actually ran borrowed code that replaced their wallet's code.",
    preparing: "Getting a fresh Safe like Bybit's ready on Sepolia",
    running: "3 signers approve Bybit's instruction, and a Verbatim vault gets the same one",
  },
  aave: {
    title: 'The $50.4M Aave trade, 12 Mar 2026',
    pill: 'Lost: $50.4 million',
    intro: 'A user swapped 50.4 million USDT for AAVE. The quote said about 329 AAVE, and the user accepted it.',
    preparing: 'Checking both pools are back where they started',
    running: 'Sending the same trade from a normal wallet and from a Verbatim vault',
  },
  hook: {
    title: 'A bad Uniswap v4 hook, Sep 2026',
    pill: 'Quotes 100, pays 80',
    intro:
      "On 14 Sep 2026, 0x warned about Uniswap v4 hooks built to quote one price and settle at another. Ours does just that: it pays fairly when Uniswap's quoter asks, and takes 20% when the swap is real.",
    preparing: 'Checking the v4 pool is back where it started',
    running: "Asking Uniswap's quoter, then sending the same swap from a normal wallet and from a Verbatim vault",
    wide: true,
  },
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function ask(path, body) {
  const options = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined
  const response = await fetch(path, options).catch(() => null)
  if (!response) throw new Error("The Verbatim server isn't running. Start it from server/ with npm start.")
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw Object.assign(new Error(json.error ?? `The server answered ${response.status}.`), { status: response.status })
  return json
}

export async function runReplay(name, onUpdate, extra = {}) {
  let job = await ask('/api/replay', { name, ...extra })
  let misses = 0
  onUpdate(job)
  while (ACTIVE.includes(job.status)) {
    await sleep(DEMO_POLL_MS)
    try {
      job = await ask(`/api/replay/${job.id}`)
      misses = 0
    } catch (error) {
      if (error.status === 404 || ++misses > MISSES_ALLOWED) throw error
    }
    onUpdate(job)
  }
  if (job.status === 'failed') throw new Error(job.error)
  return job
}

const amount = (value, decimals, digits = 2) =>
  formatAmount(BigInt(value) + (digits < decimals ? 5n * 10n ** BigInt(decimals - digits - 1) : 0n), decimals, digits)

const eth = (value) => formatAmount(BigInt(value), 18, 4)

export function Link({ tx, address, children }) {
  return (
    <a href={tx ? `${EXPLORER}/tx/${tx}` : `${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {children} ↗
    </a>
  )
}

function Side({ title, safe, children }) {
  return (
    <div className={safe ? 'replay-side safe' : 'replay-side lost'}>
      <h3>{title}</h3>
      {children}
    </div>
  )
}

function Bybit({ job }) {
  const r = job.result
  return (
    <>
      <Side title="A Safe like Bybit's: emptied">
        <p className="replay-amount">{eth(r.safe.before)} → {eth(r.safe.after)} test ETH</p>
        <p className="small">
          {r.signers.length} of its 6 signers approved. That swapped its code ({shortAddress(r.codeBefore)} → {shortAddress(r.codeAfter)}), then the
          thief swept it.
        </p>
        <p className="small">
          <Link tx={r.takeover.hash}>Approved</Link> · <Link tx={r.sweep.hash}>Swept</Link> · <Link address={r.safe.address}>The Safe</Link>
        </p>
      </Side>
      <Side title="A Verbatim vault, same instruction: refused, nothing lost" safe>
        <p className="replay-amount">{eth(r.vault.before)} → {eth(r.vault.after)} test ETH</p>
        <p className="small">"{r.vault.reason}"</p>
        <p className="small">
          <Link tx={r.attempt.hash}>Refused</Link> · <Link address={r.vault.address}>The vault</Link>
        </p>
      </Side>
      <p className="muted small">
        The signers believed: "{job.facts.sentence}" ·{' '}
        <a href={`${MAINNET_EXPLORER}/tx/${job.facts.attackTx}`} target="_blank" rel="noreferrer">the real attack on Etherscan ↗</a>
      </p>
      <p className="muted small">
        Test amounts: 0.001 test ETH stands in for Bybit's {amount(job.facts.ethHeld, 18, 0)} ETH. The Safe is version 1.1.1, 3 of 6 signers,
        like Bybit's. Bybit's attack code is copied: the <Link address={r.trojan}>trojan</Link> byte for byte, and the{' '}
        <Link address={r.backdoor}>backdoor</Link> with only the attacker's address swapped for our thief's.
      </p>
    </>
  )
}

function Aave({ job }) {
  const r = job.result
  const exact = r.trade.wethOut === r.real.wethOut && r.trade.aaveOut === r.real.aaveOut
  return (
    <>
      <Side title="A normal wallet, same pools: the trade went through">
        <p className="replay-amount">{amount(r.trade.usdtIn, 6)} tUSDT → {amount(r.trade.aaveOut, 18)} tAAVE</p>
        <p className="small">
          Through {amount(r.trade.wethOut, 18)} tWETH on Uniswap v3, then Uniswap v2 (SushiSwap's pool is a copy of it).{' '}
          {exact ? 'The same as the real trade, to the last digit.' : 'Within 0.1% of the real trade.'}
        </p>
        <p className="small">
          <Link tx={r.trade.hash}>The trade</Link> · <Link address={r.pools.v3}>v3 pool</Link> · <Link address={r.pools.v2}>v2 pool</Link>
        </p>
      </Side>
      <Side title="A Verbatim vault, same trade: refused, nothing lost" safe>
        <p className="replay-amount">You'd get {amount(r.lessBps, 2)}% less than a fair price</p>
        <p className="small">
          The user's own check passed: at least {amount(r.quoted, 18, 0)} AAVE, and {amount(r.trade.aaveOut, 18)} would arrive. But the vault's
          fair-price rule refused it: "{r.attempt.reason}". Chainlink's prices that day (AAVE ${amount(r.prices.aave, r.prices.decimals, 3)}, USDT $
          {amount(r.prices.usdt, r.prices.decimals, 5)}) make a fair amount {amount(r.fair, 18, 0)} AAVE. The vault still holds{' '}
          {amount(r.vault.usdtAfter, 6)} tUSDT.
        </p>
        <p className="small">
          <Link tx={r.attempt.hash}>Refused</Link> · <Link address={r.vault.address}>The vault</Link>
        </p>
      </Side>
      <p className="muted small">
        The same route, re-created as a direct trade (the original was a CoW order) ·{' '}
        <a href={`${MAINNET_EXPLORER}/tx/${job.facts.tradeTx}`} target="_blank" rel="noreferrer">the real trade on Etherscan ↗</a>
      </p>
      <p className="muted small">
        Test amounts: test tokens (tUSDT, tWETH, tAAVE) in copies of the two pools, with mainnet's numbers at that moment. Left out: the "withdraw from
        Aave lending" step. Both pools are reset after each run, so every click starts from the same moment.
      </p>
    </>
  )
}

function Hook({ job }) {
  const r = job.result
  return (
    <>
      <p className="small replay-said">
        You said: "Swap {amount(r.amount, 6, 0)} tUSDC for at least {amount(r.atLeast, 18, 4)} tWETH". That's Uniswap's quote,{' '}
        {amount(r.quoted, 18, 4)} tWETH, less 0.5%. The app sent the swap with no minimum of its own.
      </p>
      <div className="replay-pair">
        <Side title="A normal wallet, same swap: 20% less than quoted">
          <p className="replay-amount">{amount(r.quoted, 18, 4)} → {amount(r.got, 18, 4)} tWETH</p>
          <p className="small">
            Quoted {amount(r.quoted, 18, 4)}, paid {amount(r.got, 18, 4)}. The hook sent the other {amount(r.cut, 18, 4)} tWETH to its owner.
          </p>
          <p className="small">
            <Link tx={r.trade.hash}>The swap</Link> · <Link address={r.pool.hook}>The hook</Link> · <Link address={r.pool.manager}>Uniswap v4</Link>
          </p>
        </Side>
        <Side title="A Verbatim vault, same swap: refused, nothing lost" safe>
          <p className="replay-amount">{amount(r.vault.usdcAfter, 6, 0)} tUSDC kept</p>
          <p className="small">
            Your words said at least {amount(r.atLeast, 18, 4)} tWETH. Only {amount(r.attempt.actual ?? r.got, 18, 4)} would arrive, so your
            check "{r.attempt.reason}" failed. Without your words, the vault's fair-price rule refuses it too: "{r.withoutWords}".
          </p>
          <p className="small">
            <Link tx={r.attempt.hash}>Refused</Link> · <Link address={r.vault.address}>The vault</Link>
          </p>
        </Side>
      </div>
      <p className="muted small">
        0x, 14 Sep 2026: hooks "designed to quote one price and settle at another" ·{' '}
        <a href={HOOK_REPORT} target="_blank" rel="noreferrer">CryptoSlate's report ↗</a>
      </p>
      <p className="muted small">
        Test amounts: test tokens in a real Uniswap v4 pool on Sepolia, through Uniswap's own quoter and Universal Router, starting at Chainlink's ETH
        price (${amount(r.prices.ethUsd, r.prices.decimals, 2)}). The hook is ours. The pool is reset after each run.
      </p>
    </>
  )
}

function Progress({ card, job, since }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const seconds = Math.max(0, Math.round((now - since) / 1000))
  const text =
    job?.status === 'running'
      ? card.running
      : job?.status === 'preparing'
        ? card.preparing
        : job?.ahead
          ? `Waiting for ${job.ahead} replay${job.ahead === 1 ? '' : 's'} ahead of this one`
          : job?.clearing
            ? `Waiting while the last ${NAMES[job.clearing]} replay is put back`
            : 'Starting on Sepolia'
  return (
    <>
      <p className="reading" role="status">
        {text} <Dots /> {seconds} s
      </p>
      {seconds >= SLOW_SECONDS && <p className="muted small">Sepolia is busy right now. It can take a few minutes, and nothing is lost.</p>}
    </>
  )
}

function ReplayCard({ name, index }) {
  const card = CARDS[name]
  const [state, setState] = useState({ status: 'idle' })
  const start = async () => {
    const since = Date.now()
    setState({ status: 'running', since })
    try {
      const job = await runReplay(name, (update) => setState((current) => (current.since === since ? { ...current, job: update } : current)))
      setState({ status: 'done', job, seconds: (Date.now() - since) / 1000 })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }
  return (
    <section className={card.wide ? 'card column wide' : 'card column'} style={{ animationDelay: `${200 + index * 150}ms` }}>
      <span className="pill bad loss">{card.pill}</span>
      <h2>{card.title}</h2>
      <p>{card.intro}</p>
      <div className="actions">
        <button className="big" onClick={start} disabled={state.status === 'running'}>
          {state.status === 'done' ? 'Replay it again' : 'Replay it live on Sepolia'}
        </button>
      </div>
      {state.status === 'running' && <Progress card={card} job={state.job} since={state.since} />}
      {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      {state.status === 'done' && (
        <div key={state.job.id}>
          {name === 'bybit' ? <Bybit job={state.job} /> : name === 'aave' ? <Aave job={state.job} /> : <Hook job={state.job} />}
          <p className="muted small">
            Live on Sepolia, block {String(name === 'bybit' ? state.job.result.takeover.block : state.job.result.trade.block)}, in{' '}
            {state.seconds.toFixed(1)} s. The vault is Verbatim's real vault code.
          </p>
        </div>
      )}
    </section>
  )
}

export default function Replays() {
  return (
    <main className="side">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <nav className="nav">
            <a href="#">Pay</a>
            <a href="#phone">Phone</a>
            <a href="#replays" className="active">Replays</a>
            <a href="#mint">Mint</a>
            <a href="#names">Names</a>
          </nav>
        </div>
      </header>
      <header className="side-head">
        <div>
          <h1><Words text="Real history, cancelled live" step={90} /></h1>
          <p className="lead">Two real attacks and a trick 0x warned about, replayed live on Sepolia with test money. Every line links to Etherscan.</p>
        </div>
      </header>
      <div className="columns">
        <ReplayCard name="bybit" index={0} />
        <ReplayCard name="aave" index={1} />
        <ReplayCard name="hook" index={2} />
      </div>
    </main>
  )
}
