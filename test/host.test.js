import assert from 'node:assert/strict'
import test from 'node:test'
import { completeWithDeepseek, suggestionsFromContent } from '../src/deepseek.js'
import { createApp } from '../src/server.js'
import {
  buildSuggestions,
  parseSuggestBody,
  publicModelError,
} from '../src/suggest.js'

test('empty input returns the default Chinese next prompts', async () => {
  const body = await suggest({ input: '' })
  assert.deepEqual(body, {
    suggestions: [
      { text: '帮我看看这个改动有没有问题', kind: 'next' },
      { text: '先给出计划，先不要改文件', kind: 'next' },
      { text: '帮我把失败的测试修掉', kind: 'next' },
    ],
    source: 'fallback',
    model: null,
  })
})

test('a failing-test reply moves the test prompt first', async () => {
  const body = await suggest({
    input: '   ',
    messages: [{ role: 'assistant', content: 'The tests failed on main.' }],
  })
  assert.deepEqual(body.suggestions.map((item) => item.text), [
    'Fix the failing tests',
    'Review this change for problems',
    'Plan the change and do not edit files yet',
  ])
  assert.equal(body.suggestions[0].kind, 'next')
})

test('Chinese prefix completions keep the typed prefix', async () => {
  const body = await suggest({ input: '  帮我  ' })
  assert.deepEqual(body.suggestions, [
    { text: '帮我看看这个改动有没有问题', kind: 'completion' },
    { text: '帮我把失败的测试修掉', kind: 'completion' },
    { text: '帮我，并说明原因', kind: 'completion' },
  ])
  for (const item of body.suggestions) assert.ok(item.text.startsWith('帮我'))
})

test('English prefix completion keeps the caller case', async () => {
  const body = await suggest({ input: 'fix the' })
  assert.equal(body.suggestions[0].text, 'fix the failing tests')
  assert.equal(body.suggestions[0].kind, 'completion')
})

test('a finished sentence continues after the punctuation', async () => {
  const body = await suggest({ input: '看一下。', limit: 1 })
  assert.deepEqual(body.suggestions, [
    { text: '看一下。 并说明原因', kind: 'completion' },
  ])
})

test('slash suggestions use the built-in command palette', async () => {
  const all = await suggest({ input: '/', limit: 5 })
  assert.deepEqual(all.suggestions.map((item) => item.text), [
    '/compact',
    '/goal',
    '/plan',
    '/permission',
    '/feedback',
  ])
  const prefix = await suggest({ input: '/pl' })
  assert.deepEqual(prefix.suggestions.map((item) => item.text), ['/plan'])
  const both = await suggest({ input: '/p' })
  assert.deepEqual(both.suggestions.map((item) => item.text), ['/plan', '/permission'])
  const plan = await suggest({ input: '/plan ' })
  assert.deepEqual(plan.suggestions.map((item) => item.text), ['/plan off'])
  const preset = await suggest({ input: '/permission r' })
  assert.deepEqual(preset.suggestions.map((item) => item.text), ['/permission read-only'])
  const done = await suggest({ input: '/export' })
  assert.deepEqual(done.suggestions, [])
  const upper = await suggest({ input: '/P' })
  assert.deepEqual(upper.suggestions.map((item) => item.text), ['/plan', '/permission'])
})

test('parse keeps the last eight messages and rejects a bad body', () => {
  const messages = Array.from({ length: 9 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `m${index + 1}`,
  }))
  const parsed = parseSuggestBody({ input: 'x', messages })
  assert.deepEqual(parsed.messages.map((message) => message.content), [
    'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9',
  ])
  assert.throws(() => parseSuggestBody({ input: 1 }), /input must be a string/)
  assert.throws(() => parseSuggestBody({ input: 'x', limit: 6 }), /limit must be an integer/)
  assert.throws(() => parseSuggestBody({ input: 'x', source: 'auto' }), /source must be fallback or model/)
})

test('fallback does not call the model, and a missing key is explicit', async () => {
  let calls = 0
  const complete = async () => {
    calls += 1
    throw new Error('super-secret-key')
  }
  const forced = await buildSuggestions(parseSuggestBody({ input: '', source: 'fallback' }), {
    apiKey: 'super-secret-key',
    model: 'deepseek-flash',
    complete,
  })
  assert.equal(calls, 0)
  assert.equal(forced.source, 'fallback')
  assert.equal(forced.modelError, undefined)

  const missing = await buildSuggestions(parseSuggestBody({ input: '', source: 'model' }), {
    apiKey: '',
    model: 'deepseek-flash',
    complete,
  })
  assert.equal(calls, 0)
  assert.equal(missing.modelError, 'DEEPSEEK_API_KEY is not set')
  assert.equal(JSON.stringify(missing).includes('super-secret-key'), false)
})

test('model text is used only when it continues the input', async () => {
  const ok = await buildSuggestions(parseSuggestBody({ input: '帮我', source: 'model' }), {
    apiKey: 'test-key',
    model: 'deepseek-flash',
    complete: async () => ['帮我看看日志', '另一句'],
  })
  assert.deepEqual(ok, {
    suggestions: [{ text: '帮我看看日志', kind: 'completion' }],
    source: 'model',
    model: 'deepseek-flash',
  })

  const bad = await buildSuggestions(parseSuggestBody({ input: '帮我', source: 'model' }), {
    apiKey: 'test-key',
    model: 'deepseek-flash',
    complete: async () => ['完全不相关'],
  })
  assert.equal(bad.source, 'fallback')
  assert.equal(bad.model, null)
  assert.equal(bad.modelError, 'deepseek returned an unusable payload')
  assert.equal(bad.suggestions[0].text, '帮我看看这个改动有没有问题')
})

test('upstream failures fall back without echoing the key', async () => {
  const body = await buildSuggestions(parseSuggestBody({ input: '' }), {
    apiKey: 'super-secret-key',
    model: 'deepseek-flash',
    complete: async () => {
      throw new Error('socket reset super-secret-key')
    },
  })
  assert.equal(body.source, 'fallback')
  assert.equal(body.modelError, 'deepseek request failed')
  assert.equal(JSON.stringify(body).includes('super-secret-key'), false)
  const status = Object.assign(new Error('nope'), { statusCode: 401 })
  assert.equal(publicModelError(status), 'deepseek request failed (401)')
})

test('deepseek request uses the documented chat-completions shape', async () => {
  let seen
  const texts = await completeWithDeepseek(parseSuggestBody({ input: '帮我', limit: 2 }), {
    apiKey: 'test-key',
    model: 'deepseek-flash',
    apiBase: 'https://api.deepseek.com/',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            choices: [{
              message: {
                content: '```json\n{"suggestions":["帮我看一下测试"]}\n```',
              },
            }],
          }
        },
      }
    },
  })
  assert.deepEqual(texts, ['帮我看一下测试'])
  assert.equal(seen.url, 'https://api.deepseek.com/chat/completions')
  assert.equal(seen.init.headers.authorization, 'Bearer test-key')
  assert.equal(seen.init.redirect, 'error')
  const payload = JSON.parse(seen.init.body)
  assert.equal(payload.model, 'deepseek-flash')
  assert.equal(payload.temperature, 0)
  assert.equal(payload.stream, false)
  assert.deepEqual(payload.thinking, { type: 'disabled' })
  assert.deepEqual(suggestionsFromContent('{"suggestions":["一条"]}'), ['一条'])
})

test('a non-json model body is an unusable payload', () => {
  assert.throws(() => suggestionsFromContent('not json'), /bad payload/)
})

test('HTTP host serves health, suggestions, and errors', async () => {
  let fetches = 0
  await withServer({ DEEPSEEK_API_KEY: 'super-secret-key' }, {
    fetchImpl: async () => {
      fetches += 1
      throw new Error('super-secret-key leaked into fetch')
    },
  }, async (base) => {
    const health = await fetch(`${base}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), {
      ok: true,
      service: 'dsh-prompt-suggestions',
      role: 'host',
      predictor: 'deepseek-flash',
    })

    const options = await fetch(`${base}/v1/suggestions`, { method: 'OPTIONS' })
    assert.equal(options.status, 204)
    assert.equal(options.headers.get('access-control-allow-origin'), '*')

    const forced = await fetch(`${base}/v1/suggestions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: '/p', source: 'fallback' }),
    })
    assert.equal(fetches, 0)
    assert.deepEqual(await forced.json(), {
      suggestions: [
        { text: '/plan', kind: 'completion' },
        { text: '/permission', kind: 'completion' },
      ],
      source: 'fallback',
      model: null,
    })

    const failed = await fetch(`${base}/v1/suggestions`, {
      method: 'POST',
      body: JSON.stringify({ input: '' }),
    })
    const failedBody = await failed.json()
    assert.equal(failed.status, 200)
    assert.equal(failedBody.source, 'fallback')
    assert.equal(failedBody.modelError, 'deepseek request failed')
    assert.equal(JSON.stringify(failedBody).includes('super-secret-key'), false)
    assert.equal(fetches, 1)

    const bad = await fetch(`${base}/v1/suggestions`, { method: 'POST', body: '{' })
    assert.equal(bad.status, 400)
    const missing = await fetch(`${base}/nope`)
    assert.equal(missing.status, 404)
    const method = await fetch(`${base}/v1/suggestions`)
    assert.equal(method.status, 405)
    const huge = await fetch(`${base}/v1/suggestions`, {
      method: 'POST',
      body: 'x'.repeat(33 * 1024),
    })
    assert.equal(huge.status, 413)
  })
})

async function suggest(body, deps = {}) {
  return buildSuggestions(parseSuggestBody(body), {
    apiKey: '',
    model: 'deepseek-flash',
    complete: async () => {
      throw new Error('model should not be called')
    },
    ...deps,
  })
}

async function withServer(env, deps, fn) {
  const server = createApp(env, deps)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    return await fn(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
}
