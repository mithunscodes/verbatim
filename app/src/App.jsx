import { EXPLORER, VAULT } from './config.js'
import { formatAmount, shortAddress } from './format.js'
import Request from './Request.jsx'
import { useVault } from './useVault.js'

function AddressLink({ address }) {
  return (
    <a href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
      {shortAddress(address)}
    </a>
  )
}

function Notice({ title, children, action, onAction }) {
  return (
    <section className="card notice">
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <button onClick={onAction}>{action}</button>}
    </section>
  )
}

function Balances({ vault, loading, onRefresh }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Your vault holds</h2>
        <button className="secondary" onClick={onRefresh} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {vault ? (
        <ul className="balances">
          {vault.holdings.map((holding) => (
            <li key={holding.token}>
              <span className="amount">{formatAmount(holding.amount, holding.decimals)}</span>
              <span className="symbol">{holding.symbol}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Reading the vault…</p>
      )}
      <p className="muted small">
        Vault <AddressLink address={VAULT} />
        {vault && <> · read at block {vault.blockNumber.toLocaleString('en-US')}</>}
      </p>
    </section>
  )
}

export default function App() {
  const v = useVault()

  return (
    <main className="page">
      <header className="top">
        <h1>Verbatim</h1>
        {v.account && (
          <div className="who">
            <AddressLink address={v.account} />
            {v.role && <span className="role">{v.role}</span>}
          </div>
        )}
      </header>

      {!v.hasWallet && (
        <Notice title="MetaMask not found">
          Open this page in the Verbatim browser profile, where MetaMask is installed.
        </Notice>
      )}

      {v.hasWallet && !v.account && (
        <Notice title="Connect your wallet" action="Connect MetaMask" onAction={v.connect}>
          Verbatim reads your vault through MetaMask.
        </Notice>
      )}

      {v.account && !v.onSepolia && (
        <Notice title="Wrong network" action="Switch to Sepolia" onAction={v.switchNetwork}>
          Verbatim only works on the Sepolia test network.
        </Notice>
      )}

      {v.account && v.onSepolia && (
        <Balances vault={v.vault} loading={v.loading} onRefresh={v.refresh} />
      )}

      {v.account && v.onSepolia && v.vault && <Request vault={v.vault} role={v.role} onDone={v.refresh} />}

      {v.error && <p className="error">{v.error}</p>}
    </main>
  )
}
