import { useState } from 'react'
import { getAddress, isAddress } from 'viem'
import { FACTORY, factoryAbi } from './config.js'
import { useTx } from './hooks.js'
import SnapStep from './SnapStep.jsx'
import TxStatus from './TxStatus.jsx'

export default function CreateVault({ account, blocked, loading, onDone }) {
  const [text, setText] = useState('')
  const { tx, send, busy } = useTx(account, onDone)
  const trimmed = text.trim()
  const valid = isAddress(trimmed, { strict: false })
  const same = valid && getAddress(trimmed) === account
  const error = !trimmed ? null : !valid ? "That isn't a valid address" : same ? "Your phone's key must be different from this one" : null

  if (!FACTORY) {
    return (
      <section className="card notice">
        <h2>No vault for this key</h2>
        <p>This key isn't the Everyday key or the Rules key of any vault the app knows.</p>
      </section>
    )
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2>Create my vault</h2>
        <button className="secondary compact" onClick={() => onDone()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      <p>
        You don't have a vault yet. This key becomes its <strong>Everyday key</strong>, which can spend within your
        rules. Your phone's key becomes its <strong>Rules key</strong>, the only key that can change them.
      </p>
      <label className="stack">
        <span className="muted small">Your phone's address (the Rules key)</span>
        <input className="address" placeholder="0x…" value={text} onChange={(e) => setText(e.target.value)} />
      </label>
      <p className="muted small">Check it carefully. A vault's keys can never be changed.</p>
      {error && <p className="panel warn small">{error}</p>}
      <button
        className="big"
        onClick={() => send('Create my vault', { address: FACTORY, abi: factoryAbi }, 'createVault', [getAddress(trimmed)])}
        disabled={!valid || same || busy || blocked}
      >
        Create my vault
      </button>
      <TxStatus tx={tx} />
      <SnapStep />
    </section>
  )
}
