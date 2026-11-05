import { useState } from 'react'
import { formatAmount } from './format.js'
import { Dots, Words } from './Motion.jsx'

const MAINNET_EXPLORER = 'https://etherscan.io'

const CARDS = {
  bybit: {
    title: 'Bybit, 21 Feb 2025',
    loss: '$1.5 billion',
    intro: "Bybit's signers approved what looked like a routine move. It actually ran borrowed code that replaced their wallet's code.",
  },
  aave: {
    title: 'The $50.4M Aave trade, 12 Mar 2026',
    loss: '$50.4 million',
    intro: 'A user swapped 50.4 million USDT for AAVE. The quote said about 329 AAVE, and the user accepted it.',
  },
}

async function runReplay(name) {
  const response = await fetch('/api/replay', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  }).catch(() => null)
  if (!response) throw new Error("The Verbatim server isn't running. Start it from server/ with npm start.")
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(json.error ?? `The server answered ${response.status}.`)
  return json
}

const amount = (value, decimals, digits = 2) =>
  formatAmount(BigInt(value) + (digits < decimals ? 5n * 10n ** BigInt(decimals - digits - 1) : 0n), decimals, digits)

function Side({ title, safe, children }) {
  return (
    <div className={safe ? 'replay-side safe' : 'replay-side lost'}>
      <h3>{title}</h3>
      {children}
    </div>
  )
}

function Bybit({ data }) {
  const { wallet, vault } = data.result
  return (
    <>
      <Side title="Bybit's real wallet: emptied">
        <p className="replay-amount">{amount(wallet.before, 18)} → {amount(wallet.after, 18)} ETH</p>
        <p className="small">Its code was replaced ({wallet.codeBefore.slice(0, 6)}… → {wallet.codeAfter.slice(0, 6)}…), then the attacker swept it.</p>
      </Side>
      <Side title="A Verbatim vault, same attack: refused, nothing lost" safe>
        <p className="replay-amount">{amount(vault.before, 18)} → {amount(vault.after, 18)} ETH</p>
        <p className="small">"{vault.reason}"</p>
      </Side>
      <p className="muted small">
        The signers believed: "{data.facts.sentence}" ·{' '}
        <a href={`${MAINNET_EXPLORER}/tx/${data.facts.attackTx}`} target="_blank" rel="noreferrer">the real attack on Etherscan ↗</a>
      </p>
    </>
  )
}

function Aave({ data }) {
  const { wallet, vault, prices, fair, lessBps, quoted } = data.result
  return (
    <>
      <Side title="A normal wallet, same pools: the trade went through">
        <p className="replay-amount">{amount(wallet.usdtIn, 6)} USDT → {amount(wallet.aaveOut, 18)} AAVE</p>
        <p className="small">Exactly what really happened, through {amount(wallet.wethOut, 18)} WETH on Uniswap V3, then SushiSwap.</p>
      </Side>
      <Side title="A Verbatim vault, same trade: refused, nothing lost" safe>
        <p className="replay-amount">You'd get {amount(lessBps, 2)}% less than a fair price</p>
        <p className="small">
          The user's own check passed: at least {amount(quoted, 18, 0)} AAVE, and {amount(wallet.aaveOut, 18)} would arrive. But the vault's
          fair-price rule refused it: "{vault.reason}". Chainlink says a fair amount is {amount(fair, 18, 0)} AAVE (AAVE $
          {amount(prices.aaveUsd.answer, prices.aaveUsd.decimals, 3)}, USDT ${amount(prices.usdtUsd.answer, prices.usdtUsd.decimals, 5)}).
          The vault still holds {amount(vault.heldAfter, 6)} aEthUSDT.
        </p>
      </Side>
      <p className="muted small">
        The same route, re-created as a direct trade (the original was a CoW order) ·{' '}
        <a href={`${MAINNET_EXPLORER}/tx/${data.facts.tradeTx}`} target="_blank" rel="noreferrer">the real trade on Etherscan ↗</a>
      </p>
    </>
  )
}

function ReplayCard({ name, index }) {
  const card = CARDS[name]
  const [state, setState] = useState({ status: 'idle' })
  const start = async () => {
    setState({ status: 'running' })
    try {
      setState({ status: 'done', data: await runReplay(name) })
    } catch (error) {
      setState({ status: 'error', error: error.message })
    }
  }
  return (
    <section className="card column" style={{ animationDelay: `${200 + index * 150}ms` }}>
      <span className="pill bad loss">Lost: {card.loss}</span>
      <h2>{card.title}</h2>
      <p>{card.intro}</p>
      <div className="actions">
        <button className="big" onClick={start} disabled={state.status === 'running'}>
          {state.status === 'done' ? 'Replay it again' : 'Replay it against a Verbatim vault'}
        </button>
      </div>
      {state.status === 'running' && <p className="reading">Starting the saved copy of Ethereum <Dots /> no internet needed</p>}
      {state.status === 'error' && <p className="panel warn">{state.error}</p>}
      {state.status === 'done' && (
        <div key={state.data.totalMs}>
          {name === 'bybit' ? <Bybit data={state.data} /> : <Aave data={state.data} />}
          <p className="muted small">
            Replayed on a saved copy of Ethereum, offline, in {(state.data.totalMs / 1000).toFixed(1)} s. The vault is Verbatim's real
            vault code, the same as on Sepolia.
          </p>
        </div>
      )}
    </section>
  )
}

export default function Replays() {
  return (
    <main className="side">
      <header className="top">
        <div className="top-left">
          <a className="brand" href="#">Verbatim</a>
          <nav className="nav">
            <a href="#">Pay</a>
            <a href="#phone">Phone</a>
            <a href="#replays" className="active">Replays</a>
          </nav>
        </div>
      </header>
      <header className="side-head">
        <div>
          <h1><Words text="Real history, cancelled live" step={90} /></h1>
          <p className="lead">Two real attacks, replayed on a saved copy of Ethereum at the moment they happened. No internet needed.</p>
        </div>
      </header>
      <div className="columns">
        <ReplayCard name="bybit" index={0} />
        <ReplayCard name="aave" index={1} />
      </div>
    </main>
  )
}
