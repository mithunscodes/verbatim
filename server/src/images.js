import { randomUUID } from 'node:crypto'
import {
  GALILEO_EXPLORER,
  IMAGE_KEEP_MS,
  IMAGE_MAX_ACTIVE,
  IMAGE_MODEL,
  IMAGE_POLL_MS,
  IMAGE_SIZE,
  IMAGE_TIMEOUT_MS,
  MAX_IMAGE_BYTES,
  MAX_UPLOAD_BYTES,
  ZG_ROUTER,
} from './config.js'
import { saveBytes } from './receipts.js'
import { RequestError } from './uniswap.js'

const PNG = [0x89, 0x50, 0x4e, 0x47]
const JPEG = [0xff, 0xd8, 0xff]
const UPLOAD = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/
const jobs = new Map()

const clock = () => new Date().toLocaleTimeString('en-GB')

function readPrompt(body) {
  const prompt = typeof body?.prompt === 'string' ? body.prompt.trim().replace(/\s+/g, ' ') : ''
  if (prompt.length < 3) throw new RequestError('Describe the picture in a few words.')
  if (prompt.length > 300) throw new RequestError('Keep the description under 300 characters.')
  return prompt
}

async function router(path, session, deadline, body) {
  const response = await fetch(`${ZG_ROUTER}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session ?? process.env.ZG_ROUTER_API_KEY}` },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
  }).catch((error) => {
    throw new Error(error.name === 'TimeoutError' ? "0G's image model took over 4 minutes. Try again." : "Couldn't reach 0G's image model. Check the internet connection.")
  })
  const json = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 402) throw new Error(session ? 'Your 0G account is out of credits.' : "Verbatim's 0G account is out of credits.")
    if (response.status === 429) throw new Error("0G's image model is busy. Try again in a minute.")
    throw new Error(`0G's image model said: ${json.error?.message ?? `error ${response.status}`}`)
  }
  return { json, response }
}

function pictureIn(json) {
  const images = Array.isArray(json.data) ? json.data : json.data?.data
  const base64 = images?.[0]?.b64_json
  const bytes = base64 ? Buffer.from(base64, 'base64') : null
  const type = !bytes ? null : PNG.every((byte, i) => bytes[i] === byte) ? 'png' : JPEG.every((byte, i) => bytes[i] === byte) ? 'jpeg' : null
  return type ? { base64, bytes, type } : null
}

async function draw(prompt, session, note) {
  if (!session && !process.env.ZG_ROUTER_API_KEY) throw new Error('The 0G image model is not set up: ZG_ROUTER_API_KEY is missing from .env.')
  const deadline = Date.now() + IMAGE_TIMEOUT_MS
  const submitted = await router('/async/images/generations', session, deadline, {
    model: IMAGE_MODEL,
    prompt,
    n: 1,
    size: IMAGE_SIZE,
    response_format: 'b64_json',
  })
  const jobId = submitted.json.jobId ?? submitted.json.job_id
  const provider = submitted.json.provider_address
  if (jobId) note(`0G job ${jobId} on provider ${provider}`)
  let reply = submitted
  let picture = pictureIn(reply.json)
  while (!picture && jobId && !['failed', 'error'].includes(reply.json.status)) {
    await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_MS))
    reply = await router(`/async/jobs/${encodeURIComponent(jobId)}?provider_address=${encodeURIComponent(provider ?? '')}`, session, deadline)
    picture = pictureIn(reply.json)
  }
  const { json, response } = reply
  if (!picture) {
    note(`no picture from 0G: status ${json.status ?? 'none'}, fields ${Object.keys(json).join(', ')}`)
    throw new Error(json.error?.message ? `0G's image model said: ${json.error.message}` : "0G's image model didn't send back a picture.")
  }
  if (picture.bytes.length > MAX_IMAGE_BYTES) throw new Error('The picture is too big to store.')
  return {
    ...picture,
    provider: json.x_0g_trace?.provider ?? provider ?? response.headers.get('x-provider'),
    requestId: json.x_0g_trace?.request_id ?? jobId ?? response.headers.get('zg-res-key'),
    costUsd: Number(json.x_0g_trace?.billing?.total_cost_usd_micro ?? 0) / 1e6,
  }
}

async function work(job, prompt, session, hide) {
  const note = (text) => console.log(hide(`${clock()} image: ${text}`))
  const started = Date.now()
  try {
    job.status = 'drawing'
    const picture = await draw(prompt, session, note)
    note(`drawn by ${IMAGE_MODEL} in ${((Date.now() - started) / 1000).toFixed(1)} s, ${picture.bytes.length} bytes`)
    job.status = 'storing'
    const stored = await saveBytes(picture.bytes)
    note(`saved on 0G Storage: ${stored.root}`)
    job.result = {
      source: 'drawn',
      prompt,
      model: IMAGE_MODEL,
      image: `data:image/${picture.type};base64,${picture.base64}`,
      bytes: picture.bytes.length,
      provider: picture.provider,
      requestId: picture.requestId,
      costUsd: picture.costUsd,
      paidBy: session ? 'you' : 'team',
      root: stored.root,
      storageTx: stored.txHash,
      storage: stored.explorer,
      storageExplorer: GALILEO_EXPLORER,
      ms: Date.now() - started,
    }
    job.status = 'done'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof RequestError || error.constructor === Error ? error.message : 'Making the picture failed. The server log has the details.'
    console.error(hide(`${clock()} image: ${error.stack ?? error}`))
  } finally {
    job.finished = Date.now()
  }
}

function readUpload(body) {
  const match = typeof body?.image === 'string' ? body.image.match(UPLOAD) : null
  if (!match) throw new RequestError('Choose a PNG or JPEG picture.')
  const bytes = Buffer.from(match[2], 'base64')
  const magic = match[1] === 'png' ? PNG : JPEG
  if (!magic.every((byte, i) => bytes[i] === byte)) throw new RequestError("That file isn't the picture it says it is.")
  if (bytes.length > MAX_UPLOAD_BYTES) throw new RequestError('The picture is over 1 MB. Try a smaller one.', 413)
  return { bytes, image: body.image }
}

async function store(job, upload, hide) {
  const started = Date.now()
  try {
    job.status = 'storing'
    const stored = await saveBytes(upload.bytes)
    console.log(hide(`${clock()} upload: your picture saved on 0G Storage: ${stored.root}, ${upload.bytes.length} bytes`))
    job.result = {
      source: 'upload',
      image: upload.image,
      bytes: upload.bytes.length,
      root: stored.root,
      storageTx: stored.txHash,
      storage: stored.explorer,
      storageExplorer: GALILEO_EXPLORER,
      ms: Date.now() - started,
    }
    job.status = 'done'
  } catch (error) {
    job.status = 'failed'
    job.error = error instanceof RequestError || error.constructor === Error ? error.message : 'Saving the picture failed. The server log has the details.'
    console.error(hide(`${clock()} upload: ${error.stack ?? error}`))
  } finally {
    job.finished = Date.now()
  }
}

function view(job) {
  return { id: job.id, status: job.status, result: job.result, error: job.error }
}

function newJob() {
  const now = Date.now()
  for (const [id, job] of jobs) {
    if (job.finished && now - job.finished > IMAGE_KEEP_MS) jobs.delete(id)
  }
  const active = [...jobs.values()].filter((job) => !job.finished).length
  if (active >= IMAGE_MAX_ACTIVE) throw new RequestError('Two pictures are already on their way. Try again in a minute.', 429)
  const job = { id: randomUUID(), status: 'waiting' }
  jobs.set(job.id, job)
  return job
}

export function startImage(body, { session = null, hide = String } = {}) {
  const prompt = readPrompt(body)
  const job = newJob()
  work(job, prompt, session, hide)
  return view(job)
}

export function startUpload(body, { hide = String } = {}) {
  const upload = readUpload(body)
  const job = newJob()
  store(job, upload, hide)
  return view(job)
}

export function imageStatus(id) {
  const job = jobs.get(id)
  if (!job) throw new RequestError('This picture has expired. Make it again.', 404)
  return view(job)
}
