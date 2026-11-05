import { useEffect, useMemo, useState } from 'react'
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, erc20Abi, parseAbiParameters, zeroAddress } from 'viem'
import { getWallet } from './chain.js'
import { CheckKind, describeAction, describeCheck, describeFailure, holdingOf, nameOf } from './checks.js'
import { EXPLORER, PERMIT2, permit2Abi, routerAbi, UNIVERSAL_ROUTER, vaultAbi, WETH } from './config.js'
import { formatAmount, formatDuration, shortAddress } from './format.js'
import { Cross } from './Motion.jsx'
import { readerFor } from './onchain.js'
import { newDeadline } from './run.js'
import { quoteWords, UNFAIR_TRADE } from './words.js'

const ROUTER_PAYS_CALLER = '0x0000000000000000000000000000000000000001'

const ROUTER_PAYS_ITSELF = '0x0000000000000000000000000000000000000002'

const same = (a, b) => Boolean(a && b) && a.toLowerCase() === b.toLowerCase()

function problemOf(error) {
  return error?.shortMessage || error?.message || 'Something went wrong.'
}

function knownTo(vault, address) {
  return same(address, vault.address)
    || same(address, ROUTER_PAYS_CALLER)
    || same(address, ROUTER_PAYS_ITSELF)
    || same(address, UNIVERSAL_ROUTER)
    || same(address, PERMIT2)
    || vault.contacts.some((contact) => same(contact.address, address))
}

function who(vault, address) {
  if (same(address, vault.address) || same(address, ROUTER_PAYS_CALLER)) return 'your vault'
  if (same(address, ROUTER_PAYS_ITSELF)) return 'the router, for its next step'
  if (same(address, UNIVERSAL_ROUTER)) return 'the Uniswap router'
  if (same(address, PERMIT2)) return 'Permit2'
  const contact = vault.contacts.find((c) => same(c.address, address))
  return contact ? nameOf(vault, contact.address) : shortAddress(address)
}

function money(vault, token, amount) {
  if (token === zeroAddress) return `${formatAmount(amount, 18)} ETH`
  if (same(token, WETH)) return `${formatAmount(amount, 18)} WETH`
  const holding = vault.holdings.find((h) => same(h.token, token))
  return holding ? `${formatAmount(amount, holding.decimals, holding.decimals)} ${holding.symbol}` : `${amount} of ${shortAddress(token)}`
}

function symbolOf(vault, token) {
  if (same(token, WETH)) return 'ETH'
  return vault.holdings.find((h) => same(h.token, token))?.symbol ?? shortAddress(token)
}

const POOL_KEY = '(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)'

const PATH_KEY = '(address intermediateCurrency, uint24 fee, int24 tickSpacing, address hooks, bytes hookData)'

function swapIn(vault, tokenIn, tokenOut, amountIn) {
  return `Swap ${money(vault, tokenIn, amountIn)} for ${symbolOf(vault, tokenOut)} on Uniswap`
}

function swapOut(vault, tokenIn, tokenOut, amountOut, amountInMaximum) {
  return `Swap up to ${money(vault, tokenIn, amountInMaximum)} for ${money(vault, tokenOut, amountOut)} on Uniswap`
}

function v4Take(vault, token, to, amount, raw) {
  if (same(to, ROUTER_PAYS_ITSELF) || same(to, ROUTER_PAYS_CALLER) || same(to, vault.address)) return null
  const what = amount === 0n ? `the ${symbolOf(vault, token)} from the swap` : money(vault, token, amount)
  return { text: `Send ${what} to ${who(vault, to)}`, flag: !knownTo(vault, to), raw }
}

const V4_STEPS = {
  6: (vault, param) => {
    const [{ poolKey, zeroForOne, amountIn }] = decodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)`), param)
    const [tokenIn, tokenOut] = zeroForOne ? [poolKey.currency0, poolKey.currency1] : [poolKey.currency1, poolKey.currency0]
    return { text: swapIn(vault, tokenIn, tokenOut, amountIn), raw: `Uniswap V4 SWAP_EXACT_IN_SINGLE · amountIn ${amountIn}` }
  },
  7: (vault, param) => {
    const [{ currencyIn, path, amountIn }] = decodeAbiParameters(parseAbiParameters(`(address currencyIn, ${PATH_KEY}[] path, uint128 amountIn, uint128 amountOutMinimum)`), param)
    return { text: swapIn(vault, currencyIn, path.at(-1).intermediateCurrency, amountIn), raw: `Uniswap V4 SWAP_EXACT_IN · amountIn ${amountIn}` }
  },
  8: (vault, param) => {
    const [{ poolKey, zeroForOne, amountOut, amountInMaximum }] = decodeAbiParameters(parseAbiParameters(`(${POOL_KEY} poolKey, bool zeroForOne, uint128 amountOut, uint128 amountInMaximum, bytes hookData)`), param)
    const [tokenIn, tokenOut] = zeroForOne ? [poolKey.currency0, poolKey.currency1] : [poolKey.currency1, poolKey.currency0]
    return { text: swapOut(vault, tokenIn, tokenOut, amountOut, amountInMaximum), raw: `Uniswap V4 SWAP_EXACT_OUT_SINGLE · amountOut ${amountOut}` }
  },
  9: (vault, param) => {
    const [{ currencyOut, path, amountOut, amountInMaximum }] = decodeAbiParameters(parseAbiParameters(`(address currencyOut, ${PATH_KEY}[] path, uint128 amountOut, uint128 amountInMaximum)`), param)
    return { text: swapOut(vault, path[0].intermediateCurrency, currencyOut, amountOut, amountInMaximum), raw: `Uniswap V4 SWAP_EXACT_OUT · amountOut ${amountOut}` }
  },
  11: () => null,
  12: () => null,
  14: (vault, param) => {
    const [token, to, amount] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), param)
    return v4Take(vault, token, to, amount, `Uniswap V4 TAKE · ${shortAddress(token)} → ${shortAddress(to)} · ${amount}`)
  },
  15: () => null,
  16: (vault, param) => {
    const [token, to, bps] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), param)
    return { text: `Pay ${formatAmount(bps, 2)}% of the ${symbolOf(vault, token)} to ${who(vault, to)}`, flag: !knownTo(vault, to), raw: `Uniswap V4 TAKE_PORTION · ${shortAddress(to)} · ${bps} bps` }
  },
}

function v4Step(vault, kind, param) {
  try {
    return V4_STEPS[kind]?.(vault, param)
  } catch {
    return undefined
  }
}

function v4Steps(vault, input) {
  const [actions, params] = decodeAbiParameters(parseAbiParameters('bytes, bytes[]'), input)
  const codes = actions.slice(2).match(/.{2}/g) ?? []
  return codes.flatMap((code, i) => {
    const step = v4Step(vault, parseInt(code, 16), params[i])
    if (step === null) return []
    return [step ?? { text: 'Another Uniswap step', raw: `Uniswap V4 action 0x${code}` }]
  })
}

const ROUTER_STEPS = {
  0: (vault, input) => {
    const [, amountIn, , path] = decodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), input)
    const tokenIn = `0x${path.slice(2, 42)}`
    const tokenOut = `0x${path.slice(-40)}`
    return { text: `Swap ${money(vault, tokenIn, amountIn)} for ${symbolOf(vault, tokenOut)} on Uniswap`, raw: `Uniswap V3_SWAP_EXACT_IN · amountIn ${amountIn}` }
  },
  2: (vault, input) => {
    const [token, to, amount] = decodeAbiParameters(parseAbiParameters('address, address, uint160'), input)
    return { text: `Move ${money(vault, token, amount)} out of your vault to ${who(vault, to)}`, flag: !knownTo(vault, to), raw: `Uniswap PERMIT2_TRANSFER_FROM · ${shortAddress(token)} → ${shortAddress(to)} · ${amount}` }
  },
  4: (vault, input) => {
    const [token, to] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), input)
    return { text: `Send what's left of the ${symbolOf(vault, token)} to ${who(vault, to)}`, flag: !knownTo(vault, to), raw: `Uniswap SWEEP · ${shortAddress(token)} → ${shortAddress(to)}` }
  },
  5: (vault, input) => {
    const [token, to, amount] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), input)
    return { text: `Send ${money(vault, token, amount)} to ${who(vault, to)}`, flag: !knownTo(vault, to), raw: `Uniswap TRANSFER · ${shortAddress(token)} → ${shortAddress(to)} · ${amount}` }
  },
  6: (vault, input) => {
    const [token, to, bps] = decodeAbiParameters(parseAbiParameters('address, address, uint256'), input)
    return { text: `Pay ${formatAmount(bps, 2)}% of the ${symbolOf(vault, token)} to ${who(vault, to)}`, flag: !knownTo(vault, to), raw: `Uniswap PAY_PORTION · ${shortAddress(to)} · ${bps} bps` }
  },
  11: () => ({ text: 'Turn ETH into WETH' }),
  12: () => ({ text: 'Turn the WETH back into ETH, for your vault' }),
  16: v4Steps,
}

function routerSteps(vault, data) {
  const call = decodeFunctionData({ abi: routerAbi, data })
  const [commands, inputs] = call.args
  const codes = commands.slice(2).match(/.{2}/g) ?? []
  return codes.flatMap((code, i) => {
    const kind = parseInt(code, 16) & 0x3f
    try {
      return ROUTER_STEPS[kind]?.(vault, inputs[i]) ?? { text: 'Another Uniswap step', raw: `Uniswap command 0x${code}` }
    } catch {
      return { text: 'Another Uniswap step', raw: `Uniswap command 0x${code}` }
    }
  })
}

function payFlag(vault, checks, token, to, amount) {
  if (!knownTo(vault, to)) return { flag: true }
  if (same(to, vault.address)) return {}
  const exact = (checks ?? []).find((c) => Number(c.kind) === CheckKind.ExactlyTo && same(c.token, token) && same(c.to, to))
  if (!exact) return { flag: true }
  if (BigInt(exact.amount) !== BigInt(amount)) return { flag: true, label: `You said ${money(vault, token, BigInt(exact.amount))}` }
  return {}
}

function approveFlag(vault, checks, token, spender, amount) {
  if (!knownTo(vault, spender)) return { flag: true }
  const most = (checks ?? []).find((c) => Number(c.kind) === CheckKind.AtMostLeaves && same(c.token, token))
  if (most && BigInt(amount) > BigInt(most.amount)) return { flag: true, label: `You allowed ${money(vault, token, BigInt(most.amount))}` }
  return {}
}

export function plainSteps(vault, actions, checks) {
  return (actions ?? []).flatMap((action) => {
    try {
      if (Number(action.operation) === 1) {
        return [{ text: `Run outside code from ${shortAddress(action.target)} inside your vault (borrowed code)`, flag: true, raw: `operation 1 (delegatecall) · ${shortAddress(action.target)}` }]
      }
      if (action.data === '0x') {
        if (BigInt(action.value) === 0n) return [{ text: `Call ${who(vault, action.target)}` }]
        return [{ text: `Send ${money(vault, zeroAddress, BigInt(action.value))} to ${who(vault, action.target)}`, ...payFlag(vault, checks, zeroAddress, action.target, action.value), raw: `${shortAddress(action.target)} · value ${action.value}` }]
      }
      if (same(action.target, UNIVERSAL_ROUTER)) return routerSteps(vault, action.data)
      if (same(action.target, PERMIT2)) {
        const call = decodeFunctionData({ abi: permit2Abi, data: action.data })
        const [token, spender, amount] = call.args
        return [{ text: `Let ${who(vault, spender)} pull up to ${money(vault, token, amount)}`, ...approveFlag(vault, checks, token, spender, amount), raw: `Permit2 approve(${shortAddress(token)}, ${shortAddress(spender)}, ${amount})` }]
      }
      if (holdingOf(vault, action.target) || vault.holdings.some((h) => same(h.token, action.target))) {
        const call = decodeFunctionData({ abi: erc20Abi, data: action.data })
        if (call.functionName === 'transfer') {
          const [to, amount] = call.args
          return [{ text: `Send ${money(vault, action.target, amount)} to ${who(vault, to)}`, ...payFlag(vault, checks, action.target, to, amount), raw: `transfer(${shortAddress(to)}, ${amount})` }]
        }
        if (call.functionName === 'approve') {
          const [spender, amount] = call.args
          return [{ text: `Let ${who(vault, spender)} spend up to ${money(vault, action.target, amount)}`, ...approveFlag(vault, checks, action.target, spender, amount), raw: `approve(${shortAddress(spender)}, ${amount})` }]
        }
      }
    } catch {
      return [{ text: describeAction(vault, action) }]
    }
    return [{ text: describeAction(vault, action) }]
  })
}

function useSentRun(hash) {
  const [state, setState] = useState({ status: hash ? 'reading' : 'none' })
  useEffect(() => {
    if (!hash) return undefined
    let current = true
    const wallet = getWallet()
    if (!wallet) {
      setState({ status: 'error', error: 'MetaMask is needed to read Sepolia.' })
      return undefined
    }
    setState({ status: 'reading' })
    readerFor(wallet).getTransaction({ hash })
      .then((tx) => {
        const call = decodeFunctionData({ abi: vaultAbi, data: tx.input })
        if (call.functionName !== 'run') throw new Error("This transaction isn't a request to the vault.")
        if (current) setState({ status: 'done', actions: call.args[0] })
      })
      .catch((error) => current && setState({ status: 'error', error: problemOf(error) }))
    return () => {
      current = false
    }
  }, [hash])
  return state
}

export const limits = (vault, key) => vault.holdings.map((h) => money(vault, h.token, h[key])).join(' and ')

const newContactRule = (vault) => `A new contact can receive at most ${limits(vault, 'newContactLimit')} in its first ${formatDuration(vault.newContactPeriod)}`

const RULES = {
  'Over the new-contact limit': newContactRule,
  'Contact too new for big payments': newContactRule,
  'Over the daily limit': (vault) => `At most ${limits(vault, 'dailyLimit')} can leave your vault each day`,
  "This contact's address changed": () => "A contact's name must still point to the address your vault saved",
}

export function brokenRule(vault, actions, checks, failure) {
  const rule = failure && !failure.checkNumber ? RULES[failure.reason] : null
  if (!rule || plainSteps(vault, actions, checks).some((step) => step.flag)) return null
  return rule(vault)
}

function whatYouSaid(vault, checks, failure, said) {
  if (failure?.checkNumber && checks?.[failure.checkNumber - 1]) {
    const index = failure.checkNumber - 1
    return { words: said?.perCheck?.[index] ?? [], text: describeCheck(vault, checks[index]).text }
  }
  if (failure?.reason === UNFAIR_TRADE) return { words: said?.swaps ?? [], text: 'A fair price, within your margin' }
  return { words: said?.nothingElse ? [said.nothingElse] : [], text: 'Nothing else changes in your account' }
}

function verdictOf(vault, checks, failure) {
  if (failure?.checkNumber && checks?.[failure.checkNumber - 1]) {
    const check = checks[failure.checkNumber - 1]
    return `${describeCheck(vault, check).text}, ${describeFailure(vault, check, failure.actual)}.`
  }
  return failure?.reason ?? 'The vault refused it.'
}

export function Caught({ vault, source, hash, actions, checks, failure, said }) {
  const sent = useSentRun(source === 'chain' ? hash : null)
  const fromChain = sent.status === 'done'
  const steps = plainSteps(vault, fromChain ? sent.actions : actions, checks)
  const rule = brokenRule(vault, fromChain ? sent.actions : actions, checks, failure)
  const yours = rule ? { words: [], text: rule } : whatYouSaid(vault, checks, failure, said)
  return (
    <section className="card caught">
      <div className="caught-head">
        <span className="stamp refused">{rule ? 'Your rule' : 'Caught'}</span>
        <h2>{rule ? 'Your words are fine. One of your rules says no.' : 'Your words vs. what the app sent'}</h2>
      </div>
      <div className="caught-grid">
        <div className="caught-side said">
          <h3>{rule ? 'Your rule' : said ? 'You said' : 'Your check'}</h3>
          {yours.words.length > 0 && (
            <div className="quote-tiles">
              {yours.words.map((piece) => <span key={piece} className="quote-tile">{piece}</span>)}
            </div>
          )}
          <p className="caught-text">{yours.text}</p>
        </div>
        <div className="caught-vs" aria-hidden="true">≠</div>
        <div className="caught-side sent">
          <h3>{source === 'chain' ? 'The transaction on Sepolia tried to' : "The app's transaction would"}</h3>
          {source === 'chain' && sent.status === 'reading' && <p className="muted small">Reading it back from Sepolia…</p>}
          <ol className="plain-steps">
            {steps.map((step, i) => (
              <li key={i} className={step.flag ? 'flag' : undefined} style={{ animationDelay: `${300 + i * 90}ms` }}>
                <span>{step.text}</span>
                {step.flag && <span className="pill bad">{step.label ?? 'Not in your words'}</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
      <p className="caught-verdict">
        <span className="mark-bad"><Cross size={30} delay={500} /></span>
        <span>
          <strong>The vault's verdict:</strong> {verdictOf(vault, checks, failure)}
          {yours.words.length > 0 && <span className="from">You said {quoteWords(yours.words)}.</span>}
        </span>
      </p>
      {source === 'practice' && vault.everydayKey && <Rerun vault={vault} actions={actions} checks={checks} />}
      {source === 'chain' && (
        <div className="caught-proof">
          <span>Proof anyone can check, read from Sepolia:</span>
          <a className="go big-go" href={`#proof/${hash}`} target="_blank" rel="noreferrer">Open the evidence page</a>
        </div>
      )}
      <p className="muted small caught-source">
        {source === 'chain'
          ? fromChain
            ? `Read back from transaction ${shortAddress(hash)} on Sepolia, not from this app's memory.`
            : sent.status === 'error'
              ? `Couldn't read the transaction back from Sepolia (${sent.error}), so this shows what the app sent.`
              : 'Reading the transaction back from Sepolia…'
          : 'From the practice run: a free simulation of this exact transaction against your vault. Nothing was sent, so there is nothing on Sepolia to check yet.'}
      </p>
    </section>
  )
}

function Rerun({ vault, actions, checks }) {
  const data = useMemo(
    () => encodeFunctionData({ abi: vaultAbi, functionName: 'run', args: [actions, checks, newDeadline()] }),
    [actions, checks],
  )
  return (
    <details className="fold rerun">
      <summary>Re-run this check yourself, without this app</summary>
      <p className="small">
        This is the exact transaction the app wants you to sign. Anyone can ask Sepolia to run it as a free simulation: nothing is
        sent and nothing is paid, and it fails with the same error. It works for 10 minutes, until the deadline inside it.
      </p>
      <Command text={`cast call ${vault.address} ${data} --from ${vault.everydayKey} --rpc-url <your Sepolia RPC URL>`} />
    </details>
  )
}

export function etherscanLine(failure) {
  if (failure?.checkNumber) {
    return `Fail with Custom Error 'CheckFailed (checkNumber=${failure.checkNumber}, check=${failure.check}, expected=${failure.expected}, actual=${failure.actual})'`
  }
  if (failure?.reason && !failure.outside && !failure.reason.startsWith('The vault refused it')) return `Fail with error '${failure.reason}'`
  return null
}

function Command({ text }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }
  return (
    <div className="command">
      <code>{text}</code>
      <button className="secondary compact" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  )
}

export function VerifyIt({ vault, hash, failure, checks, withEvidence = false }) {
  const line = etherscanLine(failure)
  const check = failure?.checkNumber ? checks?.[failure.checkNumber - 1] : null
  const holding = check && vault?.holdings ? vault.holdings.find((h) => same(h.token, check.token)) : null
  const address = vault?.address ?? vault
  return (
    <section className="card verify">
      <h2>Verify it yourself</h2>
      <p className="muted">You don't have to trust this screen. Each of these reads Sepolia directly, without this app.</p>
      {withEvidence && (
        <p>
          <a className="go" href={`#proof/${hash}`} target="_blank" rel="noreferrer">Open the evidence page: every claim next to its raw value on Sepolia</a>
        </p>
      )}
      <ol className="verify-steps">
        <li>
          <span className="check-num">1</span>
          <div>
            <strong>Open the transaction on Etherscan.</strong>
            <p>
              At the top, Status says <strong>Fail</strong> in red
              {line ? <>, with a line like: <code className="quote-code">{line}</code></> : ", with the vault's own reason."}
            </p>
            {holding && (
              <p className="muted small">
                {holding.symbol} has {holding.decimals} decimals, so that's {formatAmount(failure.expected, holding.decimals, holding.decimals)} {holding.symbol} allowed
                and {formatAmount(failure.actual, holding.decimals, holding.decimals)} {holding.symbol} measured by the vault.
              </p>
            )}
            <p className="muted small">Etherscan reads this from Sepolia. This app can't write to it.</p>
            <a className="go" href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noreferrer">Open the transaction ↗</a>
          </div>
        </li>
        <li>
          <span className="check-num">2</span>
          <div>
            <strong>Check that nothing moved.</strong>
            <p>The vault's balances are the same as before this transaction. Only the network fee was paid, by the key that sent it.</p>
            <a className="go" href={`${EXPLORER}/address/${address}`} target="_blank" rel="noreferrer">Open the vault ↗</a>
          </div>
        </li>
        <li>
          <span className="check-num">3</span>
          <div>
            <strong>Replay it without this app.</strong>
            <p>
              Foundry re-runs the transaction from Sepolia's own data and prints every step: the vault reads its balance, runs the
              app's actions, reads its balance again, then refuses.
            </p>
            <Command text={`cast run ${hash} --rpc-url <your Sepolia RPC URL>`} />
          </div>
        </li>
        <li>
          <span className="check-num">4</span>
          <div>
            <strong>Read the code that refused it.</strong>
            <p>
              The vault's source code is on Etherscan's Code tab. Search it for <code className="quote-code">{failure?.checkNumber ? 'CheckFailed' : 'the error text above'}</code>:
              the vault measures its balances before and after the app's actions, and cancels everything if a check breaks.
            </p>
            <a className="go" href={`${EXPLORER}/address/${address}#code`} target="_blank" rel="noreferrer">Open the vault's code ↗</a>
          </div>
        </li>
      </ol>
    </section>
  )
}
