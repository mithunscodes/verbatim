import { useEffect, useState } from 'react'
import { getAddress } from 'viem'
import { DEMO_ENS_NAME, EXPLORER, PRICE_SOURCE } from './config.js'
import { demoClients, demoRpcUrl } from './demo.js'
import { formatMoment, shortAddress } from './format.js'
import { Dots, Words } from './Motion.jsx'
import { readName } from './names.js'
import { ruleLabel } from './Phone.jsx'

function Address({ address, children }) {
  return (
    <a className="mono" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" title={address}>
      {children ?? shortAddress(address)} ↗
    </a>
  )
}

function Row({ label, children }) {
  return (
    <li>
      <span>{label}</span>
      <span className="small">{children}</span>
    </li>
  )
}

function YourName({ found }) {
  const vault = found.vault
  return (
    <section className="card column" style={{ animationDelay: '200ms' }}>
      <span className="pill ink loss">Who you are</span>
      <h2>{found.name}</h2>
      <ul className="contacts">
        <Row label="Points to">{found.address ? <Address address={found.address} /> : 'nothing'}</Row>
        <Row label="Its resolver">
          {found.resolver ? (
            <>
              <Address address={found.resolver} /> {found.genuine ? '· genuine ENSv2 ✓' : '· not a genuine ENSv2 resolver ✗'}
            </>
          ) : 'none'}
        </Row>
        {found.owner && <Row label="Owned by">{vault && found.owner === vault.rulesKey ? <>the vault's Rules key, <Address address={found.owner} /></> : <Address address={found.owner} />}</Row>}
        {vault && <Row label="It's a Verbatim vault">{vault.ensName === found.name ? 'yes, and the vault gives the same name ✓' : 'yes'}</Row>}
        {vault && <Row label="Its everyday key">{<Address address={vault.everydayKey} />}</Row>}
      </ul>
      {!found.address && <p className="panel warn small">This name doesn't point anywhere on Sepolia.</p>}
      {found.address && !vault && <p className="muted small">This name points to an address that isn't a Verbatim vault.</p>}
    </section>
  )
}

function Contacts({ vault }) {
  const named = vault.contacts.filter((contact) => contact.name)
  const plain = vault.contacts.length - named.length
  return (
    <section className="card column" style={{ animationDelay: '320ms' }}>
      <span className="pill ink loss">Who's yours</span>
      <h2>Contacts, by name</h2>
      <p className="muted small">The vault pinned each address when the contact was saved. Every payment reads the name again: if it moved, the payment never happens.</p>
      {named.length ? (
        <ul className="contacts">
          {named.map((contact) => (
            <li key={contact.address}>
              <span className={contact.moved ? 'tile filled broken' : 'tile filled'}>{contact.name}</span>
              {contact.ended ? (
                <span className="error small">Ended at {formatMoment(contact.end.endsAt)}. Payments to it never happen until the phone renews it.</span>
              ) : contact.moved ? (
                <span className="error small">
                  Moved: it now points to {contact.now === '0x0000000000000000000000000000000000000000' ? 'nothing' : shortAddress(contact.now)}, not the pinned{' '}
                  {shortAddress(contact.address)}. Payments to it never happen until the phone approves the new address.
                </span>
              ) : (
                <span className="small">
                  still points to the pinned <Address address={contact.address} /> ✓{contact.end?.temporary && ` · ends ${formatMoment(contact.end.endsAt)}`}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No contacts saved by name yet.</p>
      )}
      {plain > 0 && <p className="muted small">Plus {plain} contact{plain === 1 ? '' : 's'} saved by plain address.</p>}
    </section>
  )
}

function Rules({ found }) {
  return (
    <section className="card column" style={{ animationDelay: '440ms' }}>
      <span className="pill ink loss">Published by the vault</span>
      <h2>Rules, from ENS</h2>
      <p className="muted small">Text records on {found.name}. Only the vault can write them, and anyone can read them.</p>
      {found.rules.length ? (
        <ul className="contacts">
          {found.rules.map((rule) => (
            <Row key={rule.key} label={ruleLabel(rule.key)}>
              {rule.key === 'priceSource' && rule.value.startsWith('0x') ? (
                <Address address={getAddress(rule.value)}>{getAddress(rule.value) === getAddress(PRICE_SOURCE) ? 'the Uniswap pool price reader' : shortAddress(getAddress(rule.value))}</Address>
              ) : (
                rule.value
              )}
            </Row>
          ))}
        </ul>
      ) : (
        <p className="muted small">No rules published on this name.</p>
      )}
    </section>
  )
}

function Directory({ vault }) {
  return (
    <section className="card column" style={{ animationDelay: '560ms' }}>
      <span className="pill ink loss">Who's real</span>
      <h2>The official directory</h2>
      <p className="muted small">The only contracts this vault will call. Each organization owns its name, and nobody, not even us, can change another's.</p>
      <ul className="contacts">
        {vault.official.map((entry) => (
          <Row key={entry.name} label={entry.name}>{entry.address && entry.address !== '0x0000000000000000000000000000000000000000' ? <Address address={entry.address} /> : 'not listed'}</Row>
        ))}
      </ul>
    </section>
  )
}

export default function Names({ name }) {
  const [text, setText] = useState(name || DEMO_ENS_NAME)
  const [state, setState] = useState({ status: 'idle' })
  const look = async (target) => {
    setState({ status: 'reading', name: target })
    try {
      const found = await readName(demoClients(demoRpcUrl()).reader, target)
      setState(found.problem ? { status: 'error', error: found.problem } : { status: 'done', found })
    } catch {
      setState({ status: 'error', error: "Couldn't read Sepolia right now. Try again in a moment." })
    }
  }
  useEffect(() => {
    look(name || DEMO_ENS_NAME)
  }, [name])
  const submit = (event) => {
    event.preventDefault()
    if (!text.trim()) return
    window.location.hash = `#names/${encodeURIComponent(text.trim())}`
    if (text.trim() === name) look(text.trim())
  }
  const found = state.found
  return (
    <main className="side">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <nav className="nav">
            <a href="#">Pay</a>
            <a href="#phone">Phone</a>
            <a href="#replays">Replays</a>
            <a href="#mint">Mint</a>
            <a href="#names" className="active">Names</a>
            <a href="/api/go">Attack it yourself</a>
          </nav>
        </div>
      </header>
      <header className="side-head">
        <div>
          <h1><Words text="Who's real, who's yours" step={90} /></h1>
          <p className="lead">Read live from ENSv2 on Sepolia, the same way the vault reads it during every payment. No wallet needed.</p>
        </div>
      </header>
      <form className="card names-search" onSubmit={submit}>
        <input className="address" value={text} onChange={(event) => setText(event.target.value)} aria-label="An ENS name" placeholder="yourname.eth" />
        <button type="submit" disabled={state.status === 'reading'}>Look it up</button>
      </form>
      {state.status === 'reading' && <p className="reading" role="status">Reading {state.name} from Sepolia <Dots /></p>}
      {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      {state.status === 'done' && (
        <div className="columns">
          <YourName found={found} />
          {found.vault && <Contacts vault={found.vault} />}
          {found.vault && <Rules found={found} />}
          {found.vault && <Directory vault={found.vault} />}
        </div>
      )}
    </main>
  )
}
