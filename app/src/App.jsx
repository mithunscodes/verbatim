import { lazy, Suspense } from 'react'
import Attack from './Attack.jsx'
import { EXPLORER } from './config.js'
import { CopyButton } from './Copy.jsx'
import CreateVault from './CreateVault.jsx'
import Evidence from './Evidence.jsx'
import { formatAmount, shortAddress } from './format.js'
import Mint from './Mint.jsx'
import { Rolling, Words } from './Motion.jsx'
import Names from './Names.jsx'
import Phone from './Phone.jsx'
import Propose from './Propose.jsx'
import Request from './Request.jsx'
import { ReceiptPage, RecentReceipts } from './Receipt.jsx'
import Replays from './Replays.jsx'
import SideBySide from './SideBySide.jsx'
import { useHashPage } from './hooks.js'
import { useVault } from './useVault.js'
import { canSignIn } from './credits.js'
import { useVaultName } from './vaultName.js'

const ZeroG = lazy(() => import('./ZeroG.jsx'))

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
      {action && (
        <div className="actions">
          <button className="big" onClick={onAction}>{action}</button>
        </div>
      )}
    </section>
  )
}

function Balances({ vault, loading, onRefresh }) {
  const name = useVaultName(vault)
  return (
    <section className="card vault-card">
      <div className="card-head">
        <span className="eyebrow">Your vault holds</span>
        <button className="secondary compact" onClick={() => onRefresh()} disabled={loading}>
          {loading ? 'Reading…' : 'Refresh'}
        </button>
      </div>
      {vault ? (
        <ul className="balances">
          {vault.holdings.map((holding) => (
            <li key={holding.token}>
              <span className="amount"><Rolling value={formatAmount(holding.amount, holding.decimals)} /></span>
              <span className="symbol">{holding.symbol}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Reading the vault…</p>
      )}
      {vault && (
        <p className="muted small">
          Vault <AddressLink address={vault.address} name={vault.ensName} /> <CopyButton label="Copy address" text={vault.address} /> · read at block{' '}
          {vault.blockNumber.toLocaleString('en-US')}
        </p>
      )}
      {vault && vault.holdings.every((h) => h.amount === 0n) && (
        <p className="muted small">
          To add money, send test USDC to {vault.ensName ? <strong>{vault.ensName}</strong> : 'this address'}: <span className="mono full">{vault.address}</span>{' '}
          <CopyButton label="Copy address" text={vault.address} />
        </p>
      )}
      {vault && !vault.setupFinished && (
        <p className="panel warn small">
          Not set up yet, so nothing can be sent. Open the <a href="#phone">phone page</a> with the Rules key.
          {name?.name && name.status !== 'failed' && <> Your name, <strong>{name.name}</strong>, {name.status === 'done' ? 'is ready' : 'is being made on Sepolia'}.</>}
        </p>
      )}
    </section>
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
      <p className="small">Next time, leave MetaMask's "Added protection" switch off before you confirm.</p>
      {delegate && <p className="muted small">The key now runs code from <AddressLink address={delegate} />.</p>}
    </section>
  )
}

function Hero() {
  return (
    <section className="hero">
      <h1><Words text="Say what you want." step={90} /></h1>
      <p><Words text="That's the only thing your money can do." delay={450} step={60} /></p>
    </section>
  )
}

export default function App() {
  const page = useHashPage()
  if (page.startsWith('attack:')) {
    return (
      <div className="console-theme">
        <Attack link={page.slice('attack:'.length)} />
      </div>
    )
  }
  if (page.startsWith('side:')) {
    return (
      <div className="vb">
        <SideBySide link={page.slice('side:'.length)} />
      </div>
    )
  }
  if (page.startsWith('proof:')) {
    return (
      <div className="vb">
        <Evidence key={page} hash={page.slice('proof:'.length)} />
      </div>
    )
  }
  if (page === 'replays') {
    return (
      <div className="vb">
        <Replays />
      </div>
    )
  }
  if (page === 'mint') {
    return (
      <div className="vb">
        <Mint />
      </div>
    )
  }
  if (page.startsWith('names:')) {
    return (
      <div className="vb">
        <Names name={page.slice('names:'.length)} />
      </div>
    )
  }
  return (
    <div className="vb">
      <WalletApp page={page} />
    </div>
  )
}

function WalletApp({ page }) {
  const v = useVault()
  const ready = v.account && v.onSepolia && v.vault
  const receiptRoot = page.startsWith('receipt:') ? page.slice('receipt:'.length) : null

  return (
    <main className="page">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <nav className="nav">
            <a href="#" className={page === 'app' ? 'active' : undefined}>Pay</a>
            <a href="#phone" className={page === 'phone' ? 'active' : undefined}>Phone</a>
            <a href="#replays">Replays</a>
            <a href="#mint">Mint</a>
            <a href="#names">Names</a>
            <a href="/api/go">Attack it yourself</a>
          </nav>
        </div>
        {v.account && (
          <div className="who">
            <span className="dot" />
            <AddressLink address={v.account} name={v.vault?.names?.[v.account]} />
            {v.role && <span className="role">{v.role}</span>}
          </div>
        )}
      </header>

      {page === 'app' && <Hero />}

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

      {v.account && v.onSepolia && v.vaults?.length === 0 && (
        <CreateVault account={v.account} blocked={v.smart} loading={v.loading} onDone={v.refresh} />
      )}

      {receiptRoot && <ReceiptPage key={receiptRoot} root={receiptRoot} account={v.account} vault={v.vault} />}
      {receiptRoot && v.account && <RecentReceipts account={v.account} current={receiptRoot} />}

      {!receiptRoot && page !== 'phone' && v.account && v.onSepolia && v.vaults?.length !== 0 && (
        <Balances vault={v.vault} loading={v.loading} onRefresh={v.refresh} />
      )}

      {page === 'app' && canSignIn() && (
        <Suspense fallback={null}>
          <ZeroG />
        </Suspense>
      )}

      {ready && page === 'app' && (
        <div key={v.vault.address} className="page-flow">
          <Request vault={v.vault} role={v.role} blocked={v.smart} onDone={v.refresh} />
          <Propose vault={v.vault} role={v.role} account={v.account} blocked={v.smart} onDone={v.refresh} />
          <RecentReceipts account={v.account} />
        </div>
      )}

      {ready && page === 'phone' && (
        <div className="phone-page">
          <Phone key={v.vault.address} vault={v.vault} account={v.account} role={v.role} blocked={v.smart} onDone={v.refresh} />
        </div>
      )}

      {page === 'phone' && v.account && v.onSepolia && v.vaults?.length !== 0 && (
        <Balances vault={v.vault} loading={v.loading} onRefresh={v.refresh} />
      )}

      {v.error && <p className="panel warn">{v.error}</p>}
    </main>
  )
}
