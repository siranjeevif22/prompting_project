import { useState, useEffect } from 'react'
import { API, stripSentinels, extractResult, extractUsage, streamFetch, calcCost, fmtCost } from '../lib/streamParse'
import * as Diff from 'diff'
import * as Diff2Html from 'diff2html'
import 'diff2html/bundles/css/diff2html.min.css'

export default function FixerTab({ prompt, lastEvaluationJson, lastEvaluatorPrompt, setLastFixedPrompt, switchTab }) {
  const [oldPrompt, setOldPrompt] = useState('')
  const [evalJson, setEvalJson] = useState('')
  const [rawOutput, setRawOutput] = useState('')
  const [fixedPrompt, setFixedPrompt] = useState('')
  const [usage, setUsage] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (lastEvaluationJson && !evalJson) {
      setEvalJson(JSON.stringify(lastEvaluationJson, null, 2))
    }
  }, [lastEvaluationJson])

  useEffect(() => {
    if (lastEvaluatorPrompt) setOldPrompt(lastEvaluatorPrompt)
  }, [lastEvaluatorPrompt])

  async function handleFileUpload(e, setter) {
    const f = e.target.files[0]
    if (!f) return
    const text = await f.text()
    setter(text)
  }

  async function handleFix() {
    if (!oldPrompt.trim()) { setError('Old system prompt is empty'); return }
    if (!evalJson.trim()) { setError('Evaluation results JSON is empty'); return }

    setError('')
    setLoading(true)
    setRawOutput('')
    setFixedPrompt('')
    setUsage(null)

    const fd = new FormData()
    fd.append('old_prompt', oldPrompt)
    fd.append('evaluation_results', evalJson)

    try {
      const accumulated = await streamFetch(`${API}/fix`, fd, {
        onChunk: (acc) => setRawOutput(stripSentinels(acc)),
      })
      const u = extractUsage(accumulated)
      if (u) setUsage(u)
      const r = extractResult(accumulated)
      const finalText = r?.fixed_prompt || stripSentinels(accumulated)
      setFixedPrompt(finalText)
      setLastFixedPrompt(finalText)
      const fd2 = new FormData()
      fd2.append('payload', finalText)
      fetch(`${API}/db/prompt`, { method: 'POST', body: fd2 }).catch(() => {})
    } catch (e) {
      setError(`Fix failed: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      {error && <div className="error">{error}</div>}

      <section className="card">
        <div className="label-row">
          <label className="label">Old System Prompt (to be fixed)</label>
          <label className="file-btn small">
            Load .txt
            <input type="file" accept=".txt,text/plain" onChange={e => handleFileUpload(e, setOldPrompt)} />
          </label>
        </div>
        <textarea
          className="prompt-area"
          value={oldPrompt}
          onChange={e => setOldPrompt(e.target.value)}
          rows={12}
          spellCheck={false}
          placeholder="Paste old system prompt here (or load .txt)"
        />
      </section>

      <section className="card">
        <div className="label-row">
          <label className="label">Evaluation Results JSON</label>
          <label className="file-btn small">
            Load .json
            <input type="file" accept=".json,application/json" onChange={e => handleFileUpload(e, setEvalJson)} />
          </label>
        </div>
        <textarea
          className="prompt-area mono"
          value={evalJson}
          onChange={e => setEvalJson(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder='{"violations": [...]}'
        />
      </section>

      <button className="evaluate-btn fixer-btn" onClick={handleFix} disabled={loading}>
        {loading ? 'Fixing...' : 'Fix Prompt'}
      </button>

      {!loading && usage && (
        <div className="usage-bar">
          {usage.model && <span className="usage-chip model-chip">{usage.model}</span>}
          <span className="usage-chip">In: <strong>{usage.input_tokens.toLocaleString()}</strong></span>
          <span className="usage-chip">Out: <strong>{usage.output_tokens.toLocaleString()}</strong></span>
          <span className="usage-chip">Total: <strong>{(usage.input_tokens + usage.output_tokens).toLocaleString()} tokens</strong></span>
          {fmtCost(calcCost(usage.model, usage.input_tokens, usage.output_tokens)) && (
            <span className="usage-chip cost-chip">Cost: <strong>{fmtCost(calcCost(usage.model, usage.input_tokens, usage.output_tokens))}</strong></span>
          )}
        </div>
      )}

      {loading && (
        <section className="card">
          <div className="streaming-indicator">
            <span className="pulse-dot" />
            <label className="label" style={{margin: 0}}>Streaming repaired prompt...</label>
          </div>
          <pre className="output-pre">{rawOutput}</pre>
        </section>
      )}

      {!loading && fixedPrompt && (
        <section className="card">
          <div className="label-row">
            <label className="label">Fixed System Prompt</label>
            <div style={{display: 'flex', gap: 8}}>
              <button className="copy-btn" onClick={() => {
                navigator.clipboard.writeText(fixedPrompt).then(() => {
                  setCopied(true); setTimeout(() => setCopied(false), 1500)
                })
              }}>{copied ? 'Copied' : 'Copy'}</button>
              <button className="copy-btn" onClick={() => switchTab('runner')}>Send to Runner →</button>
            </div>
          </div>
          <pre className="output-pre">{fixedPrompt}</pre>
        </section>
      )}

      {!loading && fixedPrompt && (
        <section className="card" style={{overflow: 'hidden', padding: '16px 0 0'}}>
          <label className="label" style={{padding: '0 24px 12px'}}>Diff — Old vs Fixed</label>
          <div
            className="diff-wrap"
            dangerouslySetInnerHTML={{
              __html: Diff2Html.html(
                Diff.createTwoFilesPatch('Old Prompt', 'Fixed Prompt', oldPrompt, fixedPrompt, '', '', { context: 5 }),
                { outputFormat: 'side-by-side', matching: 'words', diffStyle: 'word', drawFileList: false, renderNothingWhenEmpty: false }
              )
            }}
          />
          <div style={{padding: '16px 24px'}}>
            <button className="evaluate-btn runner-btn" onClick={() => switchTab('runner')}>
              Send to Runner →
            </button>
          </div>
        </section>
      )}
    </>
  )
}
