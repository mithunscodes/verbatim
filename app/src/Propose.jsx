import { useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { holdingOf } from './checks.js'
import { amountPattern, formatAmount, formatDuration } from './format.js'
import { useVaultTx } from './hooks.js'
import { ChangeKind } from './rules.js'
import TxStatus from './TxStatus.jsx'

export default function Propose({ vault, role, account, onDone }) {
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)?.token ?? zeroAddress
  const [token, setToken] = useState(usdc)
  const [text, setText] = useState('')
  const { tx, send, busy } = useVaultTx(account, onDone)
  const holding = holdingOf(vault, token)
  const trimmed = text.trim()
  const valid = amountPattern(holding.decimals).test(trimmed)
  const amount = valid ? parseUnits(trimmed, holding.decimals) : null
  const error = !trimmed ? null
    : !valid ? 'Type an amount like 150 or 0.5'
    : amount <= holding.dailyLimit ? "That's not a raise. Your phone can lower a limit straight away."
    : null
  const isEveryday = role === 'Everyday key'

  const propose = () => {
    send(`Propose ${formatAmount(amount, holding.decimals)} ${holding.symbol} a day`, 'propose', [ChangeKind.DailyLimit, zeroAddress, token, amount])
    setText('')
  }

  return (
    <section className="card">
      <h2>Raise a daily limit</h2>
      <p className="muted small">
        Today: {formatAmount(holding.dailyLimit, holding.decimals)} {holding.symbol} a day. A raise needs your phone's
        approval, then a wait of {formatDuration(vault.looseningWait)}, then one more tap to switch it on.
      </p>
      <div className="form">
        <label>
          <span>New limit</span>
          <input inputMode="decimal" placeholder="0" value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <select value={token} onChange={(e) => setToken(e.target.value)}>
          {vault.holdings.map((h) => <option key={h.token} value={h.token}>{h.symbol}</option>)}
        </select>
        <button onClick={propose} disabled={!isEveryday || busy || !amount || Boolean(error)}>Propose</button>
      </div>
      {error && <p className="error">{error}</p>}
      {!isEveryday && <p className="muted small">Switch MetaMask to the Everyday key to propose.</p>}
      <TxStatus tx={tx} />
      {tx.status === 'done' && (
        <p className="muted small">
          Now open the <a href="#phone">phone page</a> with the Rules key to approve it.
        </p>
      )}
    </section>
  )
}
