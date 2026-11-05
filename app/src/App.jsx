import { EXPLORER, VAULT } from './config.js'
import { formatAmount, shortAddress } from './format.js'
import Phone from './Phone.jsx'
import Propose from './Propose.jsx'
import Request from './Request.jsx'
import { useHashPage } from './hooks.js'
import { useVault } from './useVault.js'

function AddressLink({ address }) {
  return (
    <a className="mono" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">
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
  const page = useHashPage()
  const ready = v.account && v.onSepolia && v.vault

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>Verbatim</h1>
          <nav className="nav">
            <a href="#" className={page === 'app' ? 'active' : undefined}>App</a>
            <a href="#phone" className={page === 'phone' ? 'active' : undefined}>Phone page</a>
          </nav>
        </div>
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

      {ready && page === 'app' && (
        <>
          <Request vault={v.vault} role={v.role} onDone={v.refresh} />
          <Propose vault={v.vault} role={v.role} account={v.account} onDone={v.refresh} />
        </>
      )}

      {ready && page === 'phone' && (
        <Phone vault={v.vault} account={v.account} role={v.role} onDone={v.refresh} />
      )}

      {v.error && <p className="error">{v.error}</p>}
    </main>
  )
}
