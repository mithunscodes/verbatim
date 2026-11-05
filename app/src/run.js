import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  custom,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  http,
  parseAbiParameters,
  parseUnits,
  zeroAddress,
} from 'viem'
import {
  BAD_ROUTE_POOL_FEE,
  chain,
  DEADLINE_SECONDS,
  DEMO_FEE_BPS,
  DEMO_RPC_PATH,
  DEMO_STRANGER,
  DEMO_TIP,
  FAIR_POOL_FEE,
  FORCED_GAS,
  PERMIT2,
  permit2Abi,
  routerAbi,
  UNIVERSAL_ROUTER,
  vaultAbi,
  WETH,
} from './config.js'
import { lowFees, requireNormalKey, whileSigning } from './chain.js'
import { CheckKind } from './checks.js'

const EXTRA_ETH = 10n ** 15n

const PERMIT2_THIS_BLOCK_ONLY = 0

const ROUTER_PAYS_ITSELF = '0x0000000000000000000000000000000000000002'

const ROUTER_PAYS_CALLER = '0x0000000000000000000000000000000000000001'

const V3_SWAP_EXACT_IN = '00'

const PERMIT2_TRANSFER_FROM = '02'

const PAY_PORTION = '06'

const UNWRAP_WETH = '0c'

export function hackedExtra(token, decimals) {
  return token === zeroAddress ? EXTRA_ETH : 10n ** BigInt(decimals)
}

export function sendActions({ token, amount, to }) {
  if (token === zeroAddress) return [{ target: to, value: amount, data: '0x', operation: 0 }]
  return [{
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }),
    operation: 0,
  }]
}

export function swapActions({ from, amount, transaction }) {
  if (from === zeroAddress) return [{ target: transaction.to, value: amount, data: transaction.data, operation: 0 }]
  const spend = transaction.spend ?? amount
  return [
    {
      target: from,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, spend] }),
      operation: 0,
    },
    {
      target: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [from, transaction.to, spend, PERMIT2_THIS_BLOCK_ONLY],
      }),
      operation: 0,
    },
    { target: transaction.to, value: 0n, data: transaction.data, operation: 0 },
  ]
}

function routerSwap({ from, amount, poolFee, extra, portion }) {
  const commands = []
  const inputs = []
  if (extra) {
    commands.push(PERMIT2_TRANSFER_FROM)
    inputs.push(encodeAbiParameters(parseAbiParameters('address, address, uint160'), [from, extra.to, extra.amount]))
  }
  const path = encodePacked(['address', 'uint24', 'address'], [from, poolFee, WETH])
  commands.push(V3_SWAP_EXACT_IN)
  inputs.push(encodeAbiParameters(
    parseAbiParameters('address, uint256, uint256, bytes, bool'),
    [ROUTER_PAYS_ITSELF, amount, 0n, path, true],
  ))
  if (portion) {
    commands.push(PAY_PORTION)
    inputs.push(encodeAbiParameters(parseAbiParameters('address, address, uint256'), [WETH, portion.to, portion.bps]))
  }
  commands.push(UNWRAP_WETH)
  inputs.push(encodeAbiParameters(parseAbiParameters('address, uint256'), [ROUTER_PAYS_CALLER, 0n]))
  return {
    to: UNIVERSAL_ROUTER,
    value: 0n,
    spend: amount + (extra?.amount ?? 0n),
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'execute',
      args: [`0x${commands.join('')}`, inputs, newDeadline()],
    }),
  }
}

export function badRouteTransaction({ from, amount }) {
  return routerSwap({ from, amount, poolFee: BAD_ROUTE_POOL_FEE })
}

export function drainTransaction({ from, amount, balance }) {
  return routerSwap({ from, amount, poolFee: FAIR_POOL_FEE, extra: { to: DEMO_STRANGER, amount: balance - amount } })
}

export function divertedSwapTransaction({ from, amount, to, bps }) {
  return routerSwap({ from, amount, poolFee: FAIR_POOL_FEE, portion: { to, bps } })
}

export function feeTransaction({ from, amount }) {
  const fee = (amount * DEMO_FEE_BPS) / 10_000n
  return routerSwap({ from, amount, poolFee: FAIR_POOL_FEE, extra: { to: DEMO_STRANGER, amount: fee } })
}

export function extraActions(scenario, { from, decimals }) {
  if (scenario === 'tip') {
    return [{
      target: from,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [DEMO_STRANGER, parseUnits(DEMO_TIP, decimals)] }),
      operation: 0,
    }]
  }
  if (scenario === 'borrowed') return [{ target: DEMO_STRANGER, value: 0n, data: '0x', operation: 1 }]
  return []
}

export function newDeadline() {
  return BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS)
}

function clients(wallet, account) {
  const transport = custom(wallet)
  return {
    reader: createPublicClient({ chain, transport }),
    signer: account ? createWalletClient({ chain, transport, account }) : null,
  }
}

export function explainFailure(error) {
  const revert = error instanceof BaseError
    ? error.walk((e) => e instanceof ContractFunctionRevertedError)
    : null
  if (!revert) return { reason: error?.shortMessage || error?.message || 'Something went wrong.', network: true }
  if (revert.data?.errorName === 'CheckFailed') {
    const [checkNumber, check, expected, actual] = revert.data.args
    return { checkNumber: Number(checkNumber), check, expected, actual, reason: `Check ${checkNumber} would fail` }
  }
  return { reason: revert.reason || 'The vault refused it.' }
}

function runCall(vault, { actions, checks, deadline }) {
  return {
    address: vault.address,
    abi: vaultAbi,
    functionName: 'run',
    args: [actions, checks, deadline],
    account: vault.everydayKey,
  }
}

export async function practiceRun(wallet, vault, run) {
  const { reader } = clients(wallet)
  try {
    await reader.simulateContract(runCall(vault, run))
    return { pass: true }
  } catch (error) {
    return { pass: false, failure: explainFailure(error) }
  }
}

export async function signAndSend(wallet, vault, run, forced) {
  await requireNormalKey(wallet, vault.everydayKey)
  const { reader, signer } = clients(wallet, vault.everydayKey)
  const call = runCall(vault, run)
  const gas = forced ? FORCED_GAS : ((await reader.estimateContractGas(call)) * 12n) / 10n
  const fees = await lowFees(reader)
  return whileSigning(() => signer.writeContract({ ...call, gas, ...fees }))
}

function balanceAt(reader, token, account, blockNumber) {
  if (token === zeroAddress) return reader.getBalance({ address: account, blockNumber })
  return reader.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account], blockNumber })
}

export async function measureChecks(reader, vault, checks, blockNumber) {
  return Promise.all(checks.map(async (check) => {
    const account = check.kind === CheckKind.ExactlyTo ? check.to : vault.address
    const [before, after] = await Promise.all([
      balanceAt(reader, check.token, account, blockNumber - 1n),
      balanceAt(reader, check.token, account, blockNumber),
    ])
    return { left: before > after ? before - after : 0n, arrived: after > before ? after - before : 0n }
  }))
}

const UNREAD_REASON = "The vault refused it, but its reason couldn't be read from the network just now. Etherscan shows it."

function relayReader() {
  return createPublicClient({ chain, transport: http(new URL(DEMO_RPC_PATH, window.location.origin).href, { timeout: 30_000 }) })
}

export async function replayFailure(readers, vault, run, blockNumber) {
  for (const reader of readers) {
    try {
      await reader.simulateContract({ ...runCall(vault, run), blockNumber })
      return { reason: 'The vault refused it.' }
    } catch (error) {
      const failure = explainFailure(error)
      if (!failure.network) return failure
    }
  }
  return { reason: UNREAD_REASON }
}

export async function waitForResult(wallet, vault, run, hash) {
  const { reader } = clients(wallet)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  if (receipt.status === 'success') {
    const moved = await measureChecks(reader, vault, run.checks, receipt.blockNumber).catch(() => null)
    return { ok: true, receipt, moved }
  }
  const failure = await replayFailure([reader, relayReader()], vault, run, receipt.blockNumber - 1n)
  return { ok: false, receipt, failure }
}
