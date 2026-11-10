/**
 * Deterministic composer suggestions for DeepSeek Harness.
 *
 * dsh's own plugin host registers routes inside the harness process and reads
 * the live session. This module does not. The caller sends the current input.
 */

export class SuggestionError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'SuggestionError'
    this.status = status
  }
}

export const DEFAULT_LIMIT = 3
export const MAX_LIMIT = 5
const MAX_INPUT = 4000
const MAX_MESSAGES = 8
const MAX_MESSAGE = 2000

// Web UI command palette, in the order documented for that menu.
// Argument forms are only the ones the harness docs spell out.
const COMMANDS = [
  { name: 'compact', line: '/compact', args: [] },
  { name: 'goal', line: '/goal', args: [] },
  { name: 'plan', line: '/plan', args: ['/plan off'] },
  {
    name: 'permission',
    line: '/permission',
    args: [
      '/permission read-only',
      '/permission workspace-write',
      '/permission danger-full-access',
    ],
  },
  { name: 'feedback', line: '/feedback', args: [] },
  { name: 'export', line: '/export', args: [] },
  { name: 'model', line: '/model', args: [] },
]

const PROMPTS = {
  zh: [
    { id: 'review', text: '帮我看看这个改动有没有问题' },
    { id: 'plan', text: '先给出计划，先不要改文件' },
    { id: 'test', text: '帮我把失败的测试修掉' },
    { id: 'explain', text: '解释一下刚才的改动' },
    { id: 'summary', text: '给这次改动写一段简短说明' },
  ],
  en: [
    { id: 'review', text: 'Review this change for problems' },
    { id: 'plan', text: 'Plan the change and do not edit files yet' },
    { id: 'test', text: 'Fix the failing tests' },
    { id: 'explain', text: 'Explain the last change' },
    { id: 'summary', text: 'Write a short summary of this change' },
  ],
}

const TAILS = {
  zh: ['并说明原因', '只列出要改的文件', '先不要改文件'],
  en: ['and explain why', 'and list the files to change', 'but do not edit files yet'],
}

export function parseSuggestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new SuggestionError('JSON body must be an object')
  }
  if (typeof body.input !== 'string') {
    throw new SuggestionError('input must be a string')
  }
  if (body.input.length > MAX_INPUT) {
    throw new SuggestionError(`input must be at most ${MAX_INPUT} characters`)
  }

  let source
  if (body.source !== undefined) {
    if (body.source !== 'fallback' && body.source !== 'model') {
      throw new SuggestionError('source must be fallback or model')
    }
    source = body.source
  }

  let limit = DEFAULT_LIMIT
  if (body.limit !== undefined) {
    if (!Number.isInteger(body.limit) || body.limit < 1 || body.limit > MAX_LIMIT) {
      throw new SuggestionError(`limit must be an integer from 1 to ${MAX_LIMIT}`)
    }
    limit = body.limit
  }

  let messages = []
  if (body.messages !== undefined) {
    if (!Array.isArray(body.messages)) {
      throw new SuggestionError('messages must be an array')
    }
    messages = body.messages.map((message, index) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        throw new SuggestionError(`messages[${index}] must be an object`)
      }
      if (message.role !== 'user' && message.role !== 'assistant') {
        throw new SuggestionError(`messages[${index}].role must be user or assistant`)
      }
      if (typeof message.content !== 'string') {
        throw new SuggestionError(`messages[${index}].content must be a string`)
      }
      return { role: message.role, content: message.content.slice(0, MAX_MESSAGE) }
    }).filter((message) => message.content.trim() !== '')
    if (messages.length > MAX_MESSAGES) messages = messages.slice(-MAX_MESSAGES)
  }

  return { input: body.input.trim(), messages, limit, source }
}

export function fallbackSuggestions(parsed) {
  if (!parsed.input) return nextPrompts(parsed)
  if (parsed.input.startsWith('/')) return slashSuggestions(parsed.input, parsed.limit)
  return completionSuggestions(parsed)
}

export function takeModelSuggestions(texts, parsed) {
  const out = []
  for (const raw of texts) {
    if (typeof raw !== 'string') continue
    const text = clip(raw.replace(/[\r\n]+/g, ' ').trim(), parsed.input)
    if (!text) continue
    if (!parsed.input) {
      pushUnique(out, { text, kind: 'next' })
    } else if (parsed.input.startsWith('/')) {
      if (text.toLowerCase() === parsed.input.toLowerCase()) continue
      if (!text.toLowerCase().startsWith(parsed.input.toLowerCase())) continue
      pushUnique(out, { text, kind: 'completion' })
    } else {
      if (!text.startsWith(parsed.input) || text.length === parsed.input.length) continue
      pushUnique(out, { text, kind: 'completion' })
    }
    if (out.length >= parsed.limit) break
  }
  return out
}

export function publicModelError(err) {
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
    return 'deepseek request timed out'
  }
  if (err?.code === 'bad_payload') return 'deepseek returned an unusable payload'
  if (typeof err?.statusCode === 'number') return `deepseek request failed (${err.statusCode})`
  return 'deepseek request failed'
}

export async function buildSuggestions(parsed, deps) {
  const apiKey = deps.apiKey?.trim() ?? ''
  if (parsed.source === 'fallback' || !apiKey) {
    const body = {
      suggestions: fallbackSuggestions(parsed),
      source: 'fallback',
      model: null,
    }
    if (parsed.source === 'model' && !apiKey) {
      body.modelError = 'DEEPSEEK_API_KEY is not set'
    }
    return body
  }

  try {
    const texts = await deps.complete(parsed)
    const suggestions = takeModelSuggestions(texts, parsed)
    if (suggestions.length === 0) {
      const err = new Error('unusable')
      err.code = 'bad_payload'
      throw err
    }
    return { suggestions, source: 'model', model: deps.model }
  } catch (err) {
    return {
      suggestions: fallbackSuggestions(parsed),
      source: 'fallback',
      model: null,
      modelError: publicModelError(err),
    }
  }
}

function nextPrompts(parsed) {
  const language = languageOf('', parsed.messages)
  const focus = [...parsed.messages].reverse().find((message) => message.role === 'assistant')?.content
    ?? parsed.messages.map((message) => message.content).join('\n')
  return orderPrompts(PROMPTS[language], biasId(focus))
    .slice(0, parsed.limit)
    .map((prompt) => ({ text: prompt.text, kind: 'next' }))
}

function completionSuggestions(parsed) {
  const { input, limit } = parsed
  const language = languageOf(input, parsed.messages)
  const out = []
  for (const prompt of PROMPTS[language]) {
    if (out.length >= limit) break
    if (!prompt.text.toLowerCase().startsWith(input.toLowerCase())) continue
    if (prompt.text.length <= input.length) continue
    pushUnique(out, { text: input + prompt.text.slice(input.length), kind: 'completion' })
  }
  for (const phrase of TAILS[language]) {
    if (out.length >= limit) break
    if (input.includes(phrase)) continue
    pushUnique(out, { text: joinTail(input, phrase, language), kind: 'completion' })
  }
  return out
}

function slashSuggestions(input, limit) {
  const match = /^\/([A-Za-z0-9_-]*)([\s\S]*)$/.exec(input)
  if (!match) return []
  const typedName = match[1].toLowerCase()
  const rest = match[2]
  const out = []
  const push = (text) => {
    if (out.length >= limit) return
    if (text.toLowerCase() === input.toLowerCase()) return
    if (!text.toLowerCase().startsWith(input.toLowerCase())) return
    pushUnique(out, { text, kind: 'completion' })
  }

  if (rest === '') {
    for (const command of COMMANDS) {
      if (!command.name.startsWith(typedName)) continue
      push(command.line)
      if (typedName === command.name) {
        for (const arg of command.args) push(arg)
      }
    }
    return out
  }

  const command = COMMANDS.find((item) => item.name === typedName)
  if (!command) return []
  for (const arg of command.args) push(arg)
  return out
}

function languageOf(input, messages) {
  const sample = input || messages.map((message) => message.content).join('\n')
  if (/[\u3400-\u9fff]/.test(sample)) return 'zh'
  if (/[A-Za-z]/.test(sample)) return 'en'
  return 'zh'
}

function biasId(text) {
  if (/测试|失败|failing|failed|\btests?\b/i.test(text)) return 'test'
  if (/计划|\bplan\b/i.test(text)) return 'plan'
  if (/解释|\bexplain\b/i.test(text)) return 'explain'
  return null
}

function orderPrompts(prompts, bias) {
  if (!bias) return prompts
  return [
    ...prompts.filter((prompt) => prompt.id === bias),
    ...prompts.filter((prompt) => prompt.id !== bias),
  ]
}

function joinTail(input, phrase, language) {
  if (/\s$/.test(input)) return input + phrase
  if (/[。！？.!?]$/.test(input)) return `${input} ${phrase}`
  if (language === 'zh') return `${input}，${phrase}`
  return `${input}, ${phrase}`
}

function clip(text, input) {
  const max = Math.max(240, input.length + 80)
  return text.length > max ? text.slice(0, max).trimEnd() : text
}

function pushUnique(out, item) {
  if (out.some((existing) => existing.text === item.text)) return
  out.push(item)
}
