import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import Ajv2020 from 'ajv/dist/2020.js'
import { format, isFieldGroup } from '@ethereum-sourcify/clear-signing'
import { createPublicClient, encodeFunctionData, erc20Abi, getAddress, http, toFunctionSelector, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { FACTORY, NICKNAMES, PERMIT2, UNIVERSAL_ROUTER, vaultAbi } from '../../app/src/config.js'

const FOLDER = new URL('../../contracts/clear-signing/', import.meta.url)
const FILE = new URL('calldata-VerbatimVault.json', FOLDER)
const SCHEMA_URLS = [
  'https://eips.ethereum.org/assets/eip-7730/erc7730-v2.schema.json',
  'https://raw.githubusercontent.com/ethereum/clear-signing-erc7730-registry/master/specs/erc7730-v2.schema.json',
]
const RUN = 'run((address target,uint256 value,bytes data,uint8 operation)[] actions,(uint8 kind,address token,address to,uint256 amount)[] checks,uint256 deadline)'
const SEND_RUN = '0x33c73c2715d9620ce3a27eaf8fc7134d34fea80677ef4031d8d877fa74475205'
const SWAP_RUN = '0x7181f01917ebcefe86d49c0df8181f2ef0f5b935a86a87fb80ca363f1d508cb1'

export function descriptor() {
  return {
    $schema: SCHEMA_URLS[0],
    context: {
      $id: 'VerbatimVault',
      contract: {
        factory: {
          deployEvent: 'VaultCreated(address indexed vault, address indexed everydayKey, address indexed rulesKey)',
          deployments: [{ chainId: sepolia.id, address: FACTORY }],
        },
      },
    },
    metadata: {
      owner: 'Verbatim',
      contractName: 'VerbatimVault',
      enums: {
        checkKind: {
          0: 'At most this leaves your vault',
          1: 'At least this arrives in your vault',
          2: 'Exactly this goes to',
        },
      },
    },
    display: {
      formats: {
        [RUN]: {
          intent: 'Run with your checks',
          fields: [
            {
              path: '#.checks.[]',
              label: 'Your checks',
              fields: [
                { path: 'kind', label: 'Check', format: 'enum', params: { $ref: '$.metadata.enums.checkKind' } },
                { path: 'amount', label: 'Amount', format: 'tokenAmount', params: { tokenPath: 'token', nativeCurrencyAddress: zeroAddress } },
                {
                  path: 'to',
                  label: 'To',
                  format: 'addressName',
                  params: { types: ['eoa', 'wallet', 'contract'], sources: ['local', 'ens'] },
                  visible: { ifNotIn: [zeroAddress] },
                },
                { path: 'token', label: 'Token', visible: 'never' },
              ],
            },
            {
              path: '#.actions.[]',
              label: 'What the app will do',
              fields: [
                { path: 'target', label: 'Calls', format: 'addressName', params: { types: ['contract', 'token', 'eoa', 'wallet'], sources: ['local', 'ens'] } },
                { path: 'value', label: 'Sends', format: 'amount', visible: { ifNotIn: [0] } },
                { path: 'operation', label: 'Borrowed code', format: 'raw', visible: { mustMatch: [0] } },
                { path: 'data', label: 'Data', visible: 'never' },
              ],
            },
            { path: '#.deadline', label: 'Valid until', format: 'date', params: { encoding: 'timestamp' } },
          ],
        },
      },
    },
  }
}

const text = (value) => `${JSON.stringify(value, null, 2)}\n`

function write() {
  mkdirSync(FOLDER, { recursive: true })
  writeFileSync(FILE, text(descriptor()))
  console.log(`Wrote ${FILE.pathname.split('/verbatim/').pop()} for the factory at ${FACTORY} on Sepolia.`)
}

async function officialSchema() {
  for (const url of SCHEMA_URLS) {
    const response = await fetch(url).catch(() => null)
    if (response?.ok) return response.json()
  }
  throw new Error("Couldn't download the official ERC-7730 v2 schema.")
}

async function check() {
  const results = []
  const say = (name, ok, detail = '') => {
    results.push(ok)
    console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n    ${detail}` : ''}`)
  }
  const saved = readFileSync(FILE, 'utf8')
  say('The saved file is up to date with this script and the factory address in the app', saved === text(descriptor()))
  const schema = await officialSchema()
  const validate = new Ajv2020({ strict: false, allErrors: true, validateFormats: false }).compile(schema)
  const valid = validate(JSON.parse(saved))
  say(`It matches the official ERC-7730 schema (version ${schema.version})`, valid, JSON.stringify(validate.errors?.slice(0, 3)))
  const run = vaultAbi.find((item) => item.type === 'function' && item.name === 'run')
  say("Its function is the vault's own run function (same selector)", toFunctionSelector(RUN) === toFunctionSelector(run), `${toFunctionSelector(RUN)} vs ${toFunctionSelector(run)}`)
  const artifact = JSON.parse(readFileSync(new URL('../../contracts/out/VerbatimVault.sol/VerbatimVault.json', import.meta.url), 'utf8'))
  const compiled = Object.entries(artifact.methodIdentifiers).find(([signature]) => signature.startsWith('run('))
  say('The selector also matches the compiled contract', compiled && `0x${compiled[1]}` === toFunctionSelector(RUN), String(compiled))
  return results.every(Boolean)
}

function sepoliaReader() {
  if (!process.env.SEPOLIA_RPC_URL) throw new Error('SEPOLIA_RPC_URL is missing from .env.')
  return createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) })
}

async function listOf(reader, vault, functionName) {
  const items = []
  for (;;) {
    const item = await reader.readContract({ address: vault, abi: vaultAbi, functionName, args: [BigInt(items.length)] }).catch(() => null)
    if (!item) return items
    items.push(item)
  }
}

async function nameBook(reader, vault) {
  const book = { [PERMIT2]: 'Permit2', [UNIVERSAL_ROUTER]: 'Uniswap Universal Router', ...NICKNAMES }
  const names = {}
  for (const [address, name] of Object.entries(book)) names[address.toLowerCase()] = name
  for (const token of await listOf(reader, vault, 'watchedTokens')) {
    names[token.toLowerCase()] = await reader.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' })
  }
  for (const contact of await listOf(reader, vault, 'contacts')) {
    const name = await reader.readContract({ address: vault, abi: vaultAbi, functionName: 'nameOf', args: [contact] }).catch(() => '')
    if (name) names[contact.toLowerCase()] = name
  }
  return names
}

export async function render(hash) {
  const reader = sepoliaReader()
  const tx = await reader.getTransaction({ hash })
  return renderCall(reader, { vault: getAddress(tx.to), data: tx.input, value: tx.value, from: tx.from })
}

async function renderCall(reader, { vault, data, value, from }) {
  const names = await nameBook(reader, vault)
  const bound = descriptor()
  bound.context.contract.deployments = [{ chainId: sepolia.id, address: vault }]
  const path = 'calldata-VerbatimVault.json'
  const resolver = {
    index: { calldataIndex: { [`eip155:${sepolia.id}:${vault.toLowerCase()}`]: path }, typedDataIndex: {} },
    fetchDescriptor: async () => bound,
  }
  const externalDataProvider = {
    resolveToken: async (chainId, token) => {
      try {
        const [symbol, decimals, name] = await Promise.all(['symbol', 'decimals', 'name'].map((functionName) => reader.readContract({ address: token, abi: erc20Abi, functionName })))
        return { symbol, decimals, name }
      } catch {
        return null
      }
    },
    resolveLocalName: async (address) => (names[address.toLowerCase()] ? { name: names[address.toLowerCase()], typeMatch: true } : null),
    resolveEnsName: async () => null,
    resolveChainInfo: async (chainId) => (chainId === sepolia.id ? { name: 'Sepolia', nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 } } : null),
  }
  const display = await format(
    { chainId: sepolia.id, to: vault, data, value, from },
    { descriptorResolverOptions: { type: 'custom', resolver }, externalDataProvider },
  )
  return { vault, display }
}

async function renderBorrowedCode(vault) {
  const reader = sepoliaReader()
  const stranger = '0x000000000000000000000000000000000000dEaD'
  const data = encodeFunctionData({
    abi: vaultAbi,
    functionName: 'run',
    args: [[{ target: stranger, value: 0n, data: '0x', operation: 1 }], [], 1_900_000_000n],
  })
  return renderCall(reader, { vault, data, value: 0n, from: stranger })
}

function lines(display) {
  const out = [`Intent: ${typeof display.intent === 'string' ? display.intent : JSON.stringify(display.intent)}`]
  for (const item of display.fields ?? []) {
    if (isFieldGroup(item)) {
      out.push(`${item.label ?? 'Group'}:${item.warning ? `  ⚠ ${item.warning.message}` : ''}`)
      for (const field of item.fields) out.push(`  ${field.label}: ${field.value}${field.warning ? `  ⚠ ${field.warning.message}` : ''}`)
    } else {
      out.push(`${item.label}: ${item.value}${item.warning ? `  ⚠ ${item.warning.message}` : ''}`)
    }
  }
  for (const warning of display.warnings ?? []) out.push(`⚠ ${warning.code}: ${warning.message}`)
  return out
}

async function show(hash) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash ?? '')) throw new Error('Give a Sepolia transaction hash: node --env-file=../.env scripts/clear-signing.js show 0x…')
  const { vault, display } = await render(hash)
  console.log(`What a Clear Signing wallet would show for ${hash.slice(0, 10)}… to the vault ${vault}, rendered by Sourcify's library:\n`)
  for (const line of lines(display)) console.log(`  ${line}`)
}

async function test() {
  const ok = await check()
  const results = [ok]
  const say = (name, pass, detail = '') => {
    results.push(pass)
    console.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `\n    ${detail.split('\n').join('\n    ')}` : ''}`)
  }
  const { vault, display: sendDisplay } = await render(SEND_RUN)
  const send = lines(sendDisplay)
  say('A send to the thief renders with its intent', send[0] === 'Intent: Run with your checks', send.join('\n'))
  say('  "At most this leaves your vault" shows the token amount', send.some((l) => l.includes('Check: At most this leaves your vault')) && send.some((l) => /Amount: [\d.,]+ USDC/.test(l)), send.join('\n'))
  say('  "Exactly this goes to" shows the receiver', send.some((l) => l.includes('Check: Exactly this goes to')) && send.some((l) => l.trim().startsWith('To: ')), send.join('\n'))
  say('  The receiver isn\'t a saved name, so the wallet warns about it, and only about it', send.filter((l) => l.includes('⚠')).length === 1 && send.some((l) => l.trim().startsWith('To: ') && l.includes('could not be resolved')), send.join('\n'))
  say('  The deadline shows as a date', send.some((l) => l.startsWith('Valid until: ') && !/^Valid until: \d+$/.test(l)), send.join('\n'))
  const swap = lines((await render(SWAP_RUN)).display)
  say('A swap renders with no warnings', !swap.some((l) => l.includes('⚠')), swap.join('\n'))
  say('  "At least this arrives" shows the ETH amount', swap.some((l) => l.includes('Check: At least this arrives in your vault')) && swap.some((l) => /Amount: [\d.,]+ ETH/.test(l)), swap.join('\n'))
  say('  The app\'s calls are named (USDC, Permit2, Universal Router)', ['Calls: USDC', 'Calls: Permit2', 'Calls: Uniswap Universal Router'].every((name) => swap.some((l) => l.trim() === name)), swap.join('\n'))
  const borrowed = lines((await renderBorrowedCode(vault)).display)
  say('Bybit-style borrowed code: the wallet itself warns', borrowed.some((l) => l.includes("'Borrowed code' value does not match")), borrowed.join('\n'))
  const failed = results.filter((pass) => !pass).length
  console.log(failed === 0 ? '\nAll checks passed.' : `\n${failed} check(s) failed.`)
  if (failed) process.exitCode = 1
}

const commands = { write, check: async () => { if (!(await check())) process.exitCode = 1 }, show: () => show(process.argv[3]), test }
const command = process.argv[2]
if (!commands[command]) {
  console.log('Usage: node --env-file=../.env scripts/clear-signing.js write | check | show <transaction hash> | test')
  process.exit(1)
}
Promise.resolve(commands[command]()).catch((error) => {
  console.error(String(error.stack ?? error).split(process.env.SEPOLIA_RPC_URL ?? '\u0000').join('[hidden]'))
  process.exit(1)
})
