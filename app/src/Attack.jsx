import { useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_POLL_MS, EXPLORER } from './config.js'
import Console from './Console.jsx'
import {
  allowedAmount,
  demoClients,
  demoRpcUrl,
  findScene,
  nameIn,
  readBalances,
  readDemoLink,
  Refused,
  resultOf,
  sendAllowed,
  sendAttack,
  tokenAmount,
} from './demo.js'
import { formatAmount, shortAddress } from './format.js'

const BUSY = ['sending', 'waiting']

function problem(error) {
  if (error instanceof Refused) return `The vault refused it: ${error.message}`
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

function TxLink({ hash }) {
  return (
    <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">
      Open on Etherscan ↗
    </a>
  )
}

function Waiting({ title, hash }) {
  return (
    <p className="muted">
      ⏳ {title}: sent, waiting for Sepolia… {hash && <TxLink hash={hash} />}
    </p>
  )
}

function Outcome({ title, result, children }) {
  return (
    <div className={`result ${result.ok ? 'ok' : 'refused'}`}>
      <h3>{title}: {result.ok ? '✓ Success' : '✗ Failed'}</h3>
      <p className="small">{children}</p>
      <p className="small"><TxLink hash={result.hash} /></p>
    </div>
  )
}

function useScene(clients, demo) {
  const [scene, setScene] = useState(null)
  const [balances, setBalances] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    if (!clients) return undefined
    let stopped = false
    let timer
    let found = null
    const tick = async () => {
      try {
        if (!found?.vault || !found.setupFinished || !found.contact) {
          found = await findScene(clients.reader, demo.everydayKey, demo.thief)
          if (!stopped) setScene(found)
        }
        if (found.vault) {
          const read = await readBalances(clients.reader, found)
          if (!stopped) setBalances(read)
        }
        if (!stopped) setError(null)
      } catch (e) {
        if (!stopped) setError(problem(e))
      }
      if (!stopped) timer = setTimeout(tick, DEMO_POLL_MS * 2)
    }
    tick()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [clients, demo])
  return { scene, balances, error }
}

export default function Attack({ link }) {
  const demo = useMemo(() => readDemoLink(link), [link])
  const clients = useMemo(() => (demo ? demoClients(demoRpcUrl(), demo.key) : null), [demo])
  const { scene, balances, error } = useScene(clients, demo)
  const [allowed, setAllowed] = useState({ status: 'idle' })
  const [attack, setAttack] = useState({ status: 'idle' })
  const [took, setTook] = useState(null)
  const [consoleBusy, setConsoleBusy] = useState(false)
  const started = useRef(null)

  if (!demo) {
    return (
      <main className="page">
        <section className="card notice">
          <h2>This link doesn't hold a key</h2>
          <p>Scan the QR code on the Verbatim screen again.</p>
        </section>
      </main>
    )
  }

  const busy = consoleBusy || BUSY.includes(allowed.status) || BUSY.includes(attack.status)
  const ready = Boolean(scene?.vault && scene.setupFinished && balances)
  const noGas = ready && balances.gas === 0n
  const canProve = ready && !busy && !noGas && Boolean(scene.contact) && balances.vault >= allowedAmount(scene)
  const canAttack = ready && !busy && !noGas && balances.wallet > 0n

  const proveKey = async () => {
    started.current = Date.now()
    setTook(null)
    setAttack({ status: 'idle' })
    setAllowed({ status: 'sending' })
    try {
      const hash = await sendAllowed(clients, scene)
      setAllowed({ status: 'waiting', hash })
      setAllowed({ status: 'done', result: await resultOf(clients.reader, hash) })
    } catch (e) {
      setAllowed({ status: 'error', error: problem(e) })
    }
  }

  const attackBoth = async () => {
    started.current ??= Date.now()
    setAttack({ status: 'sending' })
    try {
      const before = await readBalances(clients.reader, scene)
      const hashes = await sendAttack(clients, scene, before)
      setAttack({ status: 'waiting', hashes, before })
      const track = (side) =>
        resultOf(clients.reader, hashes[side]).then((result) => setAttack((current) => ({ ...current, [side]: result })))
      await Promise.all([track('wallet'), track('vault')])
      setAttack((current) => ({ ...current, status: 'done' }))
      setTook(Date.now() - started.current)
    } catch (e) {
      setAttack((current) => ({ ...current, status: 'error', error: problem(e) }))
    }
    started.current = null
  }

  const amount = (value) => (value === undefined ? '…' : formatAmount(value, scene?.decimals ?? 6))

  return (
    <main className="page attack">
      <header className="top">
        <div>
          <h1>You stole a key</h1>
          <p className="muted small">It controls two accounts on Sepolia, the test network. Test money only.</p>
        </div>
      </header>

      <section className="card">
        <ul className="balances">
          <li>
            <span className="amount">{amount(balances?.wallet)}</span>
            <span className="symbol">{scene?.symbol ?? 'USDC'}</span>
            <span className="label">Normal wallet</span>
          </li>
          <li>
            <span className="amount">{amount(balances?.vault)}</span>
            <span className="symbol">{scene?.symbol ?? 'USDC'}</span>
            <span className="label">Verbatim vault</span>
          </li>
        </ul>
        <p className="muted small">
          Your address, as the thief:{' '}
          <a className="mono" href={`${EXPLORER}/address/${demo.thief}`} target="_blank" rel="noreferrer">{shortAddress(demo.thief)}</a>
        </p>
        {!scene && !error && <p className="muted small">Reading both accounts…</p>}
        {scene && !scene.vault && <p className="error small">This key has no Verbatim vault yet. Ask the team to run the demo setup.</p>}
        {scene?.vault && !scene.setupFinished && <p className="error small">The vault isn't set up yet. Ask the team to run the demo setup.</p>}
        {noGas && <p className="error small">This key has no test ETH for fees. Ask the team to reset the demo.</p>}
        {error && <p className="error small">Can't reach Sepolia right now: {error}</p>}
      </section>

      <section className="card">
        <h2>1. Prove the key is real</h2>
        <p>
          Send {scene?.decimals !== undefined ? tokenAmount(scene, allowedAmount(scene)) : '1 USDC'} from the vault to{' '}
          {scene?.contact ? nameIn(scene, scene.contact) : 'a saved contact'}. Verbatim allows this.
        </p>
        <button disabled={!canProve} onClick={proveKey}>Send it</button>
        {allowed.status === 'sending' && <p className="muted">Signing and sending…</p>}
        {allowed.status === 'waiting' && <Waiting title="Allowed send" hash={allowed.hash} />}
        {allowed.status === 'done' && (
          <Outcome title="Allowed send" result={allowed.result}>
            {allowed.result.ok
              ? `${tokenAmount(scene, allowedAmount(scene))} went from the vault to ${nameIn(scene, scene.contact)}. The key is real.`
              : `The vault refused it: ${allowed.result.reason}`}
          </Outcome>
        )}
        {allowed.status === 'error' && <p className="error">✗ {allowed.error}</p>}
      </section>

      <section className="card">
        <h2>2. Steal everything</h2>
        <p>
          One tap sends all the USDC in both accounts to your address, with the same key, at the same time. You even write
          the vault's checks yourself.
        </p>
        <button disabled={!canAttack} onClick={attackBoth}>Attack both</button>
        {ready && balances.wallet === 0n && !BUSY.includes(attack.status) && (
          <p className="muted small">The normal wallet is already empty. Ask the team to reset the demo.</p>
        )}
        {attack.status === 'sending' && <p className="muted">Signing and sending both…</p>}
        {attack.hashes && (
          <>
            {attack.wallet ? (
              <Outcome title="Normal wallet" result={attack.wallet}>
                {attack.wallet.ok
                  ? `${tokenAmount(scene, attack.before.wallet)} went to you. The normal wallet is empty.`
                  : `It failed: ${attack.wallet.reason}`}
              </Outcome>
            ) : (
              <Waiting title="Normal wallet" hash={attack.hashes.wallet} />
            )}
            {attack.vault ? (
              <Outcome title="Verbatim vault" result={attack.vault}>
                {attack.vault.ok
                  ? `${tokenAmount(scene, attack.before.vault)} went to you.`
                  : `"${attack.vault.reason}". Nothing left the vault.`}
              </Outcome>
            ) : (
              <Waiting title="Verbatim vault" hash={attack.hashes.vault} />
            )}
          </>
        )}
        {attack.status === 'error' && <p className="error">✗ {attack.error}</p>}
        {took !== null && <p className="muted small">From your first tap to both results: {Math.round(took / 1000)} s</p>}
      </section>

      {ready && (
        <Console clients={clients} demo={demo} scene={scene} balances={balances} disabled={busy || noGas} onBusy={setConsoleBusy} />
      )}
    </main>
  )
}
