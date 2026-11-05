import { useMemo, useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { SWAP_SLIPPAGE_BPS } from './config.js'
import {
  ALWAYS_ON,
  canSwap,
  describeCheck,
  holdingOf,
  nameOf,
  rulesFor,
  sendChecks,
  swapChecks,
} from './checks.js'
import { amountPattern, formatAmount } from './format.js'

const KIND_NAMES = ['AtMostLeaves', 'AtLeastArrives', 'ExactlyTo']

function readAmount(text, decimals) {
  const trimmed = text.trim()
  if (!trimmed) return { error: null }
  if (!amountPattern(decimals).test(trimmed)) return { error: 'Type an amount like 10 or 0.5' }
  const amount = parseUnits(trimmed, decimals)
  if (amount === 0n) return { error: 'The amount must be more than 0' }
  return { amount }
}

function buildRequest(vault, form) {
  if (form.mode === 'send') {
    if (!vault.contacts.length) return { error: 'No saved contacts yet. Your phone saves them.' }
    const { amount, error } = readAmount(form.amount, holdingOf(vault, form.token).decimals)
    if (!amount) return { error }
    return { checks: sendChecks({ token: form.token, amount, to: form.to }) }
  }
  if (!vault.fairPrice) return { error: "There's no fair price right now, so swaps can't be checked." }
  if (!canSwap(vault, form.from, form.swapTo)) return { error: 'Swaps work between ETH and USDC only, for now.' }
  const { amount, error } = readAmount(form.amount, holdingOf(vault, form.from).decimals)
  if (!amount) return { error }
  return swapChecks(vault, { from: form.from, to: form.swapTo, amount })
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

function ChecksList({ vault, request, mode }) {
  const rules = rulesFor(vault, request.checks)
  return (
    <section className="card">
      <h2>Your checks</h2>
      <ul className="checks">
        {request.checks.map((check, i) => {
          const { icon, text } = describeCheck(vault, check)
          return (
            <li key={i}>
              <span className="icon">{icon}</span>
              <span>{text}</span>
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

export default function Request({ vault }) {
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)?.token ?? zeroAddress
  const [form, setForm] = useState({
    mode: 'send',
    amount: '',
    token: usdc,
    to: vault.contacts[0]?.address ?? '',
    from: usdc,
    swapTo: zeroAddress,
  })
  const set = (field) => (value) => setForm((f) => ({ ...f, [field]: value }))
  const request = useMemo(() => buildRequest(vault, form), [vault, form])

  return (
    <>
      <section className="card">
        <div className="tabs">
          {['send', 'swap'].map((mode) => (
            <button
              key={mode}
              className={form.mode === mode ? 'tab active' : 'tab'}
              onClick={() => set('mode')(mode)}
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

      {request.checks && <ChecksList vault={vault} request={request} mode={form.mode} />}
    </>
  )
}
