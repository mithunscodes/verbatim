import Attack from './Attack.jsx'
import { EXPLORER } from './config.js'
import CreateVault from './CreateVault.jsx'
import { formatAmount, shortAddress } from './format.js'
import Phone from './Phone.jsx'
import Propose from './Propose.jsx'
import Request from './Request.jsx'
import { ReceiptPage } from './Receipt.jsx'
import Replays from './Replays.jsx'
import SideBySide from './SideBySide.jsx'
import { useHashPage } from './hooks.js'
import { useVault } from './useVault.js'

function AddressLink({ address, name }) {
  return (
    <a className={name ? undefined : 'mono'} href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer" title={address}>
      {name ?? shortAddress(address)}
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
        <button className="secondary" onClick={() => onRefresh()} disabled={loading}>
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
      {vault && (
        <p className="muted small">
          Vault <AddressLink address={vault.address} name={vault.ensName} /> · read at block {vault.blockNumber.toLocaleString('en-US')}
        </p>
      )}
      {vault && vault.holdings.every((h) => h.amount === 0n) && (
        <p className="muted small">
          To add money, send test USDC to {vault.ensName ? <strong>{vault.ensName}</strong> : 'this address'}: <span className="mono full">{vault.address}</span>
        </p>
      )}
      {vault && !vault.setupFinished && (
        <p className="error small">Not set up yet, so nothing can be sent. Open the <a href="#phone">phone page</a> with the Rules key.</p>
      )}
    </section>
  )
}

function VaultPicker({ vaults, selected, onChoose }) {
  return (
    <label className="picker">
      <span className="muted small">Vault</span>
      <select value={selected} onChange={(e) => onChoose(e.target.value)}>
        {vaults.map((v) => (
          <option key={v.address} value={v.address}>
            {v.ensName ?? shortAddress(v.address)} · you're its {v.role} · Everyday key {v.everydayName ?? shortAddress(v.everydayKey)}
          </option>
        ))}
      </select>
    </label>
  )
}

function SmartAccountAlert({ delegate }) {
  return (
    <section className="card alert">
      <h2>MetaMask turned this key into a smart account</h2>
      <p>Sending is blocked until you switch it back. MetaMask's smart-account route keeps failing on Sepolia, and while a key is a smart account, a tricked signature could make it act.</p>
      <ol>
        <li>Open MetaMask and click the account name at the top.</li>
        <li>Click the three dots next to this account, then <strong>Account details</strong>.</li>
        <li>Open <strong>Smart account</strong> and switch it off for Sepolia (MetaMask may call this <strong>Switch back</strong>), then confirm.</li>
        <li>Come back here and click <strong>Refresh</strong>.</li>
      </ol>
      <p className="small">Next time, untick "secure" before you confirm in MetaMask.</p>
      {delegate && <p className="muted small">The key now runs code from <AddressLink address={delegate} />.</p>}
    </section>
  )
}

export default function App() {
  const page = useHashPage()
  if (page.startsWith('attack:')) return <Attack link={page.slice('attack:'.length)} />
  if (page.startsWith('side:')) return <SideBySide link={page.slice('side:'.length)} />
  if (page === 'replays') return <Replays />
  return <WalletApp page={page} />
}

function WalletApp({ page }) {
  const v = useVault()
  const ready = v.account && v.onSepolia && v.vault
  const receiptRoot = page.startsWith('receipt:') ? page.slice('receipt:'.length) : null

  return (
    <main className="page">
      <header className="top">
        <div>
          <h1>Verbatim</h1>
          <nav className="nav">
            <a href="#" className={page === 'app' ? 'active' : undefined}>App</a>
            <a href="#phone" className={page === 'phone' ? 'active' : undefined}>Phone page</a>
            <a href="#replays">Replays</a>
          </nav>
        </div>
        {v.account && (
          <div className="who">
            <AddressLink address={v.account} name={v.vault?.names?.[v.account]} />
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

      {v.account && v.onSepolia && v.smart && <SmartAccountAlert delegate={v.delegate} />}

      {v.account && v.onSepolia && v.vaults?.length > 1 && v.vault && (
        <VaultPicker vaults={v.vaults} selected={v.vault.address} onChoose={v.choose} />
      )}

      {v.account && v.onSepolia && v.vaults?.length === 0 && (
        <CreateVault account={v.account} blocked={v.smart} loading={v.loading} onDone={v.refresh} />
      )}

      {receiptRoot && <ReceiptPage key={receiptRoot} root={receiptRoot} account={v.account} />}

      {!receiptRoot && v.account && v.onSepolia && v.vaults?.length !== 0 && (
        <Balances vault={v.vault} loading={v.loading} onRefresh={v.refresh} />
      )}

      {ready && page === 'app' && (
        <div key={v.vault.address}>
          <Request vault={v.vault} role={v.role} blocked={v.smart} onDone={v.refresh} />
          <Propose vault={v.vault} role={v.role} account={v.account} blocked={v.smart} onDone={v.refresh} />
        </div>
      )}

      {ready && page === 'phone' && (
        <Phone key={v.vault.address} vault={v.vault} account={v.account} role={v.role} blocked={v.smart} onDone={v.refresh} />
      )}

      {v.error && <p className="error">{v.error}</p>}
    </main>
  )
}
