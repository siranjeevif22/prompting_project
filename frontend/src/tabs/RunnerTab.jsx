import { useState, useEffect, useRef, useMemo } from 'react'
import { API, extractTurns, extractTranscript, extractUsage, streamFetch, calcCost, fmtCost } from '../lib/streamParse'

export default function RunnerTab({ lastFixedPrompt, setLastTranscript, setLastRunnerAgentPrompt, switchTab }) {
  const [agentPrompt, setAgentPrompt] = useState('')
  const [agentModel, setAgentModel] = useState('llama-3.3-70b-versatile')
  const [userPrompt, setUserPrompt] = useState('')
  const [configJson, setConfigJson] = useState('')
  const [turns, setTurns] = useState([])
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [transcriptReady, setTranscriptReady] = useState(false)
  const [transcriptData, setTranscriptData] = useState(null)
  const abortRef = useRef(null)

  // Mode selection
  const [awaitingMode, setAwaitingMode] = useState(false)
  const [runMode, setRunMode] = useState(null) // 'auto' | 'manual'

  // Manual mode
  const [manualInput, setManualInput] = useState('')
  const [manualLoading, setManualLoading] = useState(false)
  const [conversationEnded, setConversationEnded] = useState(false)
  const [manualUsage, setManualUsage] = useState(null)
  const agentHistoryRef = useRef([])
  const turnCountRef = useRef(0)
  const messagesRef = useRef([])
  const manualInputRef = useRef(null)

  useEffect(() => {
    fetch(`${API}/user-prompt`).then(r => r.json()).then(d => {
      if (d.prompt && !userPrompt) setUserPrompt(d.prompt)
    }).catch(() => {})
    fetch(`${API}/runner-config`).then(r => r.json()).then(d => {
      if (d.config && !configJson) setConfigJson(d.config)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (lastFixedPrompt) setAgentPrompt(lastFixedPrompt)
  }, [lastFixedPrompt])

  const configValid = useMemo(() => {
    if (!configJson.trim()) return false
    try { JSON.parse(configJson); return true } catch { return false }
  }, [configJson])

  const substitutedAgentPrompt = useMemo(() => {
    if (!agentPrompt || !configValid) return agentPrompt
    try {
      const cfg = JSON.parse(configJson)
      let out = agentPrompt
      for (const [k, v] of Object.entries(cfg)) {
        out = out.replaceAll('{' + k + '}', String(v))
      }
      return out
    } catch {
      return agentPrompt
    }
  }, [agentPrompt, configJson, configValid])

  async function handleFileUpload(e, setter) {
    const f = e.target.files[0]
    if (!f) return
    const text = await f.text()
    setter(text)
  }

  function validateInputs() {
    if (!agentPrompt.trim()) { setError('Agent system prompt is empty'); return false }
    if (!userPrompt.trim()) { setError('Candidate system prompt is empty'); return false }
    if (!configValid) { setError('Config JSON is invalid'); return false }
    return true
  }

  function handleRunClick() {
    if (!validateInputs()) return
    setError('')
    setAwaitingMode(true)
  }

  function resetState() {
    setTurns([])
    setUsage(null)
    setTranscriptReady(false)
    setTranscriptData(null)
    setConversationEnded(false)
    setManualUsage(null)
    setManualInput('')
    agentHistoryRef.current = []
    turnCountRef.current = 0
    messagesRef.current = []
  }

  // ── AUTO MODE ──────────────────────────────────────────────────────────────

  async function handleAutoRun() {
    setAwaitingMode(false)
    setRunMode('auto')
    resetState()
    setLoading(true)

    const fd = new FormData()
    fd.append('agent_system_prompt', agentPrompt)
    fd.append('user_system_prompt', userPrompt)
    fd.append('config_json', configJson)
    fd.append('agent_model', agentModel)

    const ctrl = new AbortController()
    abortRef.current = ctrl

    let lastAccumulated = ''
    try {
      const accumulated = await streamFetch(`${API}/run`, fd, {
        signal: ctrl.signal,
        onChunk: (acc) => {
          lastAccumulated = acc
          const t = extractTurns(acc)
          setTurns(t)
          const u = extractUsage(acc)
          if (u) setUsage(u)
        },
      })
      lastAccumulated = accumulated
      const u = extractUsage(accumulated)
      if (u) setUsage(u)
      const transcript = extractTranscript(accumulated)
      if (transcript) {
        setLastTranscript(transcript)
        setTranscriptData(transcript)
        setTranscriptReady(true)
        const fd2 = new FormData()
        fd2.append('payload', JSON.stringify({ messages: transcript.messages }, null, 2))
        fetch(`${API}/db/transcript`, { method: 'POST', body: fd2 }).catch(() => {})
      }
    } catch (e) {
      if (e.name === 'AbortError') {
        setError('Stopped by user')
        const u = extractUsage(lastAccumulated)
        if (u) setUsage(u)
      } else {
        setError(`Run failed: ${e.message}`)
      }
    } finally {
      setLoading(false)
      abortRef.current = null
    }
  }

  function handleStop() {
    if (abortRef.current) abortRef.current.abort()
  }

  // ── MANUAL MODE ────────────────────────────────────────────────────────────

  async function handleManualRun() {
    setAwaitingMode(false)
    setRunMode('manual')
    resetState()
    setManualLoading(true)
    await fetchAgentTurn()
  }

  async function fetchAgentTurn() {
    try {
      const fd = new FormData()
      fd.append('agent_system_prompt', agentPrompt)
      fd.append('messages_json', JSON.stringify(agentHistoryRef.current))
      fd.append('agent_model', agentModel)
      fd.append('config_json', configJson)

      const res = await fetch(`${API}/run-turn`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error)

      turnCountRef.current += 1
      const turn = turnCountRef.current
      const reply = data.reply

      agentHistoryRef.current = [...agentHistoryRef.current, { role: 'assistant', content: reply }]
      messagesRef.current = [...messagesRef.current, { turn, role: 'agent', content: reply }]
      setTurns(prev => [...prev, { turn, role: 'agent', content: reply }])

      if (data.usage) {
        setManualUsage(prev => ({
          model: data.usage.model,
          input_tokens: (prev?.input_tokens || 0) + data.usage.input_tokens,
          output_tokens: (prev?.output_tokens || 0) + data.usage.output_tokens,
          cached_tokens: (prev?.cached_tokens || 0) + data.usage.cached_tokens,
        }))
      }

      if (reply.toLowerCase().includes('end_call')) {
        finalizeManualTranscript()
      } else {
        setTimeout(() => manualInputRef.current?.focus(), 50)
      }
    } catch (e) {
      setError(`Agent turn failed: ${e.message}`)
    } finally {
      setManualLoading(false)
    }
  }

  async function handleManualSend() {
    if (!manualInput.trim() || manualLoading || conversationEnded) return
    const userText = manualInput.trim()
    setManualInput('')

    turnCountRef.current += 1
    const turn = turnCountRef.current
    agentHistoryRef.current = [...agentHistoryRef.current, { role: 'user', content: userText }]
    messagesRef.current = [...messagesRef.current, { turn, role: 'candidate', content: userText }]
    setTurns(prev => [...prev, { turn, role: 'candidate', content: userText }])

    setManualLoading(true)
    await fetchAgentTurn()
  }

  function handleManualStop() {
    finalizeManualTranscript()
    setManualLoading(false)
  }

  function finalizeManualTranscript() {
    if (messagesRef.current.length > 0) {
      const transcript = { messages: messagesRef.current }
      setTranscriptData(transcript)
      setLastTranscript(transcript)
      setTranscriptReady(true)
      const fd2 = new FormData()
      fd2.append('payload', JSON.stringify({ messages: transcript.messages }, null, 2))
      fetch(`${API}/db/transcript`, { method: 'POST', body: fd2 }).catch(() => {})
    }
    setConversationEnded(true)
  }

  // ── SHARED ─────────────────────────────────────────────────────────────────

  function downloadTranscript() {
    const messages = transcriptData ? transcriptData.messages : turns
    const blob = new Blob([JSON.stringify({ messages }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `transcript_${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const isIdle = !loading && !manualLoading && !awaitingMode && runMode === null
  const canReset = !loading && !manualLoading && (turns.length > 0 || awaitingMode)

  return (
    <>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <div className="label-row">
          <label className="label">Recruiter Agent Model</label>
        </div>
        <select
          className="model-select"
          value={agentModel}
          onChange={e => setAgentModel(e.target.value)}
          disabled={loading || manualLoading || awaitingMode}
        >
          <optgroup label="Groq">
            <option value="llama-3.3-70b-versatile">llama-3.3-70b-versatile — $0.59/$0.79 /1M</option>
            <option value="openai/gpt-oss-120b">openai/gpt-oss-120b — $0.15/$0.60 /1M</option>
            <option value="openai/gpt-oss-20b">openai/gpt-oss-20b — $0.075/$0.30 /1M</option>
            <option value="llama-3.1-8b-instant">llama-3.1-8b-instant — $0.05/$0.08 /1M</option>
          </optgroup>
          <optgroup label="OpenAI">
            <option value="gpt-4o-mini">gpt-4o-mini — $0.15/$0.60 /1M</option>
            <option value="gpt-4.1-nano">gpt-4.1-nano — $0.10/$0.40 /1M</option>
            <option value="gpt-4.1-mini">gpt-4.1-mini — $0.40/$1.60 /1M</option>
            <option value="gpt-4.1">gpt-4.1 — $2.00/$8.00 /1M</option>
            <option value="gpt-5">gpt-5 — $1.25/$10.00 /1M</option>
          </optgroup>
        </select>
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">Agent System Prompt (Sarah)</label>
          <label className="file-btn small">
            Load .txt
            <input type="file" accept=".txt,text/plain" onChange={e => handleFileUpload(e, setAgentPrompt)} />
          </label>
        </div>
        <textarea
          className="prompt-area"
          value={agentPrompt}
          onChange={e => setAgentPrompt(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder="Agent system prompt (auto-filled from Fixer if available)"
        />
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">Candidate System Prompt</label>
          <label className="file-btn small">
            Load .txt
            <input type="file" accept=".txt,text/plain" onChange={e => handleFileUpload(e, setUserPrompt)} />
          </label>
        </div>
        <textarea
          className="prompt-area"
          value={userPrompt}
          onChange={e => setUserPrompt(e.target.value)}
          rows={6}
          spellCheck={false}
        />
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">Config JSON {configValid ? <span className="json-ok">✓</span> : <span className="json-err">✗ invalid</span>}</label>
          <label className="file-btn small">
            Load .json
            <input type="file" accept=".json,application/json" onChange={e => handleFileUpload(e, setConfigJson)} />
          </label>
        </div>
        <textarea
          className={`prompt-area mono ${configValid ? '' : 'invalid'}`}
          value={configJson}
          onChange={e => setConfigJson(e.target.value)}
          rows={10}
          spellCheck={false}
        />
      </section>

      {/* ── Run button / mode selection ── */}
      <div className="eval-btn-row">
        {!awaitingMode && !loading && runMode !== 'manual' && (
          <button
            className="evaluate-btn runner-btn"
            onClick={handleRunClick}
            disabled={loading || manualLoading || !configValid}
          >
            {loading ? 'Running...' : 'Run Conversation'}
          </button>
        )}
        {loading && (
          <button className="evaluate-btn stop-btn" onClick={handleStop}>Stop</button>
        )}
        {awaitingMode && (
          <>
            <button className="evaluate-btn runner-btn" onClick={handleAutoRun}>
              Auto Mode
            </button>
            <button className="evaluate-btn gemini-btn" onClick={handleManualRun}>
              Manual Mode
            </button>
            <button className="evaluate-btn stop-btn" onClick={() => setAwaitingMode(false)}>
              Cancel
            </button>
          </>
        )}
        {canReset && !awaitingMode && !loading && (
          <button
            className="evaluate-btn stop-btn"
            style={{marginLeft: 'auto'}}
            onClick={() => { resetState(); setRunMode(null); setError('') }}
          >
            Reset
          </button>
        )}
      </div>

      {/* ── Auto mode usage ── */}
      {runMode === 'auto' && usage && (
        <div className="usage-bar" style={{flexWrap: 'wrap', gap: 6}}>
          {usage.agent_model && (<>
            <span className="usage-chip model-chip">{usage.agent_model} (Agent)</span>
            <span className="usage-chip">In: <strong>{usage.agent_input.toLocaleString()}</strong></span>
            {usage.agent_cached > 0 && <span className="usage-chip" style={{opacity:0.7}}>Cached: <strong>{usage.agent_cached.toLocaleString()}</strong></span>}
            <span className="usage-chip">Out: <strong>{usage.agent_output.toLocaleString()}</strong></span>
            {fmtCost(calcCost(usage.agent_model, usage.agent_input, usage.agent_output, usage.agent_cached || 0)) && (
              <span className="usage-chip cost-chip">{fmtCost(calcCost(usage.agent_model, usage.agent_input, usage.agent_output, usage.agent_cached || 0))}</span>
            )}
            <span className="usage-chip" style={{opacity: 0.3}}>|</span>
            <span className="usage-chip model-chip">{usage.user_model} (Candidate)</span>
            <span className="usage-chip">In: <strong>{usage.user_input.toLocaleString()}</strong></span>
            <span className="usage-chip">Out: <strong>{usage.user_output.toLocaleString()}</strong></span>
            {fmtCost(calcCost(usage.user_model, usage.user_input, usage.user_output, usage.user_cached || 0)) && (
              <span className="usage-chip cost-chip">{fmtCost(calcCost(usage.user_model, usage.user_input, usage.user_output, usage.user_cached || 0))}</span>
            )}
            <span className="usage-chip" style={{opacity: 0.3}}>|</span>
          </>)}
          <span className="usage-chip">Total: <strong>{(usage.input_tokens + usage.output_tokens).toLocaleString()} tokens</strong></span>
          {usage.agent_model && fmtCost(
            (calcCost(usage.agent_model, usage.agent_input, usage.agent_output, usage.agent_cached || 0) || 0) +
            (calcCost(usage.user_model, usage.user_input, usage.user_output, usage.user_cached || 0) || 0)
          ) && (
            <span className="usage-chip cost-chip">Total Cost: <strong>{fmtCost(
              (calcCost(usage.agent_model, usage.agent_input, usage.agent_output, usage.agent_cached || 0) || 0) +
              (calcCost(usage.user_model, usage.user_input, usage.user_output, usage.user_cached || 0) || 0)
            )}</strong></span>
          )}
        </div>
      )}

      {/* ── Manual mode usage ── */}
      {runMode === 'manual' && manualUsage && (
        <div className="usage-bar" style={{flexWrap: 'wrap', gap: 6}}>
          <span className="usage-chip model-chip">{manualUsage.model} (Agent)</span>
          <span className="usage-chip">In: <strong>{manualUsage.input_tokens.toLocaleString()}</strong></span>
          {manualUsage.cached_tokens > 0 && <span className="usage-chip" style={{opacity:0.7}}>Cached: <strong>{manualUsage.cached_tokens.toLocaleString()}</strong></span>}
          <span className="usage-chip">Out: <strong>{manualUsage.output_tokens.toLocaleString()}</strong></span>
          {fmtCost(calcCost(manualUsage.model, manualUsage.input_tokens, manualUsage.output_tokens, manualUsage.cached_tokens || 0)) && (
            <span className="usage-chip cost-chip">{fmtCost(calcCost(manualUsage.model, manualUsage.input_tokens, manualUsage.output_tokens, manualUsage.cached_tokens || 0))}</span>
          )}
          <span className="usage-chip" style={{opacity: 0.3}}>|</span>
          <span className="usage-chip">You (Candidate — no tokens)</span>
        </div>
      )}

      {turns.length > 0 && (
        <section className="card">
          <div className="label-row">
            <label className="label">Substituted Agent Prompt</label>
            <button className="copy-btn" onClick={() => navigator.clipboard.writeText(substitutedAgentPrompt)}>Copy</button>
          </div>
          <pre className="output-pre" style={{maxHeight: 200, overflowY: 'auto'}}>{substitutedAgentPrompt}</pre>
        </section>
      )}

      {turns.length > 0 && (
        <section className="card">
          <div className="label-row">
            <label className="label">
              Conversation ({turns.length} messages)
              {runMode === 'manual' && <span className="usage-chip" style={{marginLeft: 8, fontSize: 11}}>Manual Mode</span>}
            </label>
            {(loading || manualLoading) && (
              <div className="streaming-indicator">
                <span className="pulse-dot" />
                <span style={{fontSize: 12, color: 'var(--gray-500)'}}>
                  {loading ? 'streaming...' : 'agent thinking...'}
                </span>
              </div>
            )}
          </div>
          <div className="chat-thread">
            {turns.map((t, i) => (
              <div key={i} className={`chat-bubble ${t.role}`}>
                <div className="chat-bubble-meta">
                  <span className="chat-role">
                    {t.role === 'agent' ? 'Sarah (Agent)' : (runMode === 'manual' ? 'You' : 'Candidate')}
                  </span>
                  <span className="chat-turn">Turn {t.turn}</span>
                </div>
                <div className="chat-content">{t.content}</div>
              </div>
            ))}
          </div>

          {/* ── Manual mode input ── */}
          {runMode === 'manual' && !conversationEnded && (
            <div style={{padding: '12px 0 0 0', display: 'flex', flexDirection: 'column', gap: 8}}>
              <textarea
                ref={manualInputRef}
                className="prompt-area"
                value={manualInput}
                onChange={e => setManualInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleManualSend() }
                }}
                rows={3}
                spellCheck={false}
                placeholder="Your reply to the agent... (Enter to send, Shift+Enter for newline)"
                disabled={manualLoading}
              />
              <div className="eval-btn-row" style={{marginTop: 0}}>
                <button
                  className="evaluate-btn runner-btn"
                  onClick={handleManualSend}
                  disabled={manualLoading || !manualInput.trim()}
                >
                  {manualLoading ? 'Agent thinking...' : 'Send'}
                </button>
                <button className="evaluate-btn stop-btn" onClick={handleManualStop}>
                  Stop Conversation
                </button>
              </div>
            </div>
          )}

          {runMode === 'manual' && conversationEnded && (
            <div style={{padding: '12px 0 0 0', color: 'var(--gray-500)', fontSize: 13}}>
              Conversation ended.
            </div>
          )}
        </section>
      )}

      {/* ── Send to Evaluator / Download ── */}
      {turns.length > 0 && !loading && (runMode === 'auto' || conversationEnded) && (
        <div className="eval-btn-row">
          <button className="evaluate-btn gemini-btn" onClick={() => {
            const messages = transcriptData ? transcriptData.messages : turns
            setLastTranscript({ messages })
            if (setLastRunnerAgentPrompt) setLastRunnerAgentPrompt(agentPrompt)
            downloadTranscript()
            switchTab('evaluator')
          }}>
            Send to Evaluator →
          </button>
          <button className="evaluate-btn copy-dl-btn" onClick={downloadTranscript}>
            Download Transcript JSON
          </button>
        </div>
      )}
    </>
  )
}
