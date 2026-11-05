import { appendFileSync, readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, formatEther, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { defineChain } from 'viem'
import { GALILEO_EXPLORER, GALILEO_RPC } from '../src/config.js'
import { loadReceipt, saveReceipt } from '../src/receipts.js'
import { buildReceipt, keyFromSignature, openReceipt, sealReceipt } from '../../app/src/receipts.js'

const ENV_FILE = new URL('../../.env', import.meta.url)
const FUNDING = parseEther('0.05')
const galileo = defineChain({
  id: 16602,
  name: '0G Galileo',
  nativeCurrency: { name: '0G', symbol: '0G', decimals: 18 },
  rpcUrls: { default: { http: [GALILEO_RPC] } },
})
const client = createPublicClient({ chain: galileo, transport: http(GALILEO_RPC, { timeout: 60_000 }) })

function makeKey() {
  const env = readFileSync(ENV_FILE, 'utf8')
  if (process.env.RECEIPTS_PRIVATE_KEY || /^RECEIPTS_PRIVATE_KEY=/m.test(env)) {
    console.log('RECEIPTS_PRIVATE_KEY is already in .env, kept as it is')
    return
  }
  const key = generatePrivateKey()
  appendFileSync(ENV_FILE, `${env.endsWith('\n') ? '' : '\n'}RECEIPTS_PRIVATE_KEY=${key}\n`)
  console.log(`RECEIPTS_PRIVATE_KEY added to .env. Address: ${privateKeyToAccount(key).address}`)
}

async function fund() {
  const payer = privateKeyToAccount(process.env.RECEIPTS_PRIVATE_KEY).address
  const builder = privateKeyToAccount(process.env.BUILDER_PRIVATE_KEY)
  const balance = await client.getBalance({ address: payer })
  console.log(`Receipts key ${payer}: ${formatEther(balance)} test 0G`)
  if (balance >= FUNDING / 2n) return
  const wallet = createWalletClient({ account: builder, chain: galileo, transport: http(GALILEO_RPC) })
  const hash = await wallet.sendTransaction({ to: payer, value: FUNDING - balance })
  await client.waitForTransactionReceipt({ hash, timeout: 120_000 })
  console.log(`Sent ${formatEther(FUNDING - balance)} test 0G from the Builder key: ${GALILEO_EXPLORER}/tx/${hash}`)
}

async function check() {
  const signature = `0x${'ab'.repeat(65)}`
  const key = await keyFromSignature(signature)
  const receipt = buildReceipt({
    vault: '0x0000000000000000000000000000000000000001',
    account: '0x0000000000000000000000000000000000000002',
    chainId: 11155111,
    sentence: 'Send 5 USDC to ravi.verbatimalice.eth (a test receipt)',
    ai: null,
    checks: [{ kind: 0, token: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', to: '0x0000000000000000000000000000000000000000', amount: 5_000000n }],
    checksInWords: ['At most 5 USDC leaves your vault'],
    result: { hash: `0x${'12'.repeat(32)}`, ok: true },
  })
  const sealed = await sealReceipt(key, receipt)
  console.log(`Sealed receipt: ${JSON.stringify(sealed).length} bytes, readable only with the key`)
  console.log('Uploading to 0G Storage (Galileo)…')
  const started = Date.now()
  const saved = await saveReceipt(sealed)
  console.log(`✓ Saved in ${((Date.now() - started) / 1000).toFixed(1)} s. Root ${saved.root}`)
  console.log(`  Transaction: ${saved.explorer}`)
  const back = await loadReceipt(saved.root)
  const opened = await openReceipt(key, back)
  const same = JSON.stringify(opened) === JSON.stringify(JSON.parse(JSON.stringify(receipt, (k, v) => (typeof v === 'bigint' ? v.toString() : v))))
  console.log(`${same ? '✓' : '✗'} Downloaded by its root and opened with the key: "${opened.sentence}"`)
  const wrongKey = await keyFromSignature(`0x${'cd'.repeat(65)}`)
  const locked = await openReceipt(wrongKey, back).then(() => false, () => true)
  console.log(`${locked ? '✓' : '✗'} With a different key, it can't be opened`)
  const stored = JSON.stringify(back)
  console.log(`${stored.includes('ravi') ? '✗' : '✓'} The stored file doesn't contain the sentence in plain text`)
}

const commands = { key: makeKey, fund, check }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node --env-file=../.env scripts/receipts.js key | fund | check')
  process.exit(1)
}
Promise.resolve(command()).catch((error) => {
  const secrets = [process.env.RECEIPTS_PRIVATE_KEY, process.env.BUILDER_PRIVATE_KEY].filter(Boolean)
  console.error(secrets.reduce((text, secret) => text.split(secret).join('[hidden]'), String(error.stack ?? error)))
  process.exit(1)
})
