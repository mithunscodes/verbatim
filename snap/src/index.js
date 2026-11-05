import { Banner, Box, Text } from '@metamask/snaps-sdk/jsx'
import { decodeErrorResult, decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, getAddress, parseAbi, zeroAddress } from 'viem'

const vaultAbi = parseAbi([
  'struct Action { address target; uint256 value; bytes data; uint8 operation; }',
  'struct Check { uint8 kind; address token; address to; uint256 amount; }',
  'function run(Action[] actions, Check[] checks, uint256 deadline)',
  'function savedAt(address contact) view returns (uint256)',
  'function nameOf(address contact) view returns (string)',
  'error CheckFailed(uint256 checkNumber, string check, uint256 expected, uint256 actual)',
])

const tokenAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)'])

const TOKENS = {
  [zeroAddress]: { symbol: 'ETH', decimals: 18 },
  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': { symbol: 'USDC', decimals: 6 },
  '0x465B8D10e72293513f7FCB77A91A23408d2ed8Ab': { symbol: 'Verbatim Print', decimals: 0 },
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function short(address) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function day(seconds) {
  const date = new Date(Number(seconds) * 1000)
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`
}

function number(token, amount) {
  const known = TOKENS[getAddress(token)]
  return known ? formatUnits(amount, known.decimals) : String(amount)
}

function money(token, amount) {
  const known = TOKENS[getAddress(token)]
  return known ? `${formatUnits(amount, known.decimals)} ${known.symbol}` : `${amount} of token ${short(token)}`
}

function readRun(data) {
  try {
    const call = decodeFunctionData({ abi: vaultAbi, data })
    return call.functionName === 'run' ? call : null
  } catch {
    return null
  }
}

async function read(vault, functionName, args) {
  const data = encodeFunctionData({ abi: vaultAbi, functionName, args })
  const result = await ethereum.request({ method: 'eth_call', params: [{ to: vault, data }, 'latest'] })
  return decodeFunctionResult({ abi: vaultAbi, functionName, data: result })
}

async function contactOf(vault, address) {
  const [savedAt, name] = await Promise.all([
    read(vault, 'savedAt', [address]).catch(() => null),
    read(vault, 'nameOf', [address]).catch(() => ''),
  ])
  return { savedAt, name }
}

function label(address, contact) {
  if (contact?.name) return contact.name
  if (contact?.savedAt) return `${short(address)} (saved ${day(contact.savedAt)})`
  return short(address)
}

function paymentsOf(actions) {
  return actions.flatMap((action) => {
    if (action.data === '0x') return action.value > 0n ? [{ token: zeroAddress, to: action.target, amount: action.value }] : []
    try {
      const call = decodeFunctionData({ abi: tokenAbi, data: action.data })
      return [{ token: action.target, to: call.args[0], amount: call.args[1] }]
    } catch {
      return []
    }
  })
}

function revertData(error) {
  const found = [error?.data, error?.data?.data, error?.data?.originalError?.data, error?.error?.data]
  return found.find((value) => typeof value === 'string' && value.startsWith('0x') && value.length >= 10) ?? null
}

function reasonOf(error) {
  const data = revertData(error)
  if (!data) return error?.message ?? 'the vault refused it'
  try {
    const decoded = decodeErrorResult({ abi: vaultAbi, data })
    if (decoded.errorName === 'CheckFailed') {
      return { checkNumber: Number(decoded.args[0]), expected: decoded.args[2], actual: decoded.args[3] }
    }
    if (decoded.errorName === 'Error') return decoded.args[0]
    return decoded.errorName
  } catch {
    return 'the vault refused it'
  }
}

async function practiceRun(transaction) {
  try {
    await ethereum.request({
      method: 'eth_call',
      params: [{ from: transaction.from, to: transaction.to, data: transaction.data, value: transaction.value ?? '0x0' }, 'latest'],
    })
    return { pass: true }
  } catch (error) {
    return { pass: false, reason: reasonOf(error) }
  }
}

async function refusal(vault, reason, checks, actions) {
  if (typeof reason === 'object') {
    const check = checks[reason.checkNumber - 1]
    if (!check) return `It breaks check ${reason.checkNumber}.`
    const asked = number(check.token, reason.expected)
    if (check.kind === 0) return `Sends ${money(check.token, reason.actual)}, not ${asked}.`
    if (check.kind === 1) return `You'd get only ${money(check.token, reason.actual)}, not ${asked}.`
    const contact = await contactOf(vault, check.to)
    return `Sends ${money(check.token, reason.actual)} to ${label(check.to, contact)}, not ${asked}.`
  }
  if (reason === 'Not a saved contact') {
    for (const payment of paymentsOf(actions)) {
      const contact = await contactOf(vault, payment.to)
      if (contact.savedAt === 0n) return `Sends ${money(payment.token, payment.amount)} to ${short(payment.to)}, not a saved contact.`
    }
  }
  return /[.!?]$/.test(reason) ? reason : `${reason}.`
}

async function summary(vault, checks, online) {
  const sent = new Map()
  for (const check of checks.filter((c) => c.kind === 2)) {
    const token = getAddress(check.token)
    sent.set(token, (sent.get(token) ?? 0n) + check.amount)
  }
  const lines = await Promise.all(checks.map(async (check) => {
    if (check.kind === 0) return (sent.get(getAddress(check.token)) ?? 0n) >= check.amount ? null : `Up to ${money(check.token, check.amount)} out`
    if (check.kind === 1) return `At least ${money(check.token, check.amount)} in`
    if (check.kind === 2) return `${money(check.token, check.amount)} → ${label(check.to, online ? await contactOf(vault, check.to) : null)}`
    return `Unknown check type ${check.kind}`
  }))
  return lines.filter(Boolean)
}

async function useChain(chainId) {
  const hex = `0x${Number(String(chainId).split(':').pop()).toString(16)}`
  await ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  return true
}

export const onTransaction = async ({ transaction, chainId }) => {
  const call = readRun(transaction.data ?? '0x')
  if (!call) {
    return { content: Box({ children: [Text({ children: 'This is not a request to a Verbatim vault.' })] }) }
  }
  const [actions, checks] = call.args
  const vault = getAddress(transaction.to)
  const online = await useChain(chainId).catch(() => false)
  const practice = online ? await practiceRun(transaction) : null
  if (practice && !practice.pass) {
    const why = await refusal(vault, practice.reason, checks, actions)
    return {
      content: Box({
        children: [
          Banner({
            title: 'STOP. YOUR VAULT WILL REFUSE THIS.',
            severity: 'danger',
            children: Text({ fontWeight: 'bold', children: why }),
          }),
        ],
      }),
      severity: 'critical',
    }
  }
  const lines = await summary(vault, checks, online)
  return {
    content: Box({
      children: [
        Text({ children: practice ? '✓ Your vault accepts this.' : "Couldn't test this with your vault." }),
        ...lines.map((line) => Text({ children: line })),
        Text({ children: 'Nothing else leaves your vault.' }),
      ],
    }),
  }
}
