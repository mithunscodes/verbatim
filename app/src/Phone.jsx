import { useEffect, useState } from 'react'
import { createPublicClient, custom, getAddress, isAddress, keccak256, stringToBytes, zeroAddress } from 'viem'
import { dnsName, getWallet, nameResolver, normalName, readEnsRecords, resolveName } from './chain.js'
import { limits } from './Caught.jsx'
import { nameOf } from './checks.js'
import { formatCountdown, formatDuration, formatMoment, formatTime, shortAddress } from './format.js'
import {
  chain,
  DEMO_STRANGER,
  DEMO_TIMINGS,
  PERMIT2,
  PRINTS,
  ENS_CONTACT_NAME_ROLES,
  ENS_ETH_REGISTRY,
  ENS_ROLE_REGISTRAR,
  ensRegistryAbi,
  ETH_COIN_TYPE,
  resolverAbi,
  vaultAbi,
} from './config.js'
import { useNow, useTx } from './hooks.js'
import { Rolling, Words } from './Motion.jsx'
import Setup from './Setup.jsx'
import { canSwitchOn, describeChange, ensStatusOf, statusOf } from './rules.js'
import TxStatus from './TxStatus.jsx'

const STAMPS = {
  approved: ['Approved', ''],
  ready: ['Ready', ''],
  done: ['Switched on', ''],
  cancelled: ['Cancelled', 'plain'],
  used: ['Used', 'plain'],
  expired: ['Expired', 'plain'],
}

function pillFor(key) {
  if (key === 'waiting') return 'pill warn'
  if (key === 'approved' || key === 'ready') return 'pill ok'
  return 'pill plain'
}

function ChangeRow({ vault, change, now, isRules, busy, send, index = 0 }) {
  const target = { address: vault.address, abi: vaultAbi }
  const status = statusOf(change, now)
  const id = change.id
  const stamp = STAMPS[status.key]
  return (
    <li className={`change ${status.key}`} style={{ animationDelay: `${Math.min(index, 6) * 80}ms` }}>
      {stamp && <span key={status.key} className={`stamp big ${stamp[1]}`}>{stamp[0]}</span>}
      <p className="change-words">{describeChange(vault, change)}</p>
      <p className="change-meta">
        <span>Change #{id.toString()}</span>
        <span className={pillFor(status.key)}>{status.text}</span>
      </p>
      {status.until !== undefined && <span className="countdown"><Rolling value={formatCountdown(status.until - now)} /></span>}
      {status.open && (
        <div className="row">
          {status.key === 'waiting' && (
            <button className="big" onClick={() => send(`Approve change #${id}`, target, 'approve', [id])} disabled={!isRules || busy}>
              Approve
            </button>
          )}
          {canSwitchOn(change, status) && (
            <button className="big" onClick={() => send(`Switch on change #${id}`, target, 'switchOn', [id])} disabled={busy}>
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

export function ruleLabel(key) {
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
        Read live from <strong>{vault.ensName}</strong> in ENS. Only your vault can write them.
      </p>
      {failed && <p className="panel warn small">Couldn't read your ENS records. Try Refresh.</p>}
      {!data && !failed && <p className="muted">Reading {vault.ensName}…</p>}
      {data && (
        <>
          <h3>Pending changes, from ENS</h3>
          {open.length ? (
            <ul className="changes">
              {open.map((change, i) => {
                const status = ensStatusOf(change, now)
                return (
                  <li key={change.id} className={`change ${status.key}`} style={{ animationDelay: `${Math.min(i, 6) * 80}ms` }}>
                    <p className="change-words">{change.change}</p>
                    <p className="change-meta">
                      <span>Change #{change.id}</span>
                      <span className={pillFor(status.key)}>{status.text}</span>
                      {status.until !== undefined && <strong><Rolling value={formatCountdown(status.until - now)} /></strong>}
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
            {data.rules.map((rule, i) => (
              <li key={rule.key} style={{ animationDelay: `${Math.min(i, 8) * 50}ms` }}>
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

function isTokenOrContract(vault, address) {
  const known = [PERMIT2, PRINTS, ...(vault.trusted ?? []), ...vault.holdings.map((h) => h.token).filter((token) => token !== zeroAddress)]
  return known.some((account) => getAddress(account) === getAddress(address))
}

const NOT_A_PERSON = "That's a token or a trusted contract, not a person, so it can't be a contact"

function contactError(vault, trimmed, asName, name, lookup) {
  if (!trimmed) return null
  if (!asName) {
    if (!isAddress(trimmed, { strict: false })) return "That isn't a valid address or ENS name"
    if (getAddress(trimmed) === getAddress(vault.address)) return "Your account can't be its own contact"
    if (isTokenOrContract(vault, trimmed)) return NOT_A_PERSON
    return vault.contacts.some((c) => c.address === getAddress(trimmed)) ? 'Already a saved contact' : null
  }
  if (!name) return "That isn't a valid ENS name"
  if (!vault.directory) return "This vault is older than version 3, so it can't save ENS names. Paste the address instead."
  if (vault.contacts.some((c) => c.ensName === name)) return 'This name is already saved'
  if (lookup.status === 'failed') return "Couldn't read this name. Try again."
  if (lookup.status === 'done' && !lookup.address) return 'This name has no address'
  if (lookup.address && getAddress(lookup.address) === getAddress(vault.address)) return "This name points to your own account, which can't be its own contact"
  if (lookup.address && isTokenOrContract(vault, lookup.address)) return NOT_A_PERSON
  if (lookup.address && vault.contacts.some((c) => c.address === lookup.address)) return 'That address is already a saved contact'
  return null
}

const DAY = 86_400n

const NAME_LENGTHS = [DAY, 7n * DAY, 30n * DAY]

const DEMO_NAME_LENGTH = 300n

const DEMO_NAME_LENGTHS = [120n, DEMO_NAME_LENGTH]

const CUSTOM = 'custom'

const MAX_DAYS = 365n

function usesDemoTimes(vault) {
  return vault.newContactPeriod === DEMO_TIMINGS.newContactPeriod
}

function nowSeconds() {
  return BigInt(Math.floor(Date.now() / 1000))
}

function capped(end, limit) {
  return limit !== null && end > limit ? limit : end
}

function labelId(label) {
  return BigInt(keccak256(stringToBytes(label)))
}

function ContactRow({ vault, contact, index, isRules, busy, send }) {
  const newUntil = contact.savedAt + vault.newContactPeriod
  const { end } = contact
  const renewLengths = usesDemoTimes(vault) ? DEMO_NAME_LENGTHS : [DAY]
  const renewTo = (length) => (end ? capped((end.endsAt > nowSeconds() ? end.endsAt : nowSeconds()) + length, end.parentEnd) : 0n)
  const manage = (label, functionName, args) => send(label, { address: end.registry, abi: ensRegistryAbi }, functionName, args)
  const point = async (to, label) => {
    const resolver = await nameResolver(getWallet(), vault.directory, contact.ensName)
    if (resolver) await send(label, { address: resolver, abi: resolverAbi }, 'setAddress', [dnsName(contact.ensName), ETH_COIN_TYPE, to])
  }
  return (
    <li title={contact.address} style={{ animationDelay: `${Math.min(index, 8) * 60}ms` }}>
      <span className={contact.moved ? 'tile filled broken' : 'tile filled'}>{nameOf(vault, contact.address)}</span>
      {contact.ended ? (
        <span className="error small">Its name ended at {formatMoment(end.endsAt)}. Payments to it never happen until it's renewed.</span>
      ) : contact.moved ? (
        <span className="error small">
          Its name now points to {contact.currentAddress === zeroAddress ? 'nothing' : shortAddress(contact.currentAddress)}.
          Sends are stopped until the new address is approved.
        </span>
      ) : (
        <span className="muted small">
          {vault.timestamp < newUntil ? `New until ${formatTime(newUntil)}` : `Saved at ${formatTime(contact.savedAt)}`}
          {end?.temporary && ` · Ends ${formatMoment(end.endsAt)}`}
        </span>
      )}
      {isRules && contact.ensName && (
        <span className="name-demo">
          {contact.ended ? (
            contact.canManage && renewLengths.filter((length) => renewTo(length) > end.endsAt).map((length) => (
              <button key={String(length)} className="secondary" disabled={busy} onClick={() => manage(`Renew ${contact.ensName} for ${formatDuration(length)}`, 'renew', [labelId(end.label), renewTo(length)])}>
                Renew for {formatDuration(length)}
              </button>
            ))
          ) : contact.moved ? (
            <button className="secondary" disabled={busy} onClick={() => point(contact.address, `Put ${contact.ensName} back`)}>
              Put it back
            </button>
          ) : (
            <>
              {end?.temporary && contact.canManage && (
                <button
                  className="secondary"
                  disabled={busy}
                  title="Ends this name at once. Payments to it then never happen."
                  onClick={() => manage(`End ${contact.ensName} now`, 'unregister', [labelId(end.label)])}
                >
                  End now
                </button>
              )}
              <button
                className="secondary"
                disabled={busy}
                title="Demo: point this name at a stranger's address, as if it had been taken over. Payments to it then never happen."
                onClick={() => point(DEMO_STRANGER, `Demo: move ${contact.ensName} to a stranger`)}
              >
                Demo: move this name
              </button>
            </>
          )}
        </span>
      )}
    </li>
  )
}

function parentLabelOf(vault) {
  const match = /^([a-z0-9-]+)\.eth$/.exec(vault.ensName ?? '')
  return vault.directory && match ? match[1] : null
}

function useNaming(vault, account, label) {
  const parent = parentLabelOf(vault)
  const [naming, setNaming] = useState({ ready: false })
  useEffect(() => {
    if (!parent || !account) return undefined
    let current = true
    const wallet = getWallet()
    const client = createPublicClient({ chain, transport: custom(wallet) })
    const read = (address, functionName, args) => client.readContract({ address, abi: ensRegistryAbi, functionName, args })
    Promise.all([read(ENS_ETH_REGISTRY, 'getSubregistry', [parent]), read(ENS_ETH_REGISTRY, 'findExpiry', [parent]), nameResolver(wallet, vault.directory, vault.ensName)])
      .then(async ([registry, expiry, resolver]) => {
        const allowed = registry !== zeroAddress && resolver ? await read(registry, 'hasRootRoles', [ENS_ROLE_REGISTRAR, account]) : false
        if (current) setNaming({ ready: true, registry, expiry, resolver, allowed })
      })
      .catch(() => current && setNaming({ ready: true, allowed: false }))
    return () => {
      current = false
    }
  }, [parent, account, vault.directory, vault.ensName])
  const [taken, setTaken] = useState({ label: null, owner: null })
  useEffect(() => {
    if (!naming.allowed || !label) return undefined
    let current = true
    const client = createPublicClient({ chain, transport: custom(getWallet()) })
    const timer = setTimeout(() => {
      client.readContract({ address: naming.registry, abi: ensRegistryAbi, functionName: 'findOwner', args: [label] })
        .then((owner) => current && setTaken({ label, owner }))
        .catch(() => current && setTaken({ label, owner: null }))
    }, 400)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [naming.allowed, naming.registry, label])
  return { ...naming, parent, takenBy: taken.label === label ? taken.owner : undefined }
}

function labelError(label, full, takenBy) {
  if (!label) return null
  if (label.includes('.') || !full) return 'Use one word: letters, numbers or hyphens, no dots'
  if (takenBy && takenBy !== zeroAddress) return `${full} already exists. To save it, type the full name in the box above instead.`
  return null
}

function SaveContact({ vault, account, isRules, busy, send }) {
  const [text, setText] = useState('')
  const [label, setLabel] = useState('')
  const [choice, setChoice] = useState(null)
  const [days, setDays] = useState('')
  const lengths = usesDemoTimes(vault) ? [null, ...DEMO_NAME_LENGTHS, ...NAME_LENGTHS, CUSTOM] : [null, ...NAME_LENGTHS, CUSTOM]
  const trimmed = text.trim()
  const asName = trimmed.includes('.') && !trimmed.startsWith('0x')
  const name = asName ? normalName(trimmed) : null
  const lookup = useNameLookup(vault.directory, name && vault.directory ? name : null)
  const error = contactError(vault, trimmed, asName, name, lookup)
  const cleanLabel = label.trim()
  const full = cleanLabel && vault.ensName ? normalName(`${cleanLabel}.${vault.ensName}`) : null
  const naming = useNaming(vault, account, cleanLabel && !cleanLabel.includes('.') ? normalName(cleanLabel) : null)
  const canName = !asName && naming.allowed && isAddress(trimmed, { strict: false }) && !error
  const nameError = canName ? labelError(cleanLabel, full, naming.takenBy) : null
  const nameChecking = canName && Boolean(full) && naming.takenBy === undefined
  const daysLeft = naming.expiry ? (naming.expiry - nowSeconds()) / DAY : MAX_DAYS
  const maxDays = daysLeft < MAX_DAYS ? daysLeft : MAX_DAYS
  const customOk = /^[1-9][0-9]*$/.test(days.trim()) && BigInt(days.trim()) <= maxDays
  const length = choice === CUSTOM ? (customOk ? BigInt(days.trim()) * DAY : null) : choice
  const customError = canName && full && choice === CUSTOM && days.trim() && !customOk ? `Choose a whole number of days, from 1 to ${maxDays}` : null
  const canSave = Boolean(trimmed) && !error && (!asName || Boolean(lookup.address)) && !nameError && !nameChecking
    && !(canName && full && choice === CUSTOM && !customOk)
  const save = async () => {
    const target = { address: vault.address, abi: vaultAbi }
    if (asName) send(`Save ${name}`, target, 'saveContactName', [name])
    else if (canName && full) {
      const address = getAddress(trimmed)
      const subLabel = full.slice(0, -(vault.ensName.length + 1))
      const pointed = await send(`Point ${full} to ${shortAddress(address)} (1 of 3)`, { address: naming.resolver, abi: resolverAbi }, 'setAddress', [
        dnsName(full),
        ETH_COIN_TYPE,
        address,
      ])
      if (!pointed) return
      const ends = length ? capped(nowSeconds() + length, naming.expiry) : naming.expiry
      const created = await send(`Create ${full} (2 of 3)`, { address: naming.registry, abi: ensRegistryAbi }, 'register', [
        subLabel,
        account,
        zeroAddress,
        naming.resolver,
        ENS_CONTACT_NAME_ROLES,
        ends,
      ])
      if (!created) return
      await send(`Save ${full} (3 of 3)`, target, 'saveContactName', [full])
    } else send(`Save ${shortAddress(getAddress(trimmed))}`, target, 'saveContact', [getAddress(trimmed)])
    setText('')
    setLabel('')
    setChoice(null)
    setDays('')
  }
  return (
    <section className="card">
      <h2>Save a contact</h2>
      <p className="muted small">
        Paste an address or an ENS name. Contacts can't be removed, so check carefully.
      </p>
      <div className="row">
        <input className="address" placeholder="0x… or name.eth" value={text} onChange={(e) => setText(e.target.value)} />
        <button onClick={save} disabled={!isRules || busy || !canSave}>Save contact</button>
      </div>
      {canName && (
        <div className="name-contact">
          <label className="stack">
            <span className="muted small">Give it a name (optional)</span>
            <span className="name-field">
              <input placeholder="mom" value={label} onChange={(e) => setLabel(e.target.value.toLowerCase())} disabled={busy} />
              <span className="mono small">.{vault.ensName}</span>
            </span>
          </label>
          {full && !nameError && !nameChecking && (
            <>
              <div className="name-length" role="group" aria-label="How long?">
                {lengths.map((option) => (
                  <button key={String(option)} className={choice === option ? 'tab active' : 'tab'} onClick={() => setChoice(option)} disabled={busy}>
                    {option === null ? 'Keep' : option === CUSTOM ? 'Custom' : `${formatDuration(option)}${DEMO_NAME_LENGTHS.includes(option) ? ' (demo)' : ''}`}
                  </button>
                ))}
              </div>
              {choice === CUSTOM && (
                <label className="name-days">
                  <input type="number" min="1" max={String(maxDays)} step="1" placeholder="90" value={days} onChange={(e) => setDays(e.target.value)} disabled={busy} />
                  <span className="muted small">days (up to {maxDays.toString()})</span>
                </label>
              )}
              {customError && <p className="panel warn small">{customError}</p>}
              <p className="muted small">
                Creates <strong>{full}</strong>{length ? ` for ${formatDuration(length)}` : ''}. Three confirmations in MetaMask.
                {length ? ' After that, payments to it never happen unless your phone renews it.' : ''}
                {length && length <= vault.newContactPeriod ? ` It stays a new contact its whole life: at most ${limits(vault, 'newContactLimit')} can ever go to it.` : ''}
                {length && length > vault.newContactPeriod ? ` For its first ${formatDuration(vault.newContactPeriod)} it's a new contact: at most ${limits(vault, 'newContactLimit')}.` : ''}
                {choice === null ? ` Keep lasts until your own name ends, on ${formatMoment(naming.expiry)}.` : ''}
              </p>
            </>
          )}
          {nameChecking && <p className="muted small">Checking {full}…</p>}
          {nameError && <p className="panel warn small">{nameError}</p>}
        </div>
      )}
      {asName && name && !error && lookup.status === 'reading' && <p className="muted small">Reading {name}…</p>}
      {asName && !error && lookup.address && (
        <p className="panel ok small">
          {name} points to <span className="mono full">{lookup.address}</span>. Your vault saves this address, and every
          send checks that the name still points there.
        </p>
      )}
      {error && <p className="panel warn small">{error}</p>}
      <h3>Saved contacts</h3>
      <ul className="contact-tiles">
        {vault.contacts.map((contact, i) => (
          <ContactRow key={contact.address} vault={vault} contact={contact} index={i} isRules={isRules} busy={busy} send={send} />
        ))}
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
  const waiting = open.filter((change) => statusOf(change, now).key === 'waiting').length
  const headline = waiting
    ? `${waiting} change${waiting === 1 ? ' is' : 's are'} waiting for you`
    : open.length ? `${open.length} approved change${open.length === 1 ? '' : 's'}` : 'Nothing is waiting'

  return (
    <>
      <section className="hero">
        <h1 key={headline}><Words text={headline} step={70} /></h1>
        <p><Words text="Read straight from your vault, so no app can hide a change from you." delay={350} step={40} /></p>
      </section>

      {!isRules && (
        <section className="card notice">
          <h2>This is the Rules key's page</h2>
          <p>Anyone can see these changes. To approve, cancel or save contacts, switch MetaMask to the Rules key.</p>
        </section>
      )}

      {!vault.setupFinished && <Setup vault={vault} isRules={isRules} tx={tx} send={send} busy={busy} />}

      <section className="card">
        <h2>Pending changes</h2>
        <TxStatus tx={tx} />
        {open.length ? (
          <ul className="changes">
            {open.map((change, i) => <ChangeRow key={change.id} change={change} index={i} {...rowProps} />)}
          </ul>
        ) : (
          <p className="muted">Nothing is waiting.</p>
        )}
        {past.length > 0 && (
          <details className="fold">
            <summary>Past changes ({past.length})</summary>
            <ul className="changes">
              {past.map((change, i) => <ChangeRow key={change.id} change={change} index={i} {...rowProps} />)}
            </ul>
          </details>
        )}
      </section>

      <EnsRecords vault={vault} now={now} />

      <SaveContact vault={vault} account={account} isRules={isRules} busy={busy} send={send} />
    </>
  )
}
