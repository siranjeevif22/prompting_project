export const API = 'http://localhost:8000'

// Cost per 1M tokens (USD) — standard tier
const PRICING = {
  'gemini-2.5-flash':          { input: 0.30,   cached: 0.03,   output: 2.50  },
  // Groq
  'llama-3.3-70b-versatile':   { input: 0.59,   cached: 0.59,   output: 0.79  },
  'llama-3.1-8b-instant':      { input: 0.05,   cached: 0.05,   output: 0.08  },
  'openai/gpt-oss-120b':       { input: 0.15,   cached: 0.075,  output: 0.60  },
  'openai/gpt-oss-20b':        { input: 0.075,  cached: 0.0375, output: 0.30  },
  // OpenAI direct
  'gpt-4o-mini':               { input: 0.15,   cached: 0.075,  output: 0.60  },
  'gpt-4.1-nano':              { input: 0.10,   cached: 0.025,  output: 0.40  },
  'gpt-4.1-mini':              { input: 0.40,   cached: 0.10,   output: 1.60  },
  'gpt-4.1':                   { input: 2.00,   cached: 0.50,   output: 8.00  },
  'gpt-5':                     { input: 1.25,   cached: 0.125,  output: 10.00 },
}

export function calcCost(model, inputTokens, outputTokens, cachedTokens = 0) {
  const p = PRICING[model]
  if (!p) return null
  const nonCached = inputTokens - cachedTokens
  return (nonCached * p.input + cachedTokens * p.cached + outputTokens * p.output) / 1_000_000
}

export function fmtCost(usd) {
  if (usd === null || usd === undefined) return null
  if (usd < 0.000001) return '<$0.000001'
  return `$${usd.toFixed(6)}`
}

export function stripSentinels(accumulated) {
  return accumulated
    .replace(/\n\n__RESULT__[\s\S]*$/, '')
    .replace(/\n\n__USAGE__[\s\S]*$/, '')
    .replace(/__TURN__[^\n]*\n?/g, '')
    .replace(/__TRANSCRIPT__[^\n]*\n?/g, '')
}

export function extractResult(accumulated) {
  const idx = accumulated.lastIndexOf('__RESULT__')
  if (idx === -1) return null
  const tail = accumulated.slice(idx + 10).split('__USAGE__')[0].trim()
  try { return JSON.parse(tail) } catch { return null }
}

export function extractUsage(accumulated) {
  const idx = accumulated.lastIndexOf('__USAGE__')
  if (idx === -1) return null
  const tail = accumulated.slice(idx + 9).split(/\n/)[0].trim()
  try { return JSON.parse(tail) } catch { return null }
}

export function extractTranscript(accumulated) {
  const idx = accumulated.lastIndexOf('__TRANSCRIPT__')
  if (idx === -1) return null
  const tail = accumulated.slice(idx + 14).split(/\n/)[0].trim()
  try { return JSON.parse(tail) } catch { return null }
}

export function extractTurns(accumulated) {
  const turns = []
  const re = /__TURN__(\{[^\n]*?\})\n?/g
  let m
  while ((m = re.exec(accumulated)) !== null) {
    try { turns.push(JSON.parse(m[1])) } catch {}
  }
  return turns
}

export function tryLooseJson(text) {
  try { return JSON.parse(text.trim()) } catch {}
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/)
  if (fence) { try { return JSON.parse(fence[1]) } catch {} }
  const obj = text.match(/\{[\s\S]*\}/)
  if (obj) { try { return JSON.parse(obj[0]) } catch {} }
  return null
}

export async function streamFetch(url, body, { onChunk, signal } = {}) {
  const res = await fetch(url, { method: 'POST', body, signal })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let accumulated = ''
  let aborted = false

  if (signal) {
    signal.addEventListener('abort', () => {
      aborted = true
      reader.cancel()
    }, { once: true })
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value, { stream: true })
    accumulated += chunk
    if (onChunk) onChunk(accumulated, chunk)
  }

  if (aborted) throw new DOMException('The user aborted a request.', 'AbortError')
  return accumulated
}
