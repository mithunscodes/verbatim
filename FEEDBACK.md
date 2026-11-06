# Feedback for Uniswap

*From the team behind Verbatim (ETHGlobal Mumbai 2026). We used the Uniswap Trading API, Permit2, the Universal Router, v3 pools (as our fair-price source), and a v4 pool with our own hook (PoolManager, V4Quoter, StateView), all on Ethereum Sepolia. Everything below happened to us, with dates, steps and links. Times are IST unless marked UTC.*

## What worked well

- **v4 on Sepolia worked first time.** Our own hook on a v4 pool, quotes from the V4Quoter, prices read through StateView, and swaps through the Universal Router's `V4_SWAP` all worked on the first try, using the addresses on the v4 deployments page.
- **The Trading API's swaps fit a smart account with no signed permits.** Asked without a permit, `/swap` returned a router call with only `V4_SWAP`, so our vault could use an exact on-chain Permit2 allowance that ends in the same transaction.
- **Uniswap's own pools as a fair-price source.** The v3 pools' `observe` gave our vault a manipulation-resistant price on Sepolia, after we raised two thin pools' history (`increaseObservationCardinalityNext`, 12 transactions, 0.000153 test ETH).

## Bugs and problems

### `/swap` returns a gas limit that's too low when the swap includes a Permit2 permit (Ethereum Sepolia)

**When** (14 Oct 2026, UTC with IST in brackets):

| Time | What |
|---|---|
| 04:41:48 UTC (10:11:48 IST) | **Found:** our swap reverted, at block 11,910,929 |
| About 04:55 UTC (10:25 IST) | **Confirmed:** a free check showed Uniswap's untouched flow fails the same way |
| 04:56:48 UTC (10:26:48 IST) | **Worked around:** the same swap succeeded with our own gas estimate, at block 11,911,004 |

**What happens:** the transaction from `/swap` reverts when it's sent with the `gasLimit` that `/swap` returns. It runs out of gas at its last step, `Permit2.transferFrom`. The revert gives no reason, so it doesn't look like a gas problem.

**Setup**
- Chain: Ethereum Sepolia (11155111).
- Swap: exact input, 5 USDC (`0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`) to native ETH. The route is `CLASSIC`, through two v4 pools (USDC → LINK → ETH).
- The wallet has approved USDC to Permit2 but has no Permit2 allowance for the Universal Router yet, so `/quote` returns `permitData`.
- Both `x-universal-router-version` `2.0` and `2.1.2` are affected.

**Steps**
1. `POST /check_approval`, then approve USDC to Permit2.
2. `POST /quote` with `routingPreference: BEST_PRICE` and `slippageTolerance: 0.5`.
3. Sign `permitData` unchanged, then `POST /swap` with the quote, `signature` and `permitData`.
4. Send the returned transaction with its `gasLimit`.

**Expected:** the swap succeeds. **Actual:** it reverts.

**Evidence**

| Router | `/quote` `gasUseEstimate` | `/swap` `gasLimit` | Real need (`eth_estimateGas`) | Practice run (`eth_call`) with `/swap`'s limit |
|---|---|---|---|---|
| 2.0 | 208,576 | 271,148 | 338,807 | Reverts |
| 2.1.2 | 211,153 | 274,498 | 341,525 | Reverts |

- **Failed transaction:** [0xbaaa…e5df](https://sepolia.etherscan.io/tx/0xbaaa998abe17f546e30a841e085516f44bb568fd6689c0dcbcff33ebb7c2e5df), with a gas limit of 271,148. A `cast run` replay shows the permit and both pool swaps succeed, then `Permit2.transferFrom` gets 965 gas and runs out.
- **The retry used more gas than `/swap`'s limit.** We re-sent the same swap with `eth_estimateGas` plus 30%. It succeeded and used 319,579 gas, more than the 271,148 that `/swap` returned: [0x9c4a…0164](https://sepolia.etherscan.io/tx/0x9c4a94aa8dc26f8bfd17b34ceb6f1ef682851251b4974df5fe06dc25bd5c0164).
- **The quote's own limit is also too low.** The `/quote` response's `gasEstimates[0].gasLimit` (311,820 and 315,672) is below the real need too.
- **Our exact-amount permit isn't the cause.** That failed transaction signed an exact-amount permit instead of the default unlimited one. The table uses the untouched `permitData`, and the exact-amount version needs 19 gas less.

**Likely cause (our reading, not confirmed by Uniswap):**
- `/swap`'s `gasLimit` is exactly `gasUseEstimate × 1.3`.
- The gap to the real need, about 130,000 gas, matches what the permit step costs on Sepolia (118,906 in the replay). So the estimate seems to leave out the permit.
- Sepolia also charges a lot for new storage: our plain USDC `approve` used 137,697 gas. That pushes the permit past the 30% margin.
- We haven't tested Mainnet.

**Impact:** small but real.
- On Sepolia, swaps that include a permit, such as a wallet's first swap of a token, can fail for integrations that send the returned `gasLimit`.
- Uniswap's swap-integration guide (`uniswap-ai`) checks data, addresses and value before sending, but not gas.
- No funds are lost, only the gas fee. Hackathon teams test on Sepolia, so they hit this first.

**Suggested fix:** count the permit step in the gas estimate whenever `/swap` adds a permit, or simulate the final calldata. Until then, add one line to the docs: "re-estimate gas before sending".

**Our workaround:** `eth_estimateGas` on the returned transaction, plus 30%.

**Reproduce:** `server/experiments/uniswap-swap.js`. The `gascheck` command is free and sends nothing.

---

## Smaller things we hit

### `GET` vs `POST /check_approval` (docs, 14 Oct, about 08:50)
`developers.uniswap.org/llms-full.txt` lists `GET /check_approval`, while the official `swap-integration` guide in `uniswap-ai` uses `POST`. `POST` works; we didn't try `GET`. **Suggested fix:** make both say `POST`.

### The getting-started page has no endpoint or header (docs, 13 Oct, about 23:45)
"Swapping via the Uniswap API" doesn't give the base address, the API key header or an example request. They're in the Integration Guide: `https://trade-api.gateway.uniswap.org/v1/quote` with `x-api-key`. **Suggested fix:** one example `curl` on the getting-started page. About 3 minutes lost.

### No-Permit2 mode points at the deprecated proxy, with an unlimited approval (API, 14 Oct, 19:27:54)
With `x-permit2-disabled: true`, `/check_approval` returned `approve(0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9, unlimited)`, and the swap targeted `0x02E5…b2a9`. Uniswap's own no-Permit2 docs call that address the deprecated legacy proxy and point integrators to `0x0000000085E102724e78eCd2F45DC9cA239Affad`. **Suggested fix:** return the current proxy, and suggest an exact approval instead of unlimited. We used the normal Permit2 flow instead.

### "A routing dependency timed out or failed" (API, 15 Oct, 22:23)
A Sepolia `/quote` (0.0001 ETH → USDC, `V2`, `V3`, `V4`, 0.5% slippage) failed after 5.3 s with `"A routing dependency timed out or failed; the request may succeed on retry."`; the same request then worked three times in a row in about a second. **Our workaround:** retry once on a server error. **Suggested fix:** say in the docs which status this comes with, so integrators know it's safe to retry.

### Resetting a v2 test pool after a big swap (our own mistake, 30 Oct, about 16:44)
For a replay, we burned and re-minted a copied v2 pool's liquidity after each 50M-unit swap. At the lopsided price, each reset minted about 1,000× fewer shares, until the locked `MINIMUM_LIQUIDITY` alone exceeded the starting reserves and the 6th reset failed with `UniswapV2: INSUFFICIENT_LIQUIDITY_MINTED`. Not a bug: that's how v2 works. **Our fix:** swap the price back before re-minting. A note in the v2 docs about resetting test pools would have saved us 20 minutes.

---

## How to reach us

Pavitara and Mithun, team Verbatim, ETHGlobal Mumbai 2026. The code is in this repository; the swap experiment that reproduces the gas issue is `server/experiments/uniswap-swap.js`.
