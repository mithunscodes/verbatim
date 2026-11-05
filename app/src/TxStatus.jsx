import { EXPLORER } from './config.js'
import { shortAddress } from './format.js'
import { Check, Cross, Spinner } from './Motion.jsx'

export default function TxStatus({ tx }) {
  if (tx.status === 'idle') return null
  const link = tx.hash && (
    <a className="mono" href={`${EXPLORER}/tx/${tx.hash}`} target="_blank" rel="noreferrer">
      {shortAddress(tx.hash)}
    </a>
  )
  if (tx.status === 'signing') {
    return <p className="tx-status signing"><Spinner />{tx.label}: confirm in MetaMask. Leave its "Added protection" switch off, then wait for the network…</p>
  }
  if (tx.status === 'done') return <p className="tx-status done"><Check size={26} />{tx.label}: done. {link}</p>
  if (tx.status === 'failed') return <p className="tx-status failed"><span className="mark-bad"><Cross size={26} /></span>{tx.label}: the vault refused it. {link}</p>
  return <p className="tx-status error"><span className="mark-bad"><Cross size={26} /></span>{tx.label}: {tx.error}</p>
}
