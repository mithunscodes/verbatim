import { SCRIPTED_SENTENCES } from '../src/config.js'
import { understand } from '../src/understand.js'

const DEMO_SET = { names: ['Builder'], tokens: ['USDC'], sentences: [SCRIPTED_SENTENCES[2], SCRIPTED_SENTENCES[3]] }

function option(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : process.argv[index + 1]
}

function chosenSet() {
  const sentence = option('sentence')
  if (!sentence) return DEMO_SET
  const list = (text) => (text ? text.split(',').map((item) => item.trim()).filter(Boolean) : [])
  return { names: list(option('names')), tokens: list(option('tokens') ?? 'USDC,ETH'), sentences: [sentence] }
}

async function ask(set, sentence) {
  return understand({ sentence, names: set.names, tokens: set.tokens, protocols: [], turns: [] })
}

async function record(set) {
  process.env.VERBATIM_RECORDED_AI = 'off'
  for (const sentence of set.sentences) {
    const answer = await ask(set, sentence)
    const what = answer.result.steps.length ? `${answer.result.steps.length} step(s)` : `a question: "${answer.result.questions[0] ?? ''}"`
    console.log(`Recorded "${sentence}" (saved names: ${set.names.join(', ') || 'none'}; tokens: ${set.tokens.join(', ')}): ${what}, sealed ${answer.proof.verified ? '✓' : '✗'}, ${(answer.latencyMs / 1000).toFixed(1)} s live`)
  }
}

async function check(set) {
  process.env.VERBATIM_RECORDED_AI = 'first'
  let failures = 0
  for (const sentence of set.sentences) {
    const started = Date.now()
    const answer = await ask(set, sentence)
    const ok = Boolean(answer.recorded) && Date.now() - started < 1000
    if (!ok) failures++
    console.log(`${ok ? '✓' : '✗'} Stage mode, "${sentence}": ${answer.recorded ? `recorded answer from ${answer.recorded.at}, labelled` : 'no recording, it went live'}, in ${Date.now() - started} ms`)
  }
  console.log(failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`)
  if (failures) process.exitCode = 1
}

const command = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'record'
const commands = { record, check }
if (!commands[command]) {
  console.log('Usage: node --env-file=../.env scripts/record-answers.js record | check [--sentence "…" --names a,b --tokens USDC,ETH]')
  process.exit(1)
}
commands[command](chosenSet()).catch((error) => {
  console.error(error.message)
  process.exit(1)
})
