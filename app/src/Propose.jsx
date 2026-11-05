import { useState } from 'react'
import { parseUnits, zeroAddress } from 'viem'
import { holdingOf, nameOf } from './checks.js'
import { amountPattern, formatAmount, formatDuration, shortAddress } from './format.js'
import { vaultAbi } from './config.js'
import { useTx } from './hooks.js'
import { ChangeKind } from './rules.js'
import TxStatus from './TxStatus.jsx'

function MovedContacts({ vault, isEveryday, account, blocked, onDone }) {
  const { tx, send, busy } = useTx(account, onDone)
  const moved = vault.contacts.filter((c) => c.moved)
  if (moved.length === 0) return null
  const proposed = (contact) => vault.changes.some((c) =>
    c.kind === ChangeKind.ContactAddress && c.contact === contact.address && c.value === BigInt(contact.currentAddress) && !c.cancelled && !c.done)
  return (
    <section className="card alert">
      <h2>A contact's name points somewhere new</h2>
      <p className="small">
        Your vault stops all sends to these contacts. If the change is real, propose the new address. Your phone must
        approve it, then it waits {formatDuration(vault.looseningWait)}, and then it counts as a new contact.
      </p>
      <ul className="contacts">
        {moved.map((contact) => (
          <li key={contact.address}>
            <span>{nameOf(vault, contact.address)} now points to {contact.currentAddress === zeroAddress ? 'nothing' : shortAddress(contact.currentAddress)}</span>
            {contact.currentAddress !== zeroAddress && (
              proposed(contact) ? (
                <span className="muted small">Proposed. Approve it on the phone page.</span>
              ) : (
                <button
                  onClick={() => send(`Propose the new address for ${nameOf(vault, contact.address)}`, { address: vault.address, abi: vaultAbi }, 'propose', [ChangeKind.ContactAddress, contact.address, zeroAddress, BigInt(contact.currentAddress)])}
                  disabled={!isEveryday || busy || blocked}
                >
                  Propose the new address
                </button>
              )
            )}
          </li>
        ))}
      </ul>
      {!isEveryday && <p className="muted small">Switch MetaMask to the Everyday key to propose.</p>}
      <TxStatus tx={tx} />
    </section>
  )
}

export default function Propose(props) {
  return (
    <>
      <MovedContacts vault={props.vault} isEveryday={props.role === 'Everyday key'} account={props.account} blocked={props.blocked} onDone={props.onDone} />
      <RaiseLimit {...props} />
    </>
  )
}

function RaiseLimit({ vault, role, account, blocked, onDone }) {
  const usdc = vault.holdings.find((h) => h.token !== zeroAddress)?.token ?? zeroAddress
  const [token, setToken] = useState(usdc)
  const [text, setText] = useState('')
  const { tx, send, busy } = useTx(account, onDone)
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
    send(`Propose ${formatAmount(amount, holding.decimals)} ${holding.symbol} a day`, { address: vault.address, abi: vaultAbi }, 'propose', [ChangeKind.DailyLimit, zeroAddress, token, amount])
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
        <button onClick={propose} disabled={!isEveryday || busy || blocked || !amount || Boolean(error)}>Propose</button>
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
