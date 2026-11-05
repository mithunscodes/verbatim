import { useEffect, useState } from 'react'
import { getAddress, isAddress, zeroAddress } from 'viem'
import { getWallet, normalName, readEnsRecords, resolveName } from './chain.js'
import { nameOf } from './checks.js'
import { formatCountdown, formatTime, shortAddress } from './format.js'
import { vaultAbi } from './config.js'
import { useNow, useTx } from './hooks.js'
import Setup from './Setup.jsx'
import { canSwitchOn, describeChange, ensStatusOf, statusOf } from './rules.js'
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

const RULE_LABELS = {
  allowanceValidity: 'Approved changes stay valid for',
  newContactPeriod: 'Contacts count as new for',
  allowanceMinAge: 'One-off payments only to contacts saved at least',
  looseningWait: 'Changes wait before they can switch on',
  tradeTolerance: 'Trades may be below the fair price by up to',
  priceSource: 'Fair-price source',
}

function ruleLabel(key) {
  const [kind, symbol] = key.split('.')
  if (kind === 'dailyLimit') return `Daily limit for ${symbol}`
  if (kind === 'newContactLimit') return `New-contact limit for ${symbol}`
  return RULE_LABELS[kind] ?? key
}

function EnsRecords({ vault, now }) {
  const [records, setRecords] = useState({ block: null, data: null, failed: false })
  useEffect(() => {
    let current = true
    readEnsRecords(getWallet(), vault)
      .then((data) => current && setRecords({ block: vault.blockNumber, data, failed: false }))
      .catch(() => current && setRecords({ block: vault.blockNumber, data: null, failed: true }))
    return () => {
      current = false
    }
  }, [vault])
  if (!vault.ensName) return null
  const { data, failed } = records
  const open = data ? [...data.changes].reverse().filter((change) => ensStatusOf(change, now).open) : []
  return (
    <section className="card">
      <h2>Your rules in ENS</h2>
      <p className="muted small">
        Read from the text records of <strong>{vault.ensName}</strong>, which only your vault can write. Anyone can check
        them in any ENS app.
      </p>
      {failed && <p className="error small">Couldn't read your ENS records. Try Refresh.</p>}
      {!data && !failed && <p className="muted">Reading {vault.ensName}…</p>}
      {data && (
        <>
          <h3>Pending changes, from ENS</h3>
          {open.length ? (
            <ul className="changes">
              {open.map((change) => {
                const status = ensStatusOf(change, now)
                return (
                  <li key={change.id} className={`change ${status.key}`}>
                    <p className="change-words">{change.change}</p>
                    <p className="muted small">
                      Change #{change.id} · {status.text}
                      {status.until !== undefined && <> <strong>{formatCountdown(status.until - now)}</strong></>}
                    </p>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="muted">Nothing is waiting.</p>
          )}
          <h3>Rules, from ENS</h3>
          <ul className="contacts">
            {data.rules.map((rule) => (
              <li key={rule.key}>
                <span>{ruleLabel(rule.key)}</span>
                <span className="muted small">{rule.key === 'priceSource' && rule.value?.startsWith('0x') ? nameOf(vault, getAddress(rule.value)) : rule.value || 'not written yet'}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

function useNameLookup(directory, name) {
  const [lookup, setLookup] = useState({ name: null, status: 'idle', address: null })
  useEffect(() => {
    if (!name || !directory) return undefined
    let current = true
    setLookup({ name, status: 'reading', address: null })
    const timer = setTimeout(() => {
      resolveName(getWallet(), directory, name)
        .then((address) => current && setLookup({ name, status: 'done', address }))
        .catch(() => current && setLookup({ name, status: 'failed', address: null }))
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [directory, name])
  return lookup.name === name ? lookup : { name, status: 'reading', address: null }
}

function contactError(vault, trimmed, asName, name, lookup) {
  if (!trimmed) return null
  if (!asName) {
    if (!isAddress(trimmed, { strict: false })) return "That isn't a valid address or ENS name"
    return vault.contacts.some((c) => c.address === getAddress(trimmed)) ? 'Already a saved contact' : null
  }
  if (!name) return "That isn't a valid ENS name"
  if (!vault.directory) return "This vault is older than version 3, so it can't save ENS names. Paste the address instead."
  if (vault.contacts.some((c) => c.ensName === name)) return 'This name is already saved'
  if (lookup.status === 'failed') return "Couldn't read this name. Try again."
  if (lookup.status === 'done' && !lookup.address) return 'This name has no address'
  if (lookup.address && vault.contacts.some((c) => c.address === lookup.address)) return 'That address is already a saved contact'
  return null
}

function ContactRow({ vault, contact }) {
  const newUntil = contact.savedAt + vault.newContactPeriod
  return (
    <li title={contact.address}>
      <span>{nameOf(vault, contact.address)}</span>
      {contact.moved ? (
        <span className="error small">
          Its name now points to {contact.currentAddress === zeroAddress ? 'nothing' : shortAddress(contact.currentAddress)}.
          Sends are stopped until the new address is approved.
        </span>
      ) : (
        <span className="muted small">
          {vault.timestamp < newUntil ? `New until ${formatTime(newUntil)}` : `Saved at ${formatTime(contact.savedAt)}`}
        </span>
      )}
    </li>
  )
}

function SaveContact({ vault, isRules, busy, send }) {
  const [text, setText] = useState('')
  const trimmed = text.trim()
  const asName = trimmed.includes('.') && !trimmed.startsWith('0x')
  const name = asName ? normalName(trimmed) : null
  const lookup = useNameLookup(vault.directory, name && vault.directory ? name : null)
  const error = contactError(vault, trimmed, asName, name, lookup)
  const canSave = Boolean(trimmed) && !error && (!asName || Boolean(lookup.address))
  const save = () => {
    const target = { address: vault.address, abi: vaultAbi }
    if (asName) send(`Save ${name}`, target, 'saveContactName', [name])
    else send(`Save ${shortAddress(getAddress(trimmed))}`, target, 'saveContact', [getAddress(trimmed)])
    setText('')
  }
  return (
    <section className="card">
      <h2>Save a contact</h2>
      <p className="muted small">
        Paste an address, or type an ENS name like ravi.yourname.eth. Contacts can't be removed, so check carefully.
        A new contact can receive at most the new-contact limit for its first few minutes.
      </p>
      <div className="row">
        <input className="address" placeholder="0x… or name.eth" value={text} onChange={(e) => setText(e.target.value)} />
        <button onClick={save} disabled={!isRules || busy || !canSave}>Save contact</button>
      </div>
      {asName && name && !error && lookup.status === 'reading' && <p className="muted small">Reading {name}…</p>}
      {asName && !error && lookup.address && (
        <p className="muted small">
          {name} points to <span className="mono full">{lookup.address}</span>. Your vault saves this address, and every
          send checks that the name still points there.
        </p>
      )}
      {error && <p className="error">{error}</p>}
      <h3>Saved contacts</h3>
      <ul className="contacts">
        {vault.contacts.map((contact) => <ContactRow key={contact.address} vault={vault} contact={contact} />)}
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

      <EnsRecords vault={vault} now={now} />

      <SaveContact vault={vault} isRules={isRules} busy={busy} send={send} />
    </>
  )
}
