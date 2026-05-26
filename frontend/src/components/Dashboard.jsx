import { useState, useEffect } from 'react'
import { API } from '../lib/streamParse'

export default function Dashboard() {
  const [open, setOpen] = useState(false)
  const [files, setFiles] = useState([])
  const [dbExpanded, setDbExpanded] = useState(true)
  const [viewing, setViewing] = useState(null)

  function refresh() {
    fetch(`${API}/db/list`)
      .then(r => r.json())
      .then(d => setFiles(d.files || []))
      .catch(() => {})
  }

  useEffect(() => {
    if (open) refresh()
  }, [open])

  async function viewFile(name) {
    if (viewing?.name === name) { setViewing(null); return }
    const r = await fetch(`${API}/db/file/${encodeURIComponent(name)}`)
    const d = await r.json()
    setViewing(d)
  }

  function fileIcon(name) {
    if (name.startsWith('mistakes')) return '🔍'
    if (name.startsWith('prompt')) return '📝'
    if (name.startsWith('transcript')) return '💬'
    return '📄'
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`
    return `${(bytes / 1024).toFixed(1)}KB`
  }

  return (
    <>
      <button className="db-toggle-btn" onClick={() => setOpen(p => !p)} title="Database">
        <span className="db-toggle-icon">🗄</span>
      </button>

      {open && <div className="db-overlay" onClick={() => setOpen(false)} />}

      <div className={`db-drawer ${open ? 'open' : ''}`}>
        <div className="db-drawer-header">
          <span className="db-drawer-title">Local DB</span>
          <button className="db-close-btn" onClick={() => setOpen(false)}>✕</button>
        </div>

        <div className="db-tree">
          <div className="db-folder" onClick={() => setDbExpanded(p => !p)}>
            <span className="db-folder-icon">{dbExpanded ? '📂' : '📁'}</span>
            <span className="db-folder-name">db</span>
            <span className="db-file-count">{files.length}</span>
            <button className="db-refresh-btn" onClick={e => { e.stopPropagation(); refresh() }} title="Refresh">↻</button>
          </div>

          {dbExpanded && (
            <div className="db-file-list">
              {files.length === 0 && (
                <div className="db-empty">No files yet</div>
              )}
              {files.map(f => (
                <div key={f.name} className="db-file-item">
                  <div
                    className={`db-file-row ${viewing?.name === f.name ? 'active' : ''}`}
                    onClick={() => viewFile(f.name)}
                  >
                    <span className="db-file-icon">{fileIcon(f.name)}</span>
                    <span className="db-file-name">{f.name}</span>
                    <span className="db-file-size">{formatSize(f.size)}</span>
                  </div>
                  {viewing?.name === f.name && (
                    <pre className="db-file-preview">{viewing.content}</pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
