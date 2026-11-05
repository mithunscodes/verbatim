import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { DEMO_POLL_MS, EXPLORER } from './config.js'
import {
  demoClients,
  demoLink,
  demoRpcUrl,
  findScene,
  findTxs,
  nextScan,
  readBalances,
  readDemoLink,
  sameAddress,
  tokenAmount,
} from './demo.js'
import { formatAmount, shortAddress } from './format.js'

const SHOWN = 3

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]']

function useQr(text) {
  const [image, setImage] = useState(null)
  useEffect(() => {
    let current = true
    QRCode.toDataURL(text, { errorCorrectionLevel: 'M', margin: 2, width: 480 }).then((url) => current && setImage(url))
    return () => {
      current = false
    }
  }, [text])
  return image
}

function addEntries(entries, found, scene) {
  return found.reduce((list, entry) => {
    const newRun = entry.side === 'vault' && entry.ok && sameAddress(entry.to, scene.contact)
    return newRun ? [entry] : [...list, entry]
  }, entries)
}

function useWatch(demo) {
  const [state, setState] = useState({ scene: null, balances: null, entries: [], pending: false, error: null })
  useEffect(() => {
    if (!demo) return undefined
    const { reader } = demoClients(demoRpcUrl())
    let stopped = false
    let timer
    let scene = null
    let scanned = null
    let entries = []
    const tick = async () => {
      try {
        if (!scene?.vault || !scene.setupFinished || !scene.contact) scene = await findScene(reader, demo.everydayKey, demo.thief)
        if (scene.vault) {
          const balances = await readBalances(reader, scene)
          scanned ??= balances.blockNumber
          const range = nextScan(scanned, balances.blockNumber)
          if (range) {
            entries = addEntries(entries, await findTxs(reader, scene, range), scene)
            scanned = range.to
          }
          const [sent, mined] = await Promise.all([
            reader.getTransactionCount({ address: scene.everydayKey, blockTag: 'pending' }),
            reader.getTransactionCount({ address: scene.everydayKey, blockTag: 'latest' }),
          ])
          if (!stopped) setState({ scene, balances, entries, pending: sent > mined, error: null })
        } else if (!stopped) {
          setState((current) => ({ ...current, scene, error: null }))
        }
      } catch (error) {
        if (!stopped) setState((current) => ({ ...current, error: error?.shortMessage || error?.message || 'Something went wrong.' }))
      }
      if (!stopped) timer = setTimeout(tick, DEMO_POLL_MS)
    }
    tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [demo])
  return state
}

function openSideBySide(left, right) {
  const { availLeft = 0, availTop = 0, availWidth, availHeight } = window.screen
  const width = Math.floor(availWidth / 2)
  const place = (x) => `popup,left=${x},top=${availTop},width=${width},height=${availHeight}`
  const first = window.open(left, 'verbatim-normal-wallet', place(availLeft))
  const second = window.open(right, 'verbatim-vault', place(availLeft + width))
  return Boolean(first && second)
}

function describe(entry) {
  return entry.ok ? entry.done : `Tried to ${entry.what}. Refused: "${entry.reason}". Nothing moved.`
}

function headline(entry) {
  if (!entry.ok) return '✗ Failed'
  return entry.waiting ? "⏳ Waiting for the owner's phone" : '✓ Success'
}

function Column({ title, tagline, account, amount, scene, entries }) {
  const shown = entries.slice(-SHOWN).reverse()
  return (
    <section className="card column">
      <h2>{title}</h2>
      <p className="muted small">
        {tagline} ·{' '}
        <a className="mono" href={`${EXPLORER}/address/${account}`} target="_blank" rel="noreferrer">{shortAddress(account)}</a>
      </p>
      <p className="big-amount">
        {amount === undefined ? '…' : formatAmount(amount, scene.decimals)} <span className="symbol">{scene.symbol}</span>
      </p>
      {shown.length === 0 && <p className="muted">Nothing yet.</p>}
      <ul className="side-txs">
        {shown.map((entry) => (
          <li key={entry.hash} className={entry.ok ? (entry.waiting ? 'waiting-change' : 'ok') : 'failed'}>
            <strong>{headline(entry)}</strong>
            <span>{describe(entry)}</span>
            <a href={`${EXPLORER}/tx/${entry.hash}`} target="_blank" rel="noreferrer">Open on Etherscan ↗</a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Verdict({ scene, wallet, vault }) {
  const [blocked, setBlocked] = useState(false)
  const open = () => setBlocked(!openSideBySide(`${EXPLORER}/tx/${wallet.hash}`, `${EXPLORER}/tx/${vault.hash}`))
  return (
    <section className="card verdict">
      <h2>Same key. Same attack.</h2>
      <p>
        The normal wallet lost <strong>{tokenAmount(scene, wallet.amount)}</strong>. The Verbatim vault lost nothing: "{vault.reason}"
      </p>
      <button onClick={open}>Open both on Etherscan, side by side</button>
      {blocked && (
        <p className="small">
          Chrome blocked a page. Click the blocked pop-up icon at the right of the address bar, choose <strong>Always allow</strong>,
          then click the button again.
        </p>
      )}
    </section>
  )
}

export default function SideBySide({ link }) {
  const demo = useMemo(() => readDemoLink(link), [link])
  const phoneLink = demo ? demoLink(`${window.location.origin}${window.location.pathname}`, demo.key, demo.thief) : ''
  const qr = useQr(phoneLink)
  const { scene, balances, entries, pending, error } = useWatch(demo)

  if (!demo) {
    return (
      <main className="page">
        <section className="card notice">
          <h2>This screen needs the demo key</h2>
          <p>Open it with the script: node --env-file=../.env scripts/side-by-side.js screen --live, from server/.</p>
        </section>
      </main>
    )
  }

  const walletEntries = entries.filter((entry) => entry.side === 'wallet')
  const vaultEntries = entries.filter((entry) => entry.side === 'vault')
  const lastWallet = walletEntries.at(-1)
  const lastVault = vaultEntries.at(-1)
  const attacked = lastWallet?.ok && sameAddress(lastWallet.to, demo.thief) && lastVault && !lastVault.ok && sameAddress(lastVault.to, demo.thief)

  return (
    <main className="side">
      <header className="side-head">
        <div>
          <h1>One key. Two accounts. One attack.</h1>
          <p className="lead">
            The same test key controls a normal wallet and a Verbatim vault. Scan the code to take it, prove it's real, then
            steal from both.
          </p>
          {LOCAL_HOSTS.includes(window.location.hostname) && (
            <p className="error small">
              This screen is open on {window.location.hostname}, so phones can't reach the code's link. Open it with the script's
              screen command instead.
            </p>
          )}
        </div>
        <figure className="qr">
          {qr && <img src={qr} alt="QR code that opens the attacker page with the demo key" />}
          <figcaption className="muted small">
            Scan to take the key · test money only
            <br />
            or type <strong className="mono">{window.location.host}/api/go</strong>
          </figcaption>
        </figure>
      </header>

      {pending && <p className="waiting">⏳ The phone sent a transaction. Waiting for Sepolia…</p>}
      {error && <p className="error">Can't read Sepolia right now: {error}</p>}
      {scene && !scene.vault && <p className="error">This key has no Verbatim vault yet. Run the demo setup first.</p>}

      {scene?.vault && (
        <div className="columns">
          <Column
            title="Normal wallet"
            tagline="Just the key. Whoever holds it takes everything"
            account={scene.everydayKey}
            amount={balances?.wallet}
            scene={scene}
            entries={walletEntries}
          />
          <Column
            title="Verbatim vault"
            tagline="The same key, with Verbatim's rules"
            account={scene.vault}
            amount={balances?.vault}
            scene={scene}
            entries={vaultEntries}
          />
        </div>
      )}

      {attacked && <Verdict scene={scene} wallet={lastWallet} vault={lastVault} />}
    </main>
  )
}
