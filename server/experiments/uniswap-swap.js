import { createPublicClient, createWalletClient, http, parseAbi, formatUnits, formatEther, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

const API = 'https://trade-api.gateway.uniswap.org/v1'
const CHAIN_ID = 11155111
const USDC = getAddress('0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238')
const ETH = '0x0000000000000000000000000000000000000000'
const PERMIT2 = getAddress('0x000000000022D473030F116dDEE9F6B43aC78BA3')
const ROUTER = getAddress('0x3a9d48ab9751398bbfa63ad67599bb04e4bdf98b')
const AMOUNT = 5_000_000n
const MAX_UINT160 = (2n ** 160n - 1n).toString()
const EXPLORER = 'https://sepolia.etherscan.io/tx/'

const secrets = [
  process.env.EVERYDAY_PRIVATE_KEY,
  process.env.UNISWAP_API_KEY,
  process.env.SEPOLIA_RPC_URL,
  process.env.SEPOLIA_RPC_URL?.split('/').pop(),
].filter(Boolean)
const redact = (text) => secrets.reduce((result, secret) => result.split(secret).join('[hidden]'), String(text))
const ist = (seconds) => new Date(Number(seconds) * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })

const account = privateKeyToAccount(process.env.EVERYDAY_PRIVATE_KEY)
const transport = http(process.env.SEPOLIA_RPC_URL)
const publicClient = createPublicClient({ chain: sepolia, transport })
const walletClient = createWalletClient({ account, chain: sepolia, transport })

const erc20Abi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])
const permit2Abi = parseAbi([
  'function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
])

async function callApi(path, body, routerVersion = '2.0') {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.UNISWAP_API_KEY,
      'x-universal-router-version': routerVersion,
    },
    body: JSON.stringify(body),
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(json)}`)
  return json
}

function getQuote(routerVersion) {
  return callApi('/quote', {
    swapper: account.address,
    tokenIn: USDC,
    tokenOut: ETH,
    tokenInChainId: String(CHAIN_ID),
    tokenOutChainId: String(CHAIN_ID),
    amount: AMOUNT.toString(),
    type: 'EXACT_INPUT',
    slippageTolerance: 0.5,
    routingPreference: 'BEST_PRICE',
  }, routerVersion)
}

function exactPermitValues(values) {
  return {
    details: { ...values.details, amount: AMOUNT.toString(), expiration: values.sigDeadline },
    spender: values.spender,
    sigDeadline: values.sigDeadline,
  }
}

function signPermit(permitData, values) {
  return walletClient.signTypedData({
    domain: permitData.domain,
    types: permitData.types,
    primaryType: 'PermitSingle',
    message: {
      details: {
        token: values.details.token,
        amount: BigInt(values.details.amount),
        expiration: Number(values.details.expiration),
        nonce: Number(values.details.nonce),
      },
      spender: values.spender,
      sigDeadline: BigInt(values.sigDeadline),
    },
  })
}

function describeQuote(quoteResponse) {
  const { quote, permitData } = quoteResponse
  console.log(`Routing: ${quoteResponse.routing}`)
  console.log(`Route: ${quote.routeString}`)
  console.log(`In: ${formatUnits(BigInt(quote.input.amount), 6)} USDC`)
  console.log(`Out: ${formatEther(BigInt(quote.output.amount))} ETH (at least ${formatEther(BigInt(quote.output.minimumAmount))})`)
  console.log(`Estimated fee: ${formatEther(BigInt(quote.gasFee))} ETH`)
  if (permitData) {
    const { details, spender } = permitData.values
    const amount = details.amount === MAX_UINT160 ? 'unlimited' : formatUnits(BigInt(details.amount), 6)
    console.log(`Uniswap's default permit: ${amount} USDC for ${spender}, until ${ist(details.expiration)}`)
  }
}

async function readAllowances() {
  const toPermit2 = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'allowance', args: [account.address, PERMIT2] })
  const [amount, expiration, nonce] = await publicClient.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [account.address, USDC, ROUTER] })
  return { toPermit2, amount, expiration, nonce }
}

async function status() {
  const eth = await publicClient.getBalance({ address: account.address })
  const usdc = await publicClient.readContract({ address: USDC, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] })
  const { toPermit2, amount, expiration, nonce } = await readAllowances()
  console.log(`Wallet: ${account.address}`)
  console.log(`ETH: ${formatEther(eth)}`)
  console.log(`USDC: ${formatUnits(usdc, 6)}`)
  console.log(`USDC that Permit2 may spend: ${formatUnits(toPermit2, 6)}`)
  console.log(`USDC that the Universal Router may spend through Permit2: ${formatUnits(amount, 6)} (expiry ${expiration === 0 ? 'not set' : ist(expiration)}, nonce ${nonce})`)
}

async function waitAndReport(hash) {
  console.log(`Sent: ${EXPLORER}${hash}`)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  console.log(`Result: ${receipt.status}, block ${receipt.blockNumber}, gas used ${receipt.gasUsed}, fee ${formatEther(receipt.gasUsed * receipt.effectiveGasPrice)} ETH`)
  console.log('')
  await status()
}

async function approve() {
  const { toPermit2 } = await readAllowances()
  if (toPermit2 >= AMOUNT) throw new Error(`Permit2 can already spend ${formatUnits(toPermit2, 6)} USDC`)
  console.log(`Approving Permit2 to spend exactly ${formatUnits(AMOUNT, 6)} USDC`)
  const hash = await walletClient.writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, AMOUNT] })
  await waitAndReport(hash)
}

async function swap() {
  const { toPermit2 } = await readAllowances()
  if (toPermit2 < AMOUNT) throw new Error('Run approve first')
  const quoteResponse = await getQuote()
  if (quoteResponse.routing !== 'CLASSIC') throw new Error(`Expected CLASSIC routing, got ${quoteResponse.routing}`)
  if (BigInt(quoteResponse.quote.input.amount) !== AMOUNT) throw new Error('Quote input is not exactly 5 USDC')
  if (getAddress(quoteResponse.quote.output.recipient) !== account.address) throw new Error('Quote output does not come back to this wallet')
  describeQuote(quoteResponse)

  const { permitData, permitTransaction, ...cleanQuote } = quoteResponse
  const body = { ...cleanQuote }
  if (permitData) {
    if (getAddress(permitData.values.spender) !== ROUTER) throw new Error(`Unexpected permit spender ${permitData.values.spender}`)
    const values = exactPermitValues(permitData.values)
    body.signature = await signPermit(permitData, values)
    body.permitData = { ...permitData, values }
    console.log(`Signed permit: exactly ${formatUnits(AMOUNT, 6)} USDC for ${values.spender}, until ${ist(values.sigDeadline)}`)
  }

  const { swap: transaction } = await callApi('/swap', body)
  if (getAddress(transaction.to) !== ROUTER) throw new Error(`Swap goes to unexpected contract ${transaction.to}`)
  if (BigInt(transaction.value ?? 0) !== 0n) throw new Error(`Swap would send ETH: ${transaction.value}`)
  const estimate = await publicClient.estimateGas({ account, to: transaction.to, data: transaction.data, value: 0n })
  const gas = (estimate * 13n) / 10n
  console.log(`Gas limit: ${gas} (node estimate ${estimate}, Uniswap suggested ${transaction.gasLimit ?? 'none'})`)
  const hash = await walletClient.sendTransaction({ to: transaction.to, data: transaction.data, value: 0n, gas })
  await waitAndReport(hash)
}

async function practiceRun(transaction, gas) {
  try {
    await publicClient.call({ account, to: transaction.to, data: transaction.data, value: 0n, gas })
    return 'passes'
  } catch (error) {
    return `fails (${redact(error.shortMessage ?? error.message).split('\n')[0]})`
  }
}

async function gasCheck() {
  const { toPermit2 } = await readAllowances()
  if (toPermit2 < AMOUNT) throw new Error('Run approve first')
  for (const routerVersion of ['2.0', '2.1.2']) {
    try {
      const quoteResponse = await getQuote(routerVersion)
      const { permitData, permitTransaction, ...cleanQuote } = quoteResponse
      if (!permitData) throw new Error('Quote has no permit to compare')
      console.log(`Router version ${routerVersion} (${permitData.values.spender}), quote gas estimate ${quoteResponse.quote.gasUseEstimate}, quote gas limit ${quoteResponse.quote.gasEstimates?.[0]?.gasLimit}`)
      const versions = [
        ["Uniswap's untouched permit", permitData.values],
        ['Exact 5 USDC permit', exactPermitValues(permitData.values)],
      ]
      for (const [label, values] of versions) {
        const signature = await signPermit(permitData, values)
        const { swap: transaction } = await callApi('/swap', { ...cleanQuote, signature, permitData: { ...permitData, values } }, routerVersion)
        const suggested = BigInt(transaction.gasLimit)
        const needed = await publicClient.estimateGas({ account, to: transaction.to, data: transaction.data, value: 0n })
        console.log(`  ${label}: Uniswap's gas limit ${suggested}, real need ${needed}, practice run with Uniswap's limit ${await practiceRun(transaction, suggested)}, with real need ${await practiceRun(transaction, needed)}`)
      }
    } catch (error) {
      console.log(`Router version ${routerVersion}: ${redact(error.message)}`)
    }
  }
}

const commands = { status, quote: async () => describeQuote(await getQuote()), approve, swap, gascheck: gasCheck }
const command = commands[process.argv[2]]
if (!command) {
  console.log('Usage: node --env-file=../.env experiments/uniswap-swap.js status|quote|approve|swap|gascheck')
  process.exit(1)
}
command().catch((error) => {
  console.error(redact(error.stack ?? error))
  process.exit(1)
})
