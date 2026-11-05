import { EXPLORER } from './config.js'
import { shortAddress } from './format.js'

export default function TxStatus({ tx }) {
  if (tx.status === 'idle') return null
  const link = tx.hash && (
    <a className="mono" href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
      {shortAddress(tx.hash)}
    </a>
  )
  if (tx.status === 'signing') {
    return <p className="muted">{tx.label}: confirm in MetaMask. Keep the "secure" option off, then wait for the network…</p>
  }
  if (tx.status === 'done') return <p className="pass">✓ {tx.label}: done. {link}</p>
  if (tx.status === 'failed') return <p className="error">✗ {tx.label}: the vault refused it. {link}</p>
  return <p className="error">✗ {tx.label}: {tx.error}</p>
}
