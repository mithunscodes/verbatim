import { createPublicClient, erc20Abi, getAddress, http, parseAbi, zeroAddress } from 'viem'
import { sepolia } from 'viem/chains'
import { preview } from '../src/preview.js'
import { quoteSwap } from '../src/uniswap.js'
import { drainTransaction, extraActions, sendActions, swapActions } from '../../app/src/run.js'

const VAULT = getAddress(process.argv[2] ?? '0xd03a1550f19E6b815a80a51ae40b8807c4702A69')
const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) })
const vaultAbi = parseAbi(['function contacts(uint256) view returns (address)'])

async function main() {
  const [balance, builder] = await Promise.all([
    client.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [VAULT] }),
    client.readContract({ address: VAULT, abi: vaultAbi, functionName: 'contacts', args: [0n] }),
  ])
  console.log(`Vault ${VAULT} holds ${Number(balance) / 1e6} USDC. Simulations only: nothing is sent.\n`)
  const quote = await quoteSwap({ swapper: VAULT, tokenIn: USDC, tokenOut: zeroAddress, amount: '5000000' })
  const honestSwap = swapActions({ from: USDC, amount: 5_000000n, transaction: { ...quote.transaction, value: BigInt(quote.transaction.value) } })
  const drainSwap = swapActions({ from: USDC, amount: 5_000000n, transaction: drainTransaction({ from: USDC, amount: 5_000000n, balance }) })

  const cases = [
    { name: 'Honest send', sentence: 'Send 1 USDC to Builder', actions: sendActions({ token: USDC, amount: 1_000000n, to: builder }), match: true },
    { name: 'Hacked app on the Send tab (sends 1 USDC more)', sentence: 'Send 1 USDC to Builder', actions: sendActions({ token: USDC, amount: 2_000000n, to: builder }), match: false },
    { name: 'Honest swap through Uniswap', sentence: 'Swap 5 USDC for ETH', actions: honestSwap, match: true },
    { name: "6.4's hacked app: hides a drain of your other USDC inside the swap", sentence: 'Swap 5 USDC for ETH', actions: drainSwap, match: false, mentions: String(Number(balance - 5_000000n) / 1e6) },
    { name: 'A hidden 0.1 USDC tip to a stranger', sentence: 'Swap 5 USDC for ETH', actions: [...honestSwap, ...extraActions('tip', { from: USDC, decimals: 6 })], match: false },
    { name: 'Borrowed code run inside the vault', sentence: 'Swap 5 USDC for ETH', actions: [...honestSwap, ...extraActions('borrowed', { from: USDC, decimals: 6 })], match: false },
  ]

  let passed = 0
  let cost = 0
  for (const test of cases) {
    const result = await preview({
      sentence: test.sentence,
      vault: VAULT,
      actions: test.actions.map((a) => ({ target: a.target, value: String(a.value), data: a.data, operation: a.operation })),
      tokens: [{ token: USDC, symbol: 'USDC', decimals: 6 }],
      contacts: { [builder]: 'Builder' },
      known: {},
    })
    const { verdict } = result
    cost += result.costUsdMicro ?? 0
    const mentioned = !test.mentions || verdict?.differences.some((d) => d.includes(test.mentions))
    const ok = verdict && verdict.matches === test.match && mentioned && result.proof?.verified
    if (ok) passed++
    console.log(`${ok ? '✓' : '✗'} ${test.name}: "${test.sentence}"`)
    for (const fact of result.facts) console.log(`    fact: ${fact}`)
    if (verdict) {
      console.log(`    sealed AI: ${verdict.matches ? '✅ matches' : '⚠️ ' + verdict.differences.join(' | ')}`)
    } else {
      console.log(`    sealed AI: no verdict (${result.problem})`)
    }
    if (result.proof) console.log(`    sealed hardware ${result.proof.verified ? '✓' : '✗'}, ${(result.latencyMs / 1000).toFixed(1)} s${result.cached ? ' (cached)' : ''}`)
  }
  console.log(`\n${passed}/${cases.length} previews as expected. Cost: $${(cost / 1e6).toFixed(4)}`)
}

main().catch((error) => {
  const secrets = [process.env.ZG_ROUTER_API_KEY, process.env.UNISWAP_API_KEY, process.env.SEPOLIA_RPC_URL].filter(Boolean)
  console.error(secrets.reduce((text, secret) => text.split(secret).join('[hidden]'), String(error.stack ?? error)))
  process.exit(1)
})
