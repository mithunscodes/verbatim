import { useEffect, useMemo, useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { EXPLORER, SWAP_SLIPPAGE_BPS } from './config.js'
import { getWallet } from './chain.js'
import {
  ALWAYS_ON,
  canSwap,
  describeCheck,
  describeFailure,
  holdingOf,
  nameOf,
  rulesFor,
  sendChecks,
  swapChecks,
} from './checks.js'
import { amountPattern, formatAmount, shortAddress } from './format.js'
import { hackedExtra, newDeadline, practiceRun, sendActions, signAndSend, waitForResult } from './run.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

const HINTS = {
  'An action failed': 'For example, the vault may not hold enough.',
}

const PRACTICE_DELAY_MS = 400

function readAmount(text, decimals) {
  const trimmed = text.trim()
  if (!trimmed) return { error: null }
  if (!amountPattern(decimals).test(trimmed)) return { error: 'Type an amount like 10 or 0.5' }
  const amount = parseUnits(trimmed, decimals)
  if (amount === 0n) return { error: 'The amount must be more than 0' }
  return { amount }
}

function buildRequest(vault, form, hacked) {
  if (form.mode === 'send') {
    if (!vault.contacts.length) return { error: 'No saved contacts yet. Your phone saves them.' }
    const { decimals } = holdingOf(vault, form.token)
    const { amount, error } = readAmount(form.amount, decimals)
    if (!amount) return { error }
    const sent = hacked ? amount + hackedExtra(form.token, decimals) : amount
    return {
      checks: sendChecks({ token: form.token, amount, to: form.to }),
      actions: sendActions({ token: form.token, amount: sent, to: form.to }),
    }
  }
  if (!vault.fairPrice) return { error: "There's no fair price right now, so swaps can't be checked." }
  if (!canSwap(vault, form.from, form.swapTo)) return { error: 'Swaps work between ETH and USDC only, for now.' }
  const { amount, error } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount) return { error }
  return swapChecks(vault, { from: form.from, to: form.swapTo, amount })
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

function ChecksList({ vault, request, mode, failure }) {
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
      {mode === 'swap' && (
        <p className="muted small">
          At the fair price you'd get about {formatAmount(request.expected, holdingOf(vault, request.checks[1].token).decimals)}{' '}
          {holdingOf(vault, request.checks[1].token).symbol}. The check allows {formatAmount(SWAP_SLIPPAGE_BPS, 2)}% less.
          Swaps can run from Build 6.
        </p>
      )}
      <details className="fold raw">
        <summary>What the vault receives</summary>
        <ol>
          {request.checks.map((check, i) => (
            <li key={i}>
              <code>
                {KIND_NAMES[check.kind]} · token {check.token} · to {check.to} · amount {check.amount.toString()}
              </code>
            </li>
          ))}
        </ol>
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

export default function Request({ vault, role, onDone }) {
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
  const [demo, setDemo] = useState({ hacked: false, forced: false })
  const [practice, setPractice] = useState({ status: 'idle' })
  const [result, setResult] = useState({ status: 'idle' })

  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }))
  const toggle = (field) => (e) => setDemo((d) => ({ ...d, [field]: e.target.checked }))
  const request = useMemo(() => buildRequest(vault, form, demo.hacked), [vault, form, demo.hacked])

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
      const outcome = await practiceRun(wallet, vault, { ...request, deadline: newDeadline() })
      if (!current) return
      setPractice(outcome.pass ? { status: 'pass' } : { status: 'fail', failure: outcome.failure })
    }, PRACTICE_DELAY_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [wallet, vault, request])

  const busy = result.status === 'signing' || result.status === 'pending'
  const finished = result.status === 'done'
  const isEveryday = role === 'Everyday key'
  const practiceDone = practice.status === 'pass' || practice.status === 'fail'
  const allowed = practice.status === 'pass' || (practice.status === 'fail' && demo.forced)
  const canSend = Boolean(request.actions) && isEveryday && allowed && !busy && !finished

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
          <Result result={result} vault={vault} onReset={() => setResult({ status: 'idle' })} />
        </section>
      )}

      {form.mode === 'send' && (
        <details className="card demo">
          <summary>Demo switches</summary>
          <label className="switch">
            <input type="checkbox" checked={demo.hacked} onChange={toggle('hacked')} disabled={busy} />
            <span>Hacked app: secretly sends extra (1 USDC more, or 0.001 ETH more)</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={demo.forced} onChange={toggle('forced')} disabled={busy} />
            <span>Send even if the practice run fails</span>
          </label>
        </details>
      )}
    </>
  )
}
