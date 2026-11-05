import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { nameOf } from './checks.js'
import { formatCountdown, formatTime, shortAddress } from './format.js'
import { vaultAbi } from './config.js'
import { useNow, useTx } from './hooks.js'
import Setup from './Setup.jsx'
import { canSwitchOn, describeChange, statusOf } from './rules.js'
import TxStatus from './TxStatus.jsx'

function ChangeRow({ vault, change, now, isRules, busy, send }) {
  const target = { address: vault.address, abi: vaultAbi }
  const status = statusOf(change, now)
  const id = change.id
  return (
    <li className={`change ${status.key}`}>
      <p className="change-words">{describeChange(vault, change)}</p>
      <p className="muted small">
        Change #{id.toString()} · {status.text}
        {status.until !== undefined && <> <strong>{formatCountdown(status.until - now)}</strong></>}
      </p>
      {status.open && (
        <div className="row">
          {status.key === 'waiting' && (
            <button onClick={() => send(`Approve change #${id}`, target, 'approve', [id])} disabled={!isRules || busy}>
              Approve
            </button>
          )}
          {canSwitchOn(change, status) && (
            <button onClick={() => send(`Switch on change #${id}`, target, 'switchOn', [id])} disabled={busy}>
              Switch on
            </button>
          )}
          <button className="secondary" onClick={() => send(`Cancel change #${id}`, target, 'cancel', [id])} disabled={!isRules || busy}>
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

function SaveContact({ vault, isRules, busy, send }) {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const valid = isAddress(trimmed, { strict: false })
  const known = valid && vault.contacts.some((c) => c.address === getAddress(trimmed))
  const error = !trimmed ? null : !valid ? "That isn't a valid address" : known ? 'Already a saved contact' : null
  const save = () => {
    send(`Save ${shortAddress(getAddress(trimmed))}`, { address: vault.address, abi: vaultAbi }, 'saveContact', [getAddress(trimmed)])
    setText('')
  }
  return (
    <section className="card">
      <h2>Save a contact</h2>
      <p className="muted small">
        Contacts can't be removed, so check the address carefully. A new contact can receive at most the
        new-contact limit for its first few minutes.
      </p>
      <div className="row">
        <input className="address" placeholder="0x…" value={text} onChange={(e) => setText(e.target.value)} />
        <button onClick={save} disabled={!isRules || busy || !valid || known}>Save contact</button>
      </div>
      {error && <p className="error">{error}</p>}
      <h3>Saved contacts</h3>
      <ul className="contacts">
        {vault.contacts.map((contact) => {
          const newUntil = contact.savedAt + vault.newContactPeriod
          return (
            <li key={contact.address}>
              <span>{nameOf(vault, contact.address)}</span>
              <span className="muted small">
                {vault.timestamp < newUntil ? `New until ${formatTime(newUntil)}` : `Saved at ${formatTime(contact.savedAt)}`}
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function Phone({ vault, account, role, blocked, onDone }) {
  const now = useNow()
  const { tx, send, busy: sending } = useTx(account, onDone)
  const busy = sending || blocked
  const isRules = role === 'Rules key'
  const newestFirst = [...vault.changes].reverse()
  const open = newestFirst.filter((change) => statusOf(change, now).open)
  const past = newestFirst.filter((change) => !statusOf(change, now).open)
  const rowProps = { vault, now, isRules, busy, send }

  return (
    <>
      {!isRules && (
        <section className="card notice">
          <h2>This is the Rules key's page</h2>
          <p>Anyone can see these changes. To approve, cancel or save contacts, switch MetaMask to the Rules key.</p>
        </section>
      )}

      {!vault.setupFinished && <Setup vault={vault} isRules={isRules} tx={tx} send={send} busy={busy} />}

      <section className="card">
        <h2>Pending changes</h2>
        <p className="muted small">Read straight from your vault, so no app can hide a change from you.</p>
        <TxStatus tx={tx} />
        {open.length ? (
          <ul className="changes">
            {open.map((change) => <ChangeRow key={change.id} change={change} {...rowProps} />)}
          </ul>
        ) : (
          <p className="muted">Nothing is waiting.</p>
        )}
        {past.length > 0 && (
          <details className="fold">
            <summary>Past changes ({past.length})</summary>
            <ul className="changes">
              {past.map((change) => <ChangeRow key={change.id} change={change} {...rowProps} />)}
            </ul>
          </details>
        )}
      </section>

      <SaveContact vault={vault} isRules={isRules} busy={busy} send={send} />
    </>
  )
}
