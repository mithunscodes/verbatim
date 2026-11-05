import { readFileSync, writeFileSync } from 'node:fs'
import { getAddress } from 'viem'
import { understand } from '../src/understand.js'
import { checkSignature } from '../src/proof.js'
import { describeStep, planFromSteps, sameChecks } from '../../app/src/intent.js'
import { CheckKind } from '../../app/src/checks.js'

const SENTENCES = new URL('../experiments/sealed-ai-sentences.json', import.meta.url)
const RESULTS = new URL('../experiments/understand-results.json', import.meta.url)
const fake = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)

const TOKENS = {
  ETH: { token: fake(0), decimals: 18, price: 3000_000000n, amount: 2n * 10n ** 18n },
  USDC: { token: fake(1), decimals: 6, price: 1_000000n, amount: 5000n * 10n ** 6n },
  DAI: { token: fake(2), decimals: 18, price: 1_000000n, amount: 1000n * 10n ** 18n },
  LINK: { token: fake(3), decimals: 18, price: 15_000000n, amount: 100n * 10n ** 18n },
  AAVE: { token: fake(4), decimals: 18, price: 100_000000n, amount: 10n * 10n ** 18n },
}
const AAVE_RECEIPTS = { USDC: fake(0x11), DAI: fake(0x12) }

function testContext(names) {
  const holdings = Object.entries(TOKENS).map(([symbol, t]) => ({ symbol, token: t.token, decimals: t.decimals, amount: t.amount }))
  const info = (token) => Object.values(TOKENS).find((t) => t.token === token)
  return {
    holdings,
    contacts: names.map((name, i) => ({ name, address: fake(0x100 + i) })),
    fairValue: (from, amount, to) => {
      const a = info(from)
      const b = info(to)
      return (amount * a.price * 10n ** BigInt(b.decimals)) / (b.price * 10n ** BigInt(a.decimals))
    },
    deposits: { aave: AAVE_RECEIPTS },
    slippageBps: 100n,
    shownDigits: 4,
  }
}

function answerKeyStep(step) {
  const [kind, value] = step.amount
  return {
    type: step.type,
    token: step.token,
    toToken: step.to_token ?? undefined,
    to: step.to ?? undefined,
    protocol: step.protocol ?? undefined,
    amount: kind === 'all' ? { kind, value: null } : { kind, value },
  }
}

function emptyResult(steps = []) {
  return { steps, questions: [], riskLimitPercent: null, nothingElse: false }
}

function builderTests(context) {
  const results = []
  const usdc = TOKENS.USDC.token
  const eth = TOKENS.ETH.token
  const mom = context.contacts.find((c) => c.name === 'mom.eth').address
  const c3 = planFromSteps(context, {
    ...emptyResult([
      { type: 'swap', token: 'USDC', toToken: 'ETH', amount: { kind: 'exact', value: '10' } },
      { type: 'send', token: 'USDC', to: 'mom.eth', amount: { kind: 'exact', value: '2' } },
    ]),
    nothingElse: true,
  })
  results.push([
    'C3 by hand: at most 12 USDC leaves, at least 0.003299 ETH arrives (fair 0.00333…, minus 1%, 4 digits), exactly 2 USDC to mom.eth',
    sameChecks(c3.checks, [
      { kind: CheckKind.AtMostLeaves, token: usdc, to: fake(0), amount: 12_000000n },
      { kind: CheckKind.AtLeastArrives, token: eth, to: fake(0), amount: 3299000000000000n },
      { kind: CheckKind.ExactlyTo, token: usdc, to: mom, amount: 2_000000n },
    ]),
  ])
  const m8 = planFromSteps(context, emptyResult([
    { type: 'deposit', token: 'USDC', protocol: 'aave', amount: { kind: 'fraction_of_balance', value: '0.5' } },
    { type: 'swap', token: 'USDC', toToken: 'ETH', amount: { kind: 'exact', value: '1000' } },
    { type: 'send', token: 'USDC', to: 'mom.eth', amount: { kind: 'exact', value: '100' } },
  ]))
  results.push([
    'M8 by hand: at most 3,600 USDC leaves (2,500 + 1,000 + 100), at least 2,497.5 aUSDC and 0.3299 ETH arrive, exactly 100 USDC to mom.eth',
    sameChecks(m8.checks, [
      { kind: CheckKind.AtMostLeaves, token: usdc, to: fake(0), amount: 3600_000000n },
      { kind: CheckKind.AtLeastArrives, token: AAVE_RECEIPTS.USDC, to: fake(0), amount: 2497_500000n },
      { kind: CheckKind.AtLeastArrives, token: eth, to: fake(0), amount: 329900000000000000n },
      { kind: CheckKind.ExactlyTo, token: usdc, to: mom, amount: 100_000000n },
    ]),
  ])
  const netted = planFromSteps(context, emptyResult([
    { type: 'swap', token: 'DAI', toToken: 'USDC', amount: { kind: 'exact', value: '50' } },
    { type: 'send', token: 'USDC', to: 'mom.eth', amount: { kind: 'exact', value: '10' } },
  ]))
  results.push([
    'A token that leaves and comes back is netted: 49.5 USDC back minus 10 sent → at least 39.5 USDC arrives',
    netted.checks.some((c) => c.kind === CheckKind.AtLeastArrives && c.token === usdc && c.amount === 39_500000n)
      && !netted.checks.some((c) => c.kind === CheckKind.AtMostLeaves && c.token === usdc),
  ])
  const unknown = planFromSteps(context, emptyResult([{ type: 'send', token: 'USDC', to: 'john.eth', amount: { kind: 'exact', value: '5' } }]))
  results.push(['A name that isn\'t a contact gives a problem, not a check', unknown.checks.length === 0 && unknown.problems.length === 1])
  const tooFine = planFromSteps(context, emptyResult([{ type: 'send', token: 'USDC', to: 'mom.eth', amount: { kind: 'exact', value: '0.0000001' } }]))
  results.push(['More decimals than the token allows gives a problem, not a rounded check', tooFine.checks.length === 0 && tooFine.problems.length === 1])
  return results
}

function mark(sentence, response, context) {
  const { result } = response
  const { expect } = sentence
  if (!response.proof.verified) return { correct: false, reason: `sealed-hardware proof failed: ${response.proof.problem}` }
  const plan = planFromSteps(context, result)
  if (plan.problems.length) return { correct: false, reason: `the checks couldn't be built: ${plan.problems.join(' ')}` }
  if (expect.ask) {
    if (!result.questions.length) return { correct: false, reason: 'did not ask back' }
    const allowed = planFromSteps(context, emptyResult((expect.allowed ?? []).map(answerKeyStep)))
    const subset = plan.checks.every((check) => sameChecks([check], allowed.checks.filter((c) => c.kind === check.kind && c.token === check.token && c.to === check.to)))
    if (!subset) return { correct: false, reason: `asked, but also made checks it shouldn't: ${result.steps.map(describeStep).join('; ')}` }
    return { correct: true, reason: `asked: ${result.questions.join(' | ')}` }
  }
  if (result.questions.length) return { correct: false, reason: `asked when it shouldn't: ${result.questions.join(' | ')}` }
  const expected = planFromSteps(context, emptyResult(expect.steps.map(answerKeyStep)))
  if (!sameChecks(plan.checks, expected.checks)) return { correct: false, reason: `different checks from: ${result.steps.map(describeStep).join('; ')}` }
  if ((expect.riskLimit ?? null) !== result.riskLimitPercent) return { correct: false, reason: `risk limit ${result.riskLimitPercent}, expected ${expect.riskLimit ?? null}` }
  if (expect.nothingElse && !result.nothingElse) return { correct: false, reason: 'missed "nothing else"' }
  return { correct: true, reason: `${plan.checks.length} checks from: ${result.steps.map(describeStep).join('; ')}` }
}

async function main() {
  const data = JSON.parse(readFileSync(SENTENCES, 'utf8'))
  const context = testContext(data.addressBook)
  console.log('The check builder, without AI')
  for (const [name, ok] of builderTests(context)) console.log(`${ok ? '✓' : '✗'} ${name}`)

  const only = process.argv.slice(2)
  const sentences = data.sentences.filter((s) => !only.length || only.includes(s.id) || only.includes(s.set))
  console.log(`\n${sentences.length} sentences through the sealed AI (glm-5.3), the server's checks and the check builder`)
  const rows = []
  for (const sentence of sentences) {
    let response
    try {
      response = await understand({ sentence: sentence.text, names: data.addressBook, tokens: data.tokens, protocols: data.protocols })
    } catch (error) {
      rows.push({ id: sentence.id, set: sentence.set, correct: false, reason: `call failed: ${error.message}` })
      console.log(`✗ ${sentence.id} call failed: ${error.message}`)
      continue
    }
    const marked = mark(sentence, response, context)
    rows.push({ id: sentence.id, set: sentence.set, ...marked, latencyMs: response.latencyMs, costUsdMicro: response.costUsdMicro, result: response.result, proof: response.proof })
    console.log(`${marked.correct ? '✓' : '✗'} ${sentence.id} ${(response.latencyMs / 1000).toFixed(1)} s, sealed ✓: ${marked.reason}`)
  }

  const score = (set) => {
    const subset = rows.filter((r) => !set || r.set === set)
    return `${subset.filter((r) => r.correct).length}/${subset.length}`
  }
  const unclear = sentences.filter((s) => s.expect.ask).map((s) => s.id)
  const asked = rows.filter((r) => r.result?.questions.length).map((r) => r.id)
  console.log(`\nScore: ${score()} (clean ${score('clean')}, messy ${score('messy')})`)
  console.log(`Asking back: ${unclear.filter((id) => asked.includes(id)).length}/${unclear.length} unclear sentences got a question, ${asked.filter((id) => !unclear.includes(id)).length} clear ones did`)
  const proved = rows.filter((r) => r.proof?.verified).length
  console.log(`Sealed-hardware proof: ${proved}/${rows.length} answers signed by the signer registered on 0G's chain`)
  const timed = rows.filter((r) => r.latencyMs)
  console.log(`Time: average ${(timed.reduce((s, r) => s + r.latencyMs, 0) / Math.max(timed.length, 1) / 1000).toFixed(1)} s, slowest ${(Math.max(0, ...timed.map((r) => r.latencyMs)) / 1000).toFixed(1)} s`)
  console.log(`Cost: $${(rows.reduce((s, r) => s + (r.costUsdMicro ?? 0), 0) / 1e6).toFixed(4)}`)

  const sample = rows.find((r) => r.proof?.verified)
  if (sample) {
    const wrongKey = await checkSignature({ text: sample.proof.signedText, signature: sample.proof.signature }, '0x745720517Fa4a03a17a5C3525B4060f7a41b46ED')
    console.log(`${wrongKey.valid ? '✗' : '✓'} Checked against another provider's registered signer, the same signature fails`)
    const text = sample.proof.signedText
    const changed = `${text.slice(0, -1)}${text.endsWith('0') ? '1' : '0'}`
    const tampered = await checkSignature({ text: changed, signature: sample.proof.signature }, sample.proof.registeredSigner)
    console.log(`${tampered.valid ? '✗' : '✓'} With one character of the signed text changed, the signature fails`)
  }
  writeFileSync(RESULTS, JSON.stringify({ ranAt: new Date().toISOString(), rows }, null, 2))
}

main().catch((error) => {
  console.error(String(error.stack ?? error).split(process.env.ZG_ROUTER_API_KEY ?? '\u0000').join('[hidden]'))
  process.exit(1)
})
