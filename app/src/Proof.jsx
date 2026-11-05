import { shortAddress } from './format.js'

const ZG_EXPLORER = 'https://chainscan.0g.ai/address'

export default function Proof({ proof }) {
  if (!proof) return null
  return (
    <details className={`proof ${proof.verified ? 'ok' : 'bad'}`}>
      <summary>{proof.verified ? 'Sealed hardware ✓' : '⚠️ Sealed hardware not confirmed'}</summary>
      <ul>
        {proof.model && <li>Model: {proof.model}, running inside sealed hardware ({proof.verifiability})</li>}
        {proof.provider && <li>Provider: <span className="mono">{shortAddress(proof.provider)}</span></li>}
        {proof.registeredSigner && (
          <li>
            Its sealed signer, registered on 0G's chain:{' '}
            <a className="mono" href={`${ZG_EXPLORER}/${proof.registry?.contract}`} target="_blank" rel="noreferrer">
              {shortAddress(proof.registeredSigner)}
            </a>
          </li>
        )}
        {proof.recoveredSigner && <li>This answer's signature is from: <span className="mono">{shortAddress(proof.recoveredSigner)}</span></li>}
        {proof.chatId && <li>Chat ID: <span className="mono">{proof.chatId}</span></li>}
        <li>Checked by your Verbatim server, not by 0G's Router</li>
      </ul>
      {proof.problem && <p className="error small">{proof.problem}</p>}
      <p className="muted small">{proof.note}</p>
    </details>
  )
}
