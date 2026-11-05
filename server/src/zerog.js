import { AI_MAX_TOKENS, AI_MODEL, AI_TIMEOUT_MS, ZG_PROVIDER, ZG_ROUTER } from './config.js'
import { RequestError } from './uniswap.js'

export function parseJson(content) {
  if (!content) return null
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    return null
  }
}

export async function askSealedModel(messages, schema, name) {
  if (!process.env.ZG_ROUTER_API_KEY) throw new RequestError('The sealed AI is not set up: ZG_ROUTER_API_KEY is missing from .env.', 503)
  const started = performance.now()
  let response
  try {
    response = await fetch(`${ZG_ROUTER}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${process.env.ZG_ROUTER_API_KEY}`,
        'x-0g-provider-trust-mode': 'private',
        'x-0g-provider-address': ZG_PROVIDER,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages,
        max_tokens: AI_MAX_TOKENS,
        temperature: 0,
        verify_tee: true,
        response_format: { type: 'json_schema', json_schema: { name, strict: true, schema } },
      }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    })
  } catch (error) {
    if (error.name === 'TimeoutError') throw new RequestError("The sealed AI couldn't work that out in time, so it didn't guess. Please say it more simply, one step at a time.", 504)
    throw new RequestError("Couldn't reach 0G's Router. Try again.", 502)
  }
  const json = await response.json().catch(() => ({}))
  if (response.status === 402) throw new RequestError('The 0G Router account is out of credit.', 503)
  if (!response.ok) throw new RequestError(`0G's Router refused the request (${response.status}).`, 502)
  const trace = json.x_0g_trace ?? {}
  return {
    content: json.choices?.[0]?.message?.content ?? '',
    chatId: response.headers.get('zg-res-key') ?? json.id,
    provider: trace.provider ?? null,
    model: json.model ?? AI_MODEL,
    latencyMs: Math.round(performance.now() - started),
    costUsdMicro: Number(trace.billing?.total_cost_usd_micro ?? 0),
    tokensOut: json.usage?.completion_tokens ?? null,
  }
}
