import { useState, useEffect } from 'react'
import { API } from './lib/streamParse'
import EvaluatorTab from './tabs/EvaluatorTab'
import FixerTab from './tabs/FixerTab'
import RunnerTab from './tabs/RunnerTab'
import Dashboard from './components/Dashboard'

export default function App() {
  const [activeTab, setActiveTab] = useState('evaluator')
  const [prompt, setPrompt] = useState('')
  const [bootError, setBootError] = useState('')

  const [lastEvaluationJson, setLastEvaluationJson] = useState(null)
  const [lastEvaluatorPrompt, setLastEvaluatorPrompt] = useState('')
  const [lastFixedPrompt, setLastFixedPrompt] = useState('')
  const [lastRunnerAgentPrompt, setLastRunnerAgentPrompt] = useState('')
  const [lastTranscript, setLastTranscript] = useState(null)

  useEffect(() => {
    fetch(`${API}/prompt`)
      .then(r => r.json())
      .then(d => setPrompt(d.prompt))
      .catch(() => setBootError('Could not load prompt.txt — is backend running on :8000?'))
  }, [])

  function switchTab(t) {
    setActiveTab(t)
  }

  return (
    <div className="app">
      <Dashboard />
      <header>
        <h1>Prompt Evaluator</h1>
        <p className="subtitle">Evaluate → Fix → Run → Loop</p>
      </header>

      <div className="tab-bar">
        <button
          className={`tab-btn ${activeTab === 'evaluator' ? 'active' : ''}`}
          onClick={() => setActiveTab('evaluator')}
        >
          1. Evaluator
          {lastEvaluationJson && <span className="tab-dot" />}
        </button>
        <button
          className={`tab-btn ${activeTab === 'fixer' ? 'active' : ''}`}
          onClick={() => setActiveTab('fixer')}
        >
          2. Fixer
          {lastFixedPrompt && <span className="tab-dot" />}
        </button>
        <button
          className={`tab-btn ${activeTab === 'runner' ? 'active' : ''}`}
          onClick={() => setActiveTab('runner')}
        >
          3. Runner
          {lastTranscript && <span className="tab-dot" />}
        </button>
      </div>

      {bootError && <div className="error">{bootError}</div>}

      {activeTab === 'evaluator' && (
        <EvaluatorTab
          prompt={lastFixedPrompt || prompt}
          setPrompt={setPrompt}
          lastTranscript={lastTranscript}
          setLastEvaluationJson={setLastEvaluationJson}
          setLastEvaluatorPrompt={setLastEvaluatorPrompt}
          lastRunnerAgentPrompt={lastRunnerAgentPrompt}
          switchTab={switchTab}
        />
      )}
      {activeTab === 'fixer' && (
        <FixerTab
          prompt={prompt}
          lastEvaluationJson={lastEvaluationJson}
          lastEvaluatorPrompt={lastEvaluatorPrompt}
          setLastFixedPrompt={setLastFixedPrompt}
          switchTab={switchTab}
        />
      )}
      {activeTab === 'runner' && (
        <RunnerTab
          lastFixedPrompt={lastFixedPrompt}
          setLastTranscript={setLastTranscript}
          setLastRunnerAgentPrompt={setLastRunnerAgentPrompt}
          switchTab={switchTab}
        />
      )}
    </div>
  )
}
