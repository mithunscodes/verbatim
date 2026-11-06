export const HOST = '127.0.0.1'

export const PORT = 8787

export const CHAIN_ID = 11155111

export const UNISWAP_API = 'https://trade-api.gateway.uniswap.org/v1'

export const ROUTER_VERSION = '2.0'

export const UNIVERSAL_ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b'

export const V4_QUOTER = '0x68aFa8b853cAa7a2D40B0F6AEE5C4DbC147C8244'

export const PROTOCOLS = ['V2', 'V3', 'V4']

export const SLIPPAGE_PERCENT = 0.5

export const UNISWAP_TIMEOUT_MS = 15_000

export const UNISWAP_RETRIES = 1

export const TOKENS = {
  '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238': 'USDC',
  '0x0000000000000000000000000000000000000000': 'ETH',
}

export const ZG_ROUTER = 'https://router-api.0g.ai/v1'

export const ZG_PROVIDER = '0xD179F4526064846dE9a9E9D93683AF75CB72E503'

export const AI_MODEL = 'glm-5.3'

export const AI_MAX_TOKENS = 4000

export const AI_TIMEOUT_MS = 90_000

export const ZG_BUSY_RETRIES = 2

export const ZG_BUSY_WAIT_MS = 3_000

export const ZG_MAINNET_RPC = 'https://evmrpc.0g.ai'

export const ZG_INFERENCE = '0x47340d900bdFec2BD393c626E12ea0656F938d84'

export const SIGNATURE_TRIES = 5

export const SIGNATURE_WAIT_MS = 3000

export const GALILEO_RPC = 'https://evmrpc-testnet.0g.ai'

export const ZG_INDEXER = 'https://indexer-storage-testnet-turbo.0g.ai'

export const GALILEO_EXPLORER = 'https://chainscan-galileo.0g.ai'

export const MAX_RECEIPT_BYTES = 32_000

export const IMAGE_MODEL = 'z-image-turbo'

export const IMAGE_SIZE = '512x512'

export const IMAGE_TIMEOUT_MS = 240_000

export const IMAGE_MAX_ACTIVE = 2

export const IMAGE_KEEP_MS = 1_800_000

export const MAX_IMAGE_BYTES = 2_000_000

export const MAX_UPLOAD_BYTES = 1_000_000

export const WETH = '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14'

export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'

export const UNISWAP_POOL_MANAGER = '0xE03A1074c86CFeDd5C142C4F04F1a1536e203543'

export const UNISWAP_V3_POOLS = [
  '0xFeEd501c2B21D315F04946F85fC6416B640240b5',
  '0x3289680dD4d6C10bb19b899729cda5eEF58AEfF1',
  '0x6Ce0896eAE6D4BD668fDe41BB784548fb8F59b50',
  '0x6418EEC70f50913ff0d756B48d32Ce7C02b47C47',
]

export const RPC_METHODS = [
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_getTransactionCount',
  'eth_getTransactionByHash',
  'eth_getTransactionReceipt',
  'eth_sendRawTransaction',
]

export const RPC_BATCH_LIMIT = 20

export const RPC_TIMEOUT_MS = 30_000

export const ANVIL = `${process.env.HOME}/.foundry/bin/anvil`

export const REPLAY_PORT = 8547

export const REPLAY_START_TIMEOUT_MS = 30_000

export const SEPOLIA_EXPLORER = 'https://sepolia.etherscan.io'

export const REPLAY_PRIORITY_FEE = 100_000_000n

export const REPLAY_ATTEMPT_GAS = 3_000_000n

export const REPLAY_BUILDER_FLOOR = 10_000_000_000_000_000n

export const REPLAY_MAX_WAITING = 2

export const REPLAY_POLL_MS = 2_000

export const REPLAY_KEEP_MS = 1_800_000

export const VAULT_FACTORY = '0x6FF1413856DC74CfD038bC8B24129a449418fC3e'

export const NAME_MAX_WAITING = 3

export const PUBLIC_ROUTES = ['GET /api/go', 'POST /api/rpc']

export const LAPTOP_ONLY_ROUTES = ['POST /api/upload']

export const OUTSIDE_LIMITS = {
  'GET /api/go': { count: 30, minutes: 10 },
  'POST /api/rpc': { count: 1_200, minutes: 10 },
  eth_sendRawTransaction: { count: 30, minutes: 10 },
}

export const LAPTOP_LIMITS = {
  'POST /api/understand': { count: 60, minutes: 60 },
  'POST /api/preview': { count: 60, minutes: 60 },
  'POST /api/quote': { count: 120, minutes: 60 },
  'POST /api/receipt': { count: 30, minutes: 60 },
  'POST /api/replay': { count: 12, minutes: 60 },
  'POST /api/name': { count: 6, minutes: 60 },
  'POST /api/image': { count: 10, minutes: 60 },
  'POST /api/upload': { count: 10, minutes: 60 },
}

export const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1']

export const PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'x-real-ip', 'true-client-ip', 'forwarded']
