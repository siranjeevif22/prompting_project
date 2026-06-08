import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { API, stripSentinels, extractResult, extractUsage, tryLooseJson, streamFetch, calcCost, fmtCost } from '../lib/streamParse'
import { exportEvaluationDocx } from '../lib/exportDocx'

export default function EvaluatorTab({ prompt: initialPrompt, setPrompt: setAppPrompt, lastTranscript, setLastEvaluationJson, setLastEvaluatorPrompt, lastRunnerAgentPrompt, switchTab }) {
  const [prompt, setLocalPrompt] = useState('')
  const [configJson, setConfigJson] = useState('')
  const [transcript, setTranscript] = useState(null)
  const [rawOutput, setRawOutput] = useState('')
  const [parsed, setParsed] = useState(null)
  const [editableJson, setEditableJson] = useState('')
  const [jsonEditError, setJsonEditError] = useState('')
  const historyRef = useRef([])
  const historyIndexRef = useRef(-1)
  const transcriptInputRef = useRef(null)
  const configInputRef = useRef(null)
  const promptInputRef = useRef(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copiedPrompt, setCopiedPrompt] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [usage, setUsage] = useState(null)
  const [usingAutoTranscript, setUsingAutoTranscript] = useState(false)

  useEffect(() => {
    if (lastTranscript && !transcript) {
      setUsingAutoTranscript(true)
    }
  }, [lastTranscript, transcript])

  useEffect(() => {
    if (lastRunnerAgentPrompt) setPrompt(lastRunnerAgentPrompt)
  }, [lastRunnerAgentPrompt])

  useEffect(() => {
    fetch(`${API}/runner-config`).then(r => r.json()).then(d => {
      if (d.config && !configJson) setConfigJson(d.config)
    }).catch(() => {})
  }, [])

  function setPrompt(v) {
    setLocalPrompt(v)
    if (setAppPrompt) setAppPrompt(v)
  }

  const configValid = useMemo(() => {
    if (!configJson.trim()) return true
    try { JSON.parse(configJson); return true } catch { return false }
  }, [configJson])

  function substitutePrompt(raw) {
    if (!configJson.trim()) return raw
    try {
      const cfg = JSON.parse(configJson)
      let out = raw
      for (const [k, v] of Object.entries(cfg)) {
        out = out.replaceAll('{' + k + '}', String(v))
      }
      return out
    } catch {
      return raw
    }
  }

  useEffect(() => {
    fetch(`${API}/result`)
      .then(r => r.json())
      .then(d => {
        if (d.result) {
          setRawOutput(d.result)
          const p = tryLooseJson(d.result)
          if (p) setParsed(p)
        }
      })
      .catch(() => {})
  }, [])

  async function handleEvaluate(endpoint) {
    let transcriptBlob = null
    let transcriptName = null

    if (transcript) {
      transcriptBlob = transcript
      transcriptName = transcript.name
    } else if (usingAutoTranscript && lastTranscript) {
      transcriptBlob = new Blob([JSON.stringify(lastTranscript, null, 2)], { type: 'application/json' })
      transcriptName = 'run_transcript.json'
    } else {
      setError('Pick a transcript JSON file first')
      return
    }

    setError('')
    setLoading(true)
    setRawOutput('')
    setParsed(null)
    setUsage(null)

    const fd = new FormData()
    fd.append('transcript', transcriptBlob, transcriptName)
    fd.append('prompt', substitutePrompt(prompt))

    try {
      const accumulated = await streamFetch(`${API}/${endpoint}`, fd, {
        onChunk: (acc) => setRawOutput(stripSentinels(acc)),
      })
      const u = extractUsage(accumulated)
      if (u) setUsage(u)
      const p = extractResult(accumulated) || tryLooseJson(stripSentinels(accumulated))
      if (p) {
        setParsed(p)
        pushHistory(JSON.stringify(p, null, 2))
        setLastEvaluationJson(p)
        const fd2 = new FormData()
        fd2.append('payload', JSON.stringify(p, null, 2))
        fetch(`${API}/db/mistakes`, { method: 'POST', body: fd2 }).catch(() => {})
      } else {
        setError('Could not parse JSON from model output — check raw output.')
      }
    } catch (e) {
      setError(`Evaluation failed: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  function pushHistory(json) {
    const h = historyRef.current
    const idx = historyIndexRef.current
    // discard any redo states ahead of current
    h.splice(idx + 1)
    h.push(json)
    historyIndexRef.current = h.length - 1
    setEditableJson(json)
    setJsonEditError('')
  }

  function handleUndo() {
    if (historyIndexRef.current <= 0) return
    historyIndexRef.current -= 1
    setEditableJson(historyRef.current[historyIndexRef.current])
    setJsonEditError('')
  }

  function handleRedo() {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    historyIndexRef.current += 1
    setEditableJson(historyRef.current[historyIndexRef.current])
    setJsonEditError('')
  }

  function removeViolation(n) {
    try {
      const obj = JSON.parse(editableJson)
      if (!obj.violations || obj.violations[n - 1] === undefined) {
        setJsonEditError(`No violation #${n}`)
        return false
      }
      obj.violations.splice(n - 1, 1)
      pushHistory(JSON.stringify(obj, null, 2))
      return true
    } catch {
      setJsonEditError('Invalid JSON')
      return false
    }
  }

  function sendToFixer() {
    try {
      const edited = JSON.parse(editableJson)
      setLastEvaluationJson(edited)
      if (setLastEvaluatorPrompt) setLastEvaluatorPrompt(prompt)
      setJsonEditError('')
      switchTab('fixer')
    } catch {
      setJsonEditError('Invalid JSON — fix before sending')
    }
  }

  async function handleDownloadDocx() {
    const data = liveJson || parsed
    if (!data) return
    await exportEvaluationDocx(data, counts, checklistCounts)
  }

  // parse editableJson live for violations display
  const liveJson = useMemo(() => {
    try { return JSON.parse(editableJson) } catch { return null }
  }, [editableJson])

  const counts = useMemo(() => {
    const src = liveJson || parsed
    if (!src?.violations) return null
    return {
      critical: src.violations.filter(v => /critical/i.test(v.severity)).length,
      major: src.violations.filter(v => /major/i.test(v.severity)).length,
      minor: src.violations.filter(v => /minor/i.test(v.severity)).length,
    }
  }, [liveJson, parsed])

  const checklistCounts = useMemo(() => {
    const src = liveJson || parsed
    if (!src?.checklist) return null
    return {
      violated: src.checklist.filter(r => /violated/i.test(r.status)).length,
      partial: src.checklist.filter(r => /partial/i.test(r.status)).length,
      obeyed: src.checklist.filter(r => /obeyed/i.test(r.status)).length,
    }
  }, [liveJson, parsed])

  const hasOutput = !loading && parsed

  function clearAutoTranscript() {
    setUsingAutoTranscript(false)
  }

  useEffect(() => {
    function onKey(e) {
      if (!editableJson) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault()
        handleUndo()
      } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) {
        e.preventDefault()
        handleRedo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editableJson])

  return (
    <>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <label className="label">Transcript (JSON or TXT)</label>
        {usingAutoTranscript ? (
          <div className="file-row">
            <span className="auto-loaded-chip">Auto-loaded from Runner ({lastTranscript?.messages?.length || 0} turns)</span>
            <button className="copy-btn" onClick={clearAutoTranscript}>Use file instead</button>
          </div>
        ) : (
          <div className="file-row">
            <button className="file-btn" onClick={() => transcriptInputRef.current?.click()}>
              Choose file
            </button>
            <span style={{ width: 0, height: 0, overflow: 'hidden', display: 'inline-block' }}>
              <input
                ref={transcriptInputRef}
                type="file"
                accept=".json,.txt,application/json,text/plain"
                tabIndex={-1}
                onChange={e => setTranscript(e.target.files[0])}
              />
            </span>
            <span className="filename">{transcript ? transcript.name : 'No file selected'}</span>
          </div>
        )}
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">Config JSON {!configValid && <span className="json-err">✗ invalid</span>}</label>
          <button className="file-btn small" onClick={() => configInputRef.current?.click()}>Load .json</button>
          <span style={{ width: 0, height: 0, overflow: 'hidden', display: 'inline-block' }}>
            <input
              ref={configInputRef}
              type="file"
              accept=".json,application/json"
              tabIndex={-1}
              onChange={async e => { const f = e.target.files[0]; if (!f) return; setConfigJson(await f.text()) }}
            />
          </span>
        </div>
        <textarea
          className={`prompt-area mono ${configValid ? '' : 'invalid'}`}
          value={configJson}
          onChange={e => setConfigJson(e.target.value)}
          rows={6}
          spellCheck={false}
        />
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">System Prompt (editable)</label>
          <div style={{display: 'flex', gap: 8}}>
            <button className="file-btn small" onClick={() => promptInputRef.current?.click()}>Load .txt</button>
            <span style={{ width: 0, height: 0, overflow: 'hidden', display: 'inline-block' }}>
              <input
                ref={promptInputRef}
                type="file"
                accept=".txt,text/plain"
                tabIndex={-1}
                onChange={async e => { const f = e.target.files[0]; if (!f) return; setPrompt(await f.text()) }}
              />
            </span>
            <button className="copy-btn" onClick={() => {
              navigator.clipboard.writeText(prompt).then(() => {
                setCopiedPrompt(true); setTimeout(() => setCopiedPrompt(false), 1500)
              })
            }}>{copiedPrompt ? 'Copied' : 'Copy'}</button>
          </div>
        </div>
        <textarea className="prompt-area" value={prompt} onChange={e => setPrompt(e.target.value)} rows={14} spellCheck={false} />
      </section>

      <div className="eval-btn-row">
        <button className="evaluate-btn gemini-btn" onClick={() => handleEvaluate('evaluate-gemini')} disabled={loading}>
          {loading ? 'Evaluating...' : 'Evaluate (Gemini)'}
        </button>
      </div>

      {!loading && usage && (
        <div className="usage-bar">
          {usage.model && <span className="usage-chip model-chip">{usage.model}</span>}
          <span className="usage-chip">In: <strong>{usage.input_tokens.toLocaleString()}</strong></span>
          <span className="usage-chip">Out: <strong>{usage.output_tokens.toLocaleString()}</strong></span>
          {usage.thinking_tokens > 0 && (
            <span className="usage-chip" style={{background:'#fdf4ff',borderColor:'#d8b4fe',color:'#7e22ce'}}>Thinking: <strong>{usage.thinking_tokens.toLocaleString()}</strong></span>
          )}
          <span className="usage-chip">Total: <strong>{(usage.input_tokens + usage.output_tokens).toLocaleString()} tokens</strong></span>
          {fmtCost(calcCost(usage.model, usage.input_tokens, usage.output_tokens)) && (
            <span className="usage-chip cost-chip">Cost: <strong>{fmtCost(calcCost(usage.model, usage.input_tokens, usage.output_tokens))}</strong></span>
          )}
        </div>
      )}

      {loading && (
        <section className="card">
          <div className="label-row">
            <div className="streaming-indicator">
              <span className="pulse-dot" />
              <label className="label" style={{margin: 0}}>Raw Output</label>
            </div>
          </div>
          <pre className="output-pre">{rawOutput}</pre>
        </section>
      )}

      {hasOutput && (
        <>
          <div className="raw-toggle-row">
            <button className="raw-toggle-btn" onClick={() => setShowRaw(p => !p)}>
              {showRaw ? 'Hide raw output' : 'Show raw output'}
            </button>
            <button className="download-docx-btn" onClick={handleDownloadDocx}>
              ⬇ Download DOCX
            </button>
          </div>

          {showRaw && rawOutput && (
            <section className="card">
              <label className="label">Raw Output</label>
              <pre className="output-pre">{rawOutput}</pre>
            </section>
          )}

          {parsed.summary && (
            <section className="card">
              <label className="label">Summary</label>
              <p className="summary-text">{parsed.summary}</p>
            </section>
          )}

          {counts && (counts.critical > 0 || counts.major > 0 || counts.minor > 0) && (
            <div className="summary-bar">
              {counts.critical > 0 && <span className="summary-chip violated">{counts.critical} Critical</span>}
              {counts.major > 0 && <span className="summary-chip partial">{counts.major} Major</span>}
              {counts.minor > 0 && <span className="summary-chip obeyed">{counts.minor} Minor</span>}
            </div>
          )}

          {(liveJson || parsed)?.violations?.length > 0 && (
            <section className="card">
              <label className="label">Violations</label>
              <div className="violation-list">
                {(liveJson || parsed).violations.map((v, i) => (
                  <div key={i} className={`violation-card sev-${(v.severity || '').toLowerCase()}`}>
                    <div className="violation-header">
                      <span className="violation-num">{i + 1}</span>
                      <span className="violation-rule">{v.rule}</span>
                      <span className={`status-badge ${(v.severity || '').toLowerCase()}`}>{v.severity}</span>
                    </div>
                    {v.instruction && (
                      <div className="violation-row">
                        <span className="vrow-label">Instruction</span>
                        <span className="vrow-value vrow-instruction">{v.instruction}</span>
                      </div>
                    )}
                    {v.evidence && (
                      <div className="violation-row">
                        <span className="vrow-label">Evidence</span>
                        <span className="vrow-value vrow-evidence">
                          {Array.isArray(v.evidence)
                            ? v.evidence.map((e, ei) => (
                                <div key={ei} className="evidence-item">
                                  {e.timestamp && <span className="evidence-ts">{e.timestamp}</span>}
                                  <span className="evidence-quote">&ldquo;{e.quote}&rdquo;</span>
                                </div>
                              ))
                            : v.evidence}
                        </span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {(liveJson || parsed)?.checklist?.length > 0 && (
            <section className="card">
              <div className="checklist-header">
                <label className="label">Compliance Checklist</label>
                {checklistCounts && (
                  <div className="checklist-score">
                    {checklistCounts.obeyed > 0 && <span className="summary-chip obeyed">{checklistCounts.obeyed} Obeyed</span>}
                    {checklistCounts.partial > 0 && <span className="summary-chip partial">{checklistCounts.partial} Partial</span>}
                    {checklistCounts.violated > 0 && <span className="summary-chip violated">{checklistCounts.violated} Violated</span>}
                  </div>
                )}
              </div>
              <div className="table-wrap">
                <table className="checklist-table">
                  <thead>
                    <tr>
                      <th>Rule</th>
                      <th>Status</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(liveJson || parsed).checklist.map((r, i) => (
                      <tr key={i} className={`row-${(r.status || '').toLowerCase()}`}>
                        <td className="ccol-rule">{r.rule}</td>
                        <td className="col-status">
                          <span className={`status-badge ${(r.status || '').toLowerCase()}`}>{r.status}</span>
                        </td>
                        <td className="ccol-evidence">{r.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <section className="card">
            <div className="label-row">
              <label className="label">Edit Evaluation JSON before sending to Fixer</label>
              <div style={{display: 'flex', gap: 8, alignItems: 'center'}}>
                <span style={{fontSize: 12, color: 'var(--gray-500)'}}>Remove violation #</span>
                <input
                  type="number"
                  min="1"
                  className="remove-violation-input"
                  placeholder="e.g. 5"
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      const n = parseInt(e.target.value)
                      if (!n) return
                      if (removeViolation(n)) e.target.value = ''
                    }
                  }}
                />
                <button className="copy-btn" onClick={e => {
                  const input = e.target.previousSibling
                  const n = parseInt(input.value)
                  if (!n) return
                  if (removeViolation(n)) input.value = ''
                }}>Remove</button>
              </div>
            </div>
            {jsonEditError && <div className="error" style={{marginBottom: 8}}>{jsonEditError}</div>}
            <textarea
              className="prompt-area mono"
              value={editableJson}
              onChange={e => { setEditableJson(e.target.value); setJsonEditError('') }}
              rows={12}
              spellCheck={false}
            />
            <div style={{marginTop: 12}}>
              <button className="evaluate-btn fixer-btn" onClick={sendToFixer}>
                Send to Fixer →
              </button>
            </div>
          </section>
        </>
      )}
    </>
  )
}
