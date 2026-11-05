import { useEffect, useMemo, useRef, useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { EXPLORER, QUOTE_REFRESH_MS, SHOWN_DIGITS, SWAP_SLIPPAGE_BPS } from './config.js'
import { getWallet } from './chain.js'
import {
  ALWAYS_ON,
  canSwap,
  describeAction,
  describeCheck,
  describeFailure,
  holdingOf,
  nameOf,
  rulesFor,
  sendChecks,
  swapChecks,
} from './checks.js'
import { amountPattern, formatAbout, formatAmount, shortAddress } from './format.js'
import { compareToFair, describeRoute, useQuote } from './quotes.js'
import {
  hackedExtra,
  newDeadline,
  practiceRun,
  sendActions,
  signAndSend,
  swapActions,
  waitForResult,
} from './run.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

const HINTS = {
  'An action failed': 'For example, the vault may not hold enough, or a swap price moved.',
}

const PRACTICE_DELAY_MS = 400

function keyOf(request) {
  return JSON.stringify({ checks: request.checks, actions: request.actions }, (k, x) => (typeof x === 'bigint' ? x.toString() : x))
}

function readAmount(text, decimals) {
  const trimmed = text.trim()
  if (!trimmed) return { error: null }
  if (!amountPattern(decimals).test(trimmed)) return { error: 'Type an amount like 10 or 0.5' }
  const amount = parseUnits(trimmed, decimals)
  if (amount === 0n) return { error: 'The amount must be more than 0' }
  return { amount }
}

function badRouteAllowed(form) {
  return form.from !== zeroAddress
}

function swapAskFor(vault, form, demo) {
  if (form.mode !== 'swap' || !vault.fairPrice || !canSwap(vault, form.from, form.swapTo)) return null
  if (demo.badRoute && !badRouteAllowed(form)) return null
  const { amount } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount) return null
  return { swapper: vault.address, tokenIn: form.from, tokenOut: form.swapTo, amount, badRoute: demo.badRoute }
}

function buildRequest(vault, form, demo, quote) {
  if (form.mode === 'send') {
    if (!vault.contacts.length) return { error: 'No saved contacts yet. Your phone saves them.' }
    const { decimals } = holdingOf(vault, form.token)
    const { amount, error } = readAmount(form.amount, decimals)
    if (!amount) return { error }
    const sent = demo.hacked ? amount + hackedExtra(form.token, decimals) : amount
    return {
      checks: sendChecks({ token: form.token, amount, to: form.to }),
      actions: sendActions({ token: form.token, amount: sent, to: form.to }),
    }
  }
  if (!vault.fairPrice) return { error: "There's no fair price right now, so swaps can't be checked." }
  if (!canSwap(vault, form.from, form.swapTo)) return { error: 'Swaps work between ETH and USDC only, for now.' }
  if (demo.badRoute && !badRouteAllowed(form)) return { error: 'The bad route works for USDC → ETH only.' }
  const { amount, error } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount) return { error }
  const swap = swapChecks(vault, { from: form.from, to: form.swapTo, amount })
  if (!quote) return swap
  return { ...swap, actions: swapActions({ from: form.from, amount, transaction: quote.transaction }) }
}

function explain(failure, vault, checks) {
  if (failure.checkNumber && vault && checks) {
    const check = checks[failure.checkNumber - 1]
    return `${describeCheck(vault, check).text}, ${describeFailure(vault, check, failure.actual)}`
  }
  const hint = HINTS[failure.reason]
  return hint ? `${failure.reason}. ${hint}` : failure.reason
}

function TxLink({ hash }) {
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      See it on Etherscan ({shortAddress(hash)})
    </a>
  )
}

function TokenSelect({ vault, value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {vault.holdings.map((holding) => (
        <option key={holding.token} value={holding.token}>{holding.symbol}</option>
      ))}
    </select>
  )
}

function QuoteLine({ quote, fair, out }) {
  if (quote.status === 'loading') return <p>Asking Uniswap for a quote…</p>
  if (quote.status === 'error') return <p className="error">Uniswap quote: {quote.error}</p>
  if (quote.status !== 'ready') return null
  if (quote.quote.badRoute) {
    return (
      <p className="error">
        Bad route (demo): the app ignores Uniswap's quote and swaps through a thin Uniswap v3 pool
        (USDC → ETH, 0.01% fee) whose price is worse.
      </p>
    )
  }
  const { amountOut, blockNumber } = quote.quote
  return (
    <p>
      Uniswap's quote: about {formatAbout(amountOut, out.decimals, SHOWN_DIGITS)} {out.symbol},{' '}
      {compareToFair(amountOut, fair)}, through {describeRoute(quote.quote)}. Quoted at block{' '}
      {blockNumber.toLocaleString('en-US')}, refreshed every {QUOTE_REFRESH_MS / 1000} seconds.
    </p>
  )
}

function SwapNote({ vault, request, quote }) {
  const out = holdingOf(vault, request.checks[1].token)
  return (
    <div className="muted small">
      <p>
        At the fair price you'd get about {formatAbout(request.expected, out.decimals, SHOWN_DIGITS)} {out.symbol}.
        The check allows {formatAmount(SWAP_SLIPPAGE_BPS, 2)}% less.
      </p>
      <QuoteLine quote={quote} fair={request.expected} out={out} />
    </div>
  )
}

function ChecksList({ vault, request, mode, failure, quote }) {
  const rules = rulesFor(vault, request.checks)
  return (
    <section className="card">
      <h2>Your checks</h2>
      <ul className="checks">
        {request.checks.map((check, i) => {
          const { icon, text } = describeCheck(vault, check)
          const failed = failure?.checkNumber === i + 1
          return (
            <li key={i} className={failed ? 'failed' : undefined}>
              <span className="icon">{failed ? '✗' : icon}</span>
              <span>
                {text}
                {failed && <>, {describeFailure(vault, check, failure.actual)}</>}
              </span>
            </li>
          )
        })}
      </ul>
      <details className="fold">
        <summary>
          <span className="icon">✓</span>
          <span>Your account stays exactly as it is</span>
        </summary>
        <h3>Always on</h3>
        <ul>
          {ALWAYS_ON.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <h3>Your rules</h3>
        <ul>
          {rules.map((line) => <li key={line}>{line}</li>)}
        </ul>
      </details>
      {mode === 'swap' && <SwapNote vault={vault} request={request} quote={quote} />}
      <details className="fold raw">
        <summary>What the vault receives</summary>
        <h3>Checks</h3>
        <ol>
          {request.checks.map((check, i) => (
            <li key={i}>
              <code>
                {KIND_NAMES[check.kind]} · token {check.token} · to {check.to} · amount {check.amount.toString()}
              </code>
            </li>
          ))}
        </ol>
        {request.actions && (
          <>
            <h3>Actions</h3>
            <ol>
              {request.actions.map((action, i) => (
                <li key={i}><code>{describeAction(vault, action)}</code></li>
              ))}
            </ol>
          </>
        )}
      </details>
    </section>
  )
}

function Practice({ practice }) {
  if (practice.status === 'running') return <p className="practice muted">Practice run…</p>
  if (practice.status === 'pass') return <p className="practice pass">✓ Practice run: every check passes</p>
  if (practice.status === 'fail') return <p className="practice fail">✗ Practice run: {explain(practice.failure)}</p>
  return null
}

function Result({ result, vault, onReset }) {
  if (result.status === 'signing') {
    return <p className="muted">Confirm in MetaMask. Keep the "secure" option off.</p>
  }
  if (result.status === 'pending') {
    return <p className="muted">Sent. Waiting for the network… <TxLink hash={result.hash} /></p>
  }
  if (result.status === 'error') {
    return <p className="error">{result.error}</p>
  }
  if (result.status !== 'done') return null
  return (
    <div className={result.ok ? 'result ok' : 'result refused'}>
      {result.ok ? (
        <h3>✅ Done, exactly as you said</h3>
      ) : (
        <>
          <h3>❌ Your vault refused it, so it never happened</h3>
          <p>{explain(result.failure, vault, result.checks)}</p>
          <p>Nothing left your vault. Only the network fee was paid.</p>
        </>
      )}
      <p><TxLink hash={result.hash} /></p>
      <button className="secondary" onClick={onReset}>New request</button>
    </div>
  )
}

export default function Request({ vault, role, blocked, onDone }) {
  const wallet = getWallet()
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)?.token ?? zeroAddress
  const [form, setForm] = useState({
    mode: 'send',
    amount: '',
    token: usdc,
    to: vault.contacts[0]?.address ?? '',
    from: usdc,
    swapTo: zeroAddress,
  })
  const [demo, setDemo] = useState({ hacked: false, badRoute: false, forced: false })
  const [practice, setPractice] = useState({ status: 'idle' })
  const [result, setResult] = useState({ status: 'idle' })
  const [practiceRound, setPracticeRound] = useState(0)

  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }))
  const toggle = (field) => (e) => setDemo((d) => ({ ...d, [field]: e.target.checked }))
  const busy = result.status === 'signing' || result.status === 'pending'
  const finished = result.status === 'done'
  const quote = useQuote(swapAskFor(vault, form, demo), busy || finished)
  const readyQuote = quote.status === 'ready' ? quote.quote : null
  const request = useMemo(() => buildRequest(vault, form, demo, readyQuote), [vault, form, demo, readyQuote])
  const requestKey = useMemo(() => keyOf(request), [request])
  const latest = useRef({ vault, request })
  latest.current = { vault, request }

  useEffect(() => {
    setResult({ status: 'idle' })
  }, [form, demo])

  useEffect(() => {
    if (!request.actions) {
      setPractice({ status: 'idle' })
      return
    }
    let current = true
    setPractice({ status: 'running' })
    const timer = setTimeout(async () => {
      const now = latest.current
      const outcome = await practiceRun(wallet, now.vault, { ...now.request, deadline: newDeadline() })
      if (!current) return
      setPractice(outcome.pass ? { status: 'pass' } : { status: 'fail', failure: outcome.failure })
    }, PRACTICE_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [wallet, requestKey, practiceRound])

  const isEveryday = role === 'Everyday key'
  const practiceDone = practice.status === 'pass' || practice.status === 'fail'
  const allowed = practice.status === 'pass' || (practice.status === 'fail' && demo.forced)
  const canSend = Boolean(request.actions) && isEveryday && allowed && !busy && !finished && !blocked

  const send = async () => {
    const run = { ...request, deadline: newDeadline() }
    const forced = practice.status !== 'pass'
    setResult({ status: 'signing' })
    let hash
    try {
      hash = await signAndSend(wallet, vault, run, forced)
    } catch (error) {
      setResult({
        status: 'error',
        error: error?.code === 4001 || error?.cause?.code === 4001
          ? 'You cancelled in MetaMask. Nothing was sent.'
          : error?.shortMessage || error?.message || 'Something went wrong.',
      })
      onDone()
      return
    }
    setResult({ status: 'pending', hash })
    try {
      const outcome = await waitForResult(wallet, vault, run, hash)
      setResult({ status: 'done', hash, ok: outcome.ok, failure: outcome.failure, checks: run.checks })
    } catch (error) {
      setResult({ status: 'error', error: error?.shortMessage || error?.message || 'Something went wrong.' })
    }
    onDone()
  }

  return (
    <>
      <section className="card">
        <div className="tabs">
          {['send', 'swap'].map((mode) => (
            <button
              key={mode}
              className={form.mode === mode ? 'tab active' : 'tab'}
              onClick={() => set('mode')(mode)}
              disabled={busy}
            >
              {mode === 'send' ? 'Send' : 'Swap'}
            </button>
          ))}
        </div>

        <div className="form">
          <label>
            <span>{form.mode === 'send' ? 'Send' : 'Swap'}</span>
            <input
              inputMode="decimal"
              placeholder="0"
              value={form.amount}
              disabled={busy}
              onChange={(e) => set('amount')(e.target.value)}
            />
          </label>

          {form.mode === 'send' ? (
            <>
              <TokenSelect vault={vault} value={form.token} onChange={set('token')} />
              <label>
                <span>to</span>
                <select value={form.to} onChange={(e) => set('to')(e.target.value)}>
                  {vault.contacts.map((contact) => (
                    <option key={contact.address} value={contact.address}>
                      {nameOf(vault, contact.address)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : (
            <>
              <TokenSelect vault={vault} value={form.from} onChange={set('from')} />
              <label>
                <span>for</span>
                <TokenSelect vault={vault} value={form.swapTo} onChange={set('swapTo')} />
              </label>
            </>
          )}
        </div>

        {request.error && <p className="error">{request.error}</p>}
      </section>

      {request.checks && (
        <ChecksList
          vault={vault}
          request={request}
          mode={form.mode}
          failure={practice.status === 'fail' ? practice.failure : null}
          quote={quote}
        />
      )}

      {request.actions && (
        <section className="card">
          <Practice practice={practice} />
          {!isEveryday && practiceDone && (
            <p className="muted">Switch MetaMask to the Everyday key to send.</p>
          )}
          {!finished && (
            <button onClick={send} disabled={!canSend}>
              {practice.status === 'fail' && demo.forced ? 'Send anyway (demo)' : 'Sign and send'}
            </button>
          )}
          <Result
            result={result}
            vault={vault}
            onReset={() => {
              setResult({ status: 'idle' })
              setPracticeRound((n) => n + 1)
            }}
          />
        </section>
      )}

      <details className="card demo">
        <summary>Demo switches</summary>
        {form.mode === 'send' ? (
          <label className="switch">
            <input type="checkbox" checked={demo.hacked} onChange={toggle('hacked')} disabled={busy} />
            <span>Hacked app: secretly sends extra (1 USDC more, or 0.001 ETH more)</span>
          </label>
        ) : (
          <label className="switch">
            <input type="checkbox" checked={demo.badRoute} onChange={toggle('badRoute')} disabled={busy} />
            <span>Bad route: swap through a thin pool with a worse price (USDC → ETH only)</span>
          </label>
        )}
        <label className="switch">
          <input type="checkbox" checked={demo.forced} onChange={toggle('forced')} disabled={busy} />
          <span>Send even if the practice run fails</span>
        </label>
      </details>
    </>
  )
}
