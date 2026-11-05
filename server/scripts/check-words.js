import { createPublicClient, decodeFunctionData, getAddress, http } from 'viem'
import { sepolia } from 'viem/chains'
import { checkAnswer } from '../src/understand.js'
import { planFromSteps } from '../../app/src/intent.js'
import { CheckKind } from '../../app/src/checks.js'
import { vaultAbi } from '../../app/src/config.js'
import { explainRefusal, layoutWords, marksFor, saidFor } from '../../app/src/words.js'
import { checksOnChain } from '../../app/src/onchain.js'

const SUCCESS_RUN = '0x7181f01917ebcefe86d49c0df8181f2ef0f5b935a86a87fb80ca363f1d508cb1'
const REFUSED_RUN = '0x7e9545a6053c581cd252042ba27f58c7a826a56d06e8fd15165cec94cb46fdc5'

const fake = (n) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)
const USDC = fake(1)
const ETH = fake(0)
const MOM = fake(0x100)
const results = []

function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n    got: ${detail}` : ''}`)
}

function ask(sentence, answers = []) {
  return { sentence, names: ['mom.eth', 'dad.eth'], tokens: ['USDC', 'ETH'], protocols: [], turns: answers.map((answer) => ({ answer, previous: {} })) }
}

function output(steps, extra = {}) {
  return { steps, risk_limit_percent: null, risk_limit_words: null, nothing_else: false, nothing_else_words: null, left_out: [], questions: [], ...extra }
}

const send = (words, amount = '2', to = 'mom.eth') => ({ words, type: 'send', token: 'USDC', to_token: null, amount: { kind: 'exact', value: amount }, to, protocol: null })
const swap = (words, amount = '10') => ({ words, type: 'swap', token: 'USDC', to_token: 'ETH', amount: { kind: 'exact', value: amount }, to: null, protocol: null })

function tracing() {
  console.log('Tracing words on the server, without AI')
  const hero = 'Swap 10 USDC for ETH at a fair price, send 2 USDC to mom.eth, and nothing else.'
  const traced = checkAnswer(output([swap(['swap 10 usdc for eth at a fair price']), send(['send 2 USDC to mom.eth'])], { nothing_else: true, nothing_else_words: 'and nothing else.' }), ask(hero))
  check('Words are found whatever the case, and kept exactly as the user typed them', traced.steps[0].words[0] === 'Swap 10 USDC for ETH at a fair price', JSON.stringify(traced.steps[0].words))
  check('Trailing punctuation and quotes are ignored when matching', traced.nothingElseWords === 'and nothing else', traced.nothingElseWords)
  check('A clean answer has no questions and nothing left out', traced.questions.length === 0 && traced.leftOut.length === 0, JSON.stringify(traced))

  const spaced = checkAnswer(output([send(['send  2   USDC to mom.eth'])]), ask('please send 2 USDC\nto mom.eth'))
  check('Extra spaces and line breaks still match', spaced.steps[0]?.words[0] === 'send 2 USDC\nto mom.eth', JSON.stringify(spaced.steps[0]?.words))

  const corrected = checkAnswer(output([send(['send 20 USDC to mom.eth'], '20')]), ask('snd 20 usdc 2 mom.eth pls'))
  check('Words the AI "corrected" are refused: the step is left out with a question', corrected.steps.length === 0 && corrected.questions.length === 1, JSON.stringify(corrected))

  const invented = checkAnswer(output([send(['send 2 USDC to mom.eth']), send(['and 5 USDC to dad.eth'], '5', 'dad.eth')]), ask('send 2 USDC to mom.eth'))
  check('A step whose words the user never wrote is left out', invented.steps.length === 1 && invented.questions.length === 1, JSON.stringify(invented))

  const empty = checkAnswer(output([{ ...send([]) }]), ask('send 2 USDC to mom.eth'))
  check('A step with no words at all is left out', empty.steps.length === 0 && empty.questions.length === 1, JSON.stringify(empty))

  const split = checkAnswer(output([send(['send', '2 USDC to mom.eth'], '2')]), ask('send, if you can, 2 USDC to mom.eth'))
  check('Words split into pieces are all traced', split.steps[0]?.words.length === 2, JSON.stringify(split))

  const answered = checkAnswer(output([send(['send 100 usdc', 'mom.eth'], '100')]), ask('send 100 usdc to mom', ['yes, mom.eth']))
  check('Words can come from the answer to a question', answered.steps.length === 1 && answered.steps[0].words[1] === 'mom.eth', JSON.stringify(answered))

  const risk = checkAnswer(output([swap(['swap 10 USDC for ETH'])], { risk_limit_percent: 5, risk_limit_words: 'up to 5% slippage' }), ask('swap 10 USDC for ETH'))
  check('A price-impact limit without the user\'s words is dropped, with a question', risk.riskLimitPercent === null && risk.questions.length === 1, JSON.stringify(risk))

  const riskOk = checkAnswer(output([swap(['swap 10 USDC for ETH'])], { risk_limit_percent: 5, risk_limit_words: 'accepting up to 5% price impact' }), ask('swap 10 USDC for ETH, accepting up to 5% price impact'))
  check('A price-impact limit with the user\'s words is kept', riskOk.riskLimitPercent === 5 && riskOk.riskLimitWords === 'accepting up to 5% price impact', JSON.stringify(riskOk))

  const wrongAmount = checkAnswer(output([send(['send 2 USDC to mom.eth'], '20')]), ask('send 2 USDC to mom.eth'))
  check('A step whose amount isn\'t in its words is left out, with a question naming the amount', wrongAmount.steps.length === 0 && wrongAmount.questions[0]?.includes('20 USDC'), JSON.stringify(wrongAmount))

  const wrongName = checkAnswer(output([send(['send 2 USDC to mom.eth'], '2', 'dad.eth')]), ask('send 2 USDC to mom.eth'))
  check('A send whose receiver isn\'t in its words is left out, with a question naming them', wrongName.steps.length === 0 && wrongName.questions[0]?.includes('dad.eth'), JSON.stringify(wrongName))

  const wordNumber = checkAnswer(output([send(['send two usdc to mom'], '2')]), ask('send two usdc to mom'))
  check('Amounts written as words and short names still match ("two", "mom")', wordNumber.steps.length === 1, JSON.stringify(wordNumber))

  const bigNumber = checkAnswer(output([send(['send 1,500 USDC to mom.eth'], '1500')]), ask('send 1,500 USDC to mom.eth'))
  check('Thousands with a comma match', bigNumber.steps.length === 1, JSON.stringify(bigNumber))

  const half = checkAnswer(output([{ ...swap(['swap half my USDC for ETH']), amount: { kind: 'fraction_of_balance', value: '0.5' } }]), ask('swap half my USDC for ETH'))
  const tooMuch = checkAnswer(output([{ ...swap(['swap half my USDC for ETH']), amount: { kind: 'fraction_of_balance', value: '0.9' } }]), ask('swap half my USDC for ETH'))
  check('A share must match its words: "half" is 50%, not 90%', half.steps.length === 1 && tooMuch.steps.length === 0, JSON.stringify([half.steps.length, tooMuch.questions]))

  const all = checkAnswer(output([send(['send all my USDC to mom.eth'], null)].map((step) => ({ ...step, amount: { kind: 'all', value: null } }))), ask('send all my USDC to mom.eth'))
  const notAll = checkAnswer(output([send(['send 2 USDC to mom.eth'], null)].map((step) => ({ ...step, amount: { kind: 'all', value: null } }))), ask('send 2 USDC to mom.eth'))
  check('"All" must be in the words to send everything', all.steps.length === 1 && notAll.steps.length === 0, JSON.stringify([all.steps.length, notAll.questions]))

  const left = checkAnswer(output([swap(['swap 10 USDC for ETH'])], { left_out: ['only if ETH is under 3,000', 'something I never said'], questions: ['I can\'t check a condition. Drop it?'] }), ask('swap 10 USDC for ETH only if ETH is under 3,000'))
  check('Left-out words are traced, and invented ones are dropped', left.leftOut.length === 1 && left.leftOut[0] === 'only if ETH is under 3,000', JSON.stringify(left.leftOut))
}

function context() {
  return {
    holdings: [
      { symbol: 'ETH', token: ETH, decimals: 18, amount: 2n * 10n ** 18n },
      { symbol: 'USDC', token: USDC, decimals: 6, amount: 5000n * 10n ** 6n },
    ],
    contacts: [{ name: 'mom.eth', address: MOM }],
    fairValue: (from, amount) => (from === USDC ? (amount * 10n ** 18n) / 3000_000000n : null),
    deposits: {},
    slippageBps: 100n,
    shownDigits: 4,
  }
}

const heroResult = {
  steps: [
    { type: 'swap', token: 'USDC', toToken: 'ETH', amount: { kind: 'exact', value: '10' }, words: ['Swap 10 USDC for ETH at a fair price'] },
    { type: 'send', token: 'USDC', to: 'mom.eth', amount: { kind: 'exact', value: '2' }, words: ['send 2 USDC to mom.eth'] },
  ],
  questions: [],
  riskLimitPercent: null,
  riskLimitWords: null,
  nothingElse: true,
  nothingElseWords: 'and nothing else',
  leftOut: [],
}

function origins() {
  console.log('\nWhich words each check comes from')
  const plan = planFromSteps(context(), heroResult)
  const kinds = plan.checks.map((c) => c.kind)
  check('The hero sentence gives 3 checks: at most, at least, exactly', JSON.stringify(kinds) === JSON.stringify([CheckKind.AtMostLeaves, CheckKind.AtLeastArrives, CheckKind.ExactlyTo]), JSON.stringify(kinds))
  check('"At most 12 USDC leaves" comes from both the swap and the send', JSON.stringify(plan.origins[0]) === '[0,1]', JSON.stringify(plan.origins))
  check('"At least … ETH arrives" comes from the swap only', JSON.stringify(plan.origins[1]) === '[0]', JSON.stringify(plan.origins))
  check('"Exactly 2 USDC to mom.eth" comes from the send only', JSON.stringify(plan.origins[2]) === '[1]', JSON.stringify(plan.origins))
  check('Every check has an origin', plan.origins.length === plan.checks.length && plan.origins.every((o) => o.length > 0))
  const said = saidFor(heroResult, plan.origins)
  check('The words for check 1 are both phrases, in order', JSON.stringify(said.perCheck[0]) === JSON.stringify(['Swap 10 USDC for ETH at a fair price', 'send 2 USDC to mom.eth']), JSON.stringify(said.perCheck[0]))
  return { plan, said }
}

function refusals({ plan, said }) {
  console.log('\nRefusals quote the user\'s words')
  const vault = {
    holdings: context().holdings,
    contacts: [{ address: MOM, nickname: 'mom.eth' }],
    names: { [MOM]: 'mom.eth' },
  }
  const exact = explainRefusal({ checkNumber: 3, actual: 3_000000n }, vault, plan.checks, said)
  check('Exactly-to', exact === 'You said “send 2 USDC to mom.eth”. Exactly 2 USDC goes to mom.eth, but 3 USDC would arrive.', exact)
  const most = explainRefusal({ checkNumber: 1, actual: 13_000000n }, vault, plan.checks, said)
  check('At-most, with two phrases', most === 'You said “Swap 10 USDC for ETH at a fair price” and “send 2 USDC to mom.eth”. At most 12 USDC leaves your vault, but 13 USDC would leave.', most)
  const other = explainRefusal({ reason: 'Something else would leave your account' }, vault, plan.checks, said)
  check('"Nothing else"', other === 'You said “and nothing else”. Something else would leave your account.', other)
  const unfair = explainRefusal({ reason: 'Unfair trade' }, vault, plan.checks, said)
  check('Unfair trade quotes the swap', unfair === 'You said “Swap 10 USDC for ETH at a fair price”. Unfair trade. The swap would get less than the fair price, minus your margin.', unfair)
  const plain = explainRefusal({ checkNumber: 3, actual: 3_000000n }, vault, plan.checks, null)
  check('Without words (the form), the plain wording stays', plain === 'Exactly 2 USDC goes to mom.eth, but 3 USDC would arrive', plain)
  const limit = explainRefusal({ reason: 'Over the daily limit' }, vault, plan.checks, said)
  check('Other refusals are unchanged', limit === 'Over the daily limit', limit)
}

function highlighting() {
  console.log('\nHighlighting the sentence')
  const sentence = 'Swap 10 USDC for ETH at a fair price, send 2 USDC to mom.eth, and nothing else.'
  const { segments, elsewhere } = layoutWords(sentence, marksFor(heroResult))
  check('The pieces put back together give the exact sentence', segments.map((s) => s.text).join('') === sentence)
  check('All 3 phrases are marked, none elsewhere', segments.filter((s) => s.mark).length === 3 && elsewhere.length === 0, JSON.stringify(segments))
  const twice = layoutWords('send 5 USDC to mom.eth and send 5 USDC to mom.eth', [
    { text: 'send 5 USDC to mom.eth', kind: 'step', label: '1' },
    { text: 'send 5 USDC to mom.eth', kind: 'step', label: '2' },
  ])
  check('The same words twice mark two different places', twice.segments.filter((s) => s.mark).length === 2)
  const answer = layoutWords('send 100 usdc to mom', [{ text: 'mom.eth', kind: 'step', label: '1' }])
  check('Words from an answer are listed separately', answer.elsewhere.length === 1 && answer.segments.length === 1)
}

async function onChain() {
  console.log('\nThe receipt check against Sepolia (free reads)')
  if (!process.env.SEPOLIA_RPC_URL) {
    check('SEPOLIA_RPC_URL is set', false, 'missing from .env')
    return
  }
  const reader = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) })
  for (const [hash, expected] of [[SUCCESS_RUN, 'enforced'], [REFUSED_RUN, 'refused']]) {
    const tx = await reader.getTransaction({ hash })
    const { args } = decodeFunctionData({ abi: vaultAbi, data: tx.input })
    const checks = args[1].map((c) => ({ ...c, amount: c.amount.toString() }))
    const found = await checksOnChain(reader, { vault: tx.to, hash, checks })
    check(`${expected === 'enforced' ? 'A run that went through' : 'A run the vault refused'}: "${expected}", and the checks match`, found.status === expected && found.matches, JSON.stringify({ status: found.status, matches: found.matches }))
    const changed = checks.map((c, i) => (i === 0 ? { ...c, amount: (BigInt(c.amount) + 1n).toString() } : c))
    const off = await checksOnChain(reader, { vault: tx.to, hash, checks: changed })
    check('  The same run with one amount changed by 1 is caught', off.matches === false)
    const fewer = await checksOnChain(reader, { vault: tx.to, hash, checks: checks.slice(1) })
    check('  The same run with a check missing is caught', fewer.matches === false)
    const elsewhere = await checksOnChain(reader, { vault: MOM, hash, checks })
    check('  The wrong vault is caught', elsewhere.status === 'other')
  }
}

async function main() {
  tracing()
  const planned = origins()
  refusals(planned)
  highlighting()
  await onChain()
  const failed = results.filter((ok) => !ok).length
  console.log(failed === 0 ? `\nAll ${results.length} checks passed.` : `\n${failed} of ${results.length} checks failed.`)
  if (failed) process.exitCode = 1
}

main().catch((error) => {
  console.error(String(error.stack ?? error).split(process.env.SEPOLIA_RPC_URL ?? '\u0000').join('[hidden]'))
  process.exit(1)
})
