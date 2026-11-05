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
  parseAbiParameters,
  zeroAddress,
} from 'viem'
import {
  BAD_ROUTE_POOL_FEE,
  chain,
  DEADLINE_SECONDS,
  FORCED_GAS,
  PERMIT2,
  permit2Abi,
  routerAbi,
  UNIVERSAL_ROUTER,
  vaultAbi,
  WETH,
} from './config.js'
import { lowFees, requireNormalKey, whileSigning } from './chain.js'

const EXTRA_ETH = 10n ** 15n

const PERMIT2_THIS_BLOCK_ONLY = 0

const ROUTER_PAYS_ITSELF = '0x0000000000000000000000000000000000000002'

const ROUTER_PAYS_CALLER = '0x0000000000000000000000000000000000000001'

const V3_SWAP_EXACT_IN = '00'

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
  return [
    {
      target: from,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, amount] }),
      operation: 0,
    },
    {
      target: PERMIT2,
      value: 0n,
      data: encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [from, transaction.to, amount, PERMIT2_THIS_BLOCK_ONLY],
      }),
      operation: 0,
    },
    { target: transaction.to, value: 0n, data: transaction.data, operation: 0 },
  ]
}

export function badRouteTransaction({ from, amount }) {
  const path = encodePacked(['address', 'uint24', 'address'], [from, BAD_ROUTE_POOL_FEE, WETH])
  const swap = encodeAbiParameters(
    parseAbiParameters('address, uint256, uint256, bytes, bool'),
    [ROUTER_PAYS_ITSELF, amount, 0n, path, true],
  )
  const unwrap = encodeAbiParameters(parseAbiParameters('address, uint256'), [ROUTER_PAYS_CALLER, 0n])
  return {
    to: UNIVERSAL_ROUTER,
    value: 0n,
    data: encodeFunctionData({
      abi: routerAbi,
      functionName: 'execute',
      args: [`0x${V3_SWAP_EXACT_IN}${UNWRAP_WETH}`, [swap, unwrap], newDeadline()],
    }),
  }
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

export async function waitForResult(wallet, vault, run, hash) {
  const { reader } = clients(wallet)
  const receipt = await reader.waitForTransactionReceipt({ hash })
  if (receipt.status === 'success') return { ok: true, receipt }
  try {
    await reader.simulateContract({ ...runCall(vault, run), blockNumber: receipt.blockNumber - 1n })
    return { ok: false, receipt, failure: { reason: 'The vault refused it.' } }
  } catch (error) {
    return { ok: false, receipt, failure: explainFailure(error) }
  }
}
