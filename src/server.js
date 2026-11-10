/**
 * HTTP host for DeepSeek Harness composer suggestions.
 *
 * Plugin hosts normally register on ctx.webServer inside the dsh process.
 * This process is the host instead: it listens on its own port and answers
 * from the caller's current input. It does not install a terminal or editor plugin.
 */

import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { completeWithDeepseek } from './deepseek.js'
import {
  SuggestionError,
  buildSuggestions,
  parseSuggestBody,
} from './suggest.js'

const BODY_LIMIT = 32 * 1024

export function createApp(env = process.env, deps = {}) {
  const apiKey = String(env.DEEPSEEK_API_KEY ?? '').trim()
  const model = String(env.DEEPSEEK_MODEL ?? 'deepseek-flash').trim() || 'deepseek-flash'
  const apiBase = String(env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com').trim()
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const timeoutMs = deps.timeoutMs ?? 8000

  return createServer((req, res) => {
    handle(req, res, { apiKey, model, apiBase, fetchImpl, timeoutMs }).catch((err) => {
      if (res.writableEnded || res.destroyed) return
      const status = err instanceof SuggestionError ? err.status : 500
      writeJson(res, status, { error: status === 500 ? 'internal error' : err.message })
      if (status === 413) res.on('finish', () => req.destroy())
    })
  })
}

export function start(env = process.env, deps = {}) {
  const host = env.HOST || '127.0.0.1'
  const port = env.PORT === undefined || env.PORT === '' ? 8787 : Number(env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer from 0 to 65535')
  }
  const server = createApp(env, deps)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve(server)
    })
  })
}

async function handle(req, res, deps) {
  res.on('error', () => {})
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders())
    res.end()
    return
  }

  const pathname = pathnameOf(req)
  if (req.method === 'GET' && pathname === '/') {
    writeJson(res, 200, {
      service: 'dsh-prompt-suggestions',
      role: 'host',
      description: 'Predicts the next DeepSeek Harness composer prompt from the current input.',
      endpoints: {
        health: 'GET /health',
        suggestions: 'POST /v1/suggestions',
      },
    })
    return
  }
  if (pathname === '/health') {
    if (req.method !== 'GET') {
      writeJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
      return
    }
    writeJson(res, 200, {
      ok: true,
      service: 'dsh-prompt-suggestions',
      role: 'host',
      predictor: deps.apiKey ? deps.model : 'fallback',
    })
    return
  }
  if (pathname === '/v1/suggestions') {
    if (req.method !== 'POST') {
      writeJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      return
    }
    const raw = await readBody(req)
    if (!raw.length) throw new SuggestionError('request body is required')
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw new SuggestionError('request body must be JSON')
    }
    const parsed = parseSuggestBody(body)
    const result = await buildSuggestions(parsed, {
      apiKey: deps.apiKey,
      model: deps.model,
      complete: (current) => completeWithDeepseek(current, {
        apiKey: deps.apiKey,
        model: deps.model,
        apiBase: deps.apiBase,
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs,
      }),
    })
    if (result.modelError) console.error(`dsh-prompt-suggestions: ${result.modelError}`)
    writeJson(res, 200, result)
    return
  }

  writeJson(res, 404, { error: 'not found' })
}

function pathnameOf(req) {
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    throw new SuggestionError('bad request path')
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let failed = false
    req.on('data', (chunk) => {
      if (failed) return
      size += chunk.length
      if (size > BODY_LIMIT) {
        failed = true
        req.pause()
        reject(new SuggestionError('request body is too large', 413))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', (err) => {
      if (!failed) reject(err)
    })
  })
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
  }
}

function writeJson(res, status, body, extra = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    ...corsHeaders(),
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function isDirectRun() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(path.resolve(entry)).href
}

if (isDirectRun()) {
  start().then((server) => {
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : ''
    const host = process.env.HOST || '127.0.0.1'
    console.log(`dsh-prompt-suggestions host listening on http://${host}:${port}`)
  }).catch((err) => {
    console.error(err.message || err)
    process.exit(1)
  })
}
