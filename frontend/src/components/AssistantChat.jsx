import { Fragment, useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { Bot, Send, X, Flag, Sparkles, Loader2 } from 'lucide-react'
import { usePlants } from '../context/PlantContext'
import { askAssistant, draftIssue, submitIssue } from '../lib/assistant'

const SUGGESTIONS = [
  'Should I clean my panels this week?',
  'Why was output lower than expected recently?',
  'What does the cleaning score mean?',
  'How do I upload daily data?',
  'What tech stack does RenewX use?',
]
const CATEGORIES = { bug: 'Bug', data: 'Data problem', question: 'Question', feature: 'Feature idea', other: 'Other' }

// Minimal, safe formatting for model replies: paragraphs, "- " bullets and **bold** (no HTML injection).
function Bold({ text }) {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>)
}
function Reply({ text }) {
  const blocks = []
  for (const line of text.split('\n')) {
    const bullet = line.match(/^\s*[-*•]\s+(.*)/)
    if (bullet) {
      const last = blocks.at(-1)
      if (last?.type === 'ul') last.items.push(bullet[1])
      else blocks.push({ type: 'ul', items: [bullet[1]] })
    } else if (line.trim()) blocks.push({ type: 'p', text: line.replace(/^#+\s*/, '') })
  }
  return blocks.map((b, i) => (b.type === 'ul'
    ? <ul key={i}>{b.items.map((t, j) => <li key={j}><Bold text={t} /></li>)}</ul>
    : <p key={i}><Bold text={b.text} /></p>))
}

function IssueForm({ draft, busy, onCancel, onSubmit }) {
  const [form, setForm] = useState(draft)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <form className="chat-issue" onSubmit={(e) => { e.preventDefault(); onSubmit(form) }}>
      <strong><Flag size={14} /> Report an issue</strong>
      <p className="hint">Drafted from this chat – check and edit before sending. The team will see it.</p>
      <select value={form.category} onChange={set('category')} disabled={busy}>
        {Object.entries(CATEGORIES).map(([v, t]) => <option key={v} value={v}>{t}</option>)}
      </select>
      <input value={form.title} onChange={set('title')} maxLength={120} placeholder="Short title" disabled={busy} />
      <textarea rows={5} value={form.description} onChange={set('description')} maxLength={2000} placeholder="What happened?" disabled={busy} />
      <div className="chat-issue-actions">
        <button type="button" className="btn sm" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="btn sm primary" disabled={busy || !form.title.trim() || !form.description.trim()}>Send report</button>
      </div>
    </form>
  )
}

/** Floating "Ask RenewX" chat, available on every page. */
export default function AssistantChat() {
  const { activePlant } = usePlants()
  const location = useLocation()
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])     // { role: 'user'|'assistant', content }
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [issue, setIssue] = useState(null)          // draft being edited
  const endRef = useRef(null)

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages, busy, issue, open])

  async function send(text) {
    const q = text.trim()
    if (!q || busy) return
    const next = [...messages, { role: 'user', content: q }]
    setMessages(next)
    setInput('')
    setError('')
    setBusy(true)
    const res = await askAssistant(activePlant?.id, next)
    setBusy(false)
    if (res.error) return setError(res.error)
    setMessages([...next, { role: 'assistant', content: res.result.reply }])
  }

  async function startIssue() {
    setError('')
    if (!messages.length) return setIssue({ category: 'bug', title: '', description: '' })
    setBusy(true)
    const res = await draftIssue(activePlant?.id, messages)
    setBusy(false)
    setIssue(res.error ? { category: 'bug', title: '', description: '' } : res.result)
  }

  async function sendIssue(form) {
    setBusy(true)
    const res = await submitIssue({ ...form, plantId: activePlant?.id, page: location.pathname, conversation: messages })
    setBusy(false)
    if (res.error) return setError(res.error)
    setIssue(null)
    setMessages((m) => [...m, { role: 'assistant', content: `Thanks – your report “${form.title}” was sent to the team.` }])
  }

  if (!open) {
    return (
      <button className="chat-fab" onClick={() => setOpen(true)} aria-label="Ask RenewX">
        <Bot size={22} /> <span>Ask RenewX</span>
      </button>
    )
  }

  return (
    <section className="chat-panel" role="dialog" aria-label="Ask RenewX assistant">
      <header className="chat-head">
        <span className="chat-avatar"><Sparkles size={16} /></span>
        <div>
          <strong>Ask RenewX</strong>
          <small>{activePlant ? `About ${activePlant.name}` : 'No plant selected'} · AI answers can be imperfect</small>
        </div>
        <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Close chat"><X size={18} /></button>
      </header>

      <div className="chat-body">
        {messages.length === 0 && (
          <div className="chat-welcome">
            <p>Hi! I can explain the app, answer questions about your plant’s data, help with problems and explain how RenewX is built.</p>
            <div className="chat-suggestions">
              {SUGGESTIONS.map((s) => <button key={s} onClick={() => send(s)} disabled={busy}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.role === 'assistant' ? <Reply text={m.content} /> : <p>{m.content}</p>}
          </div>
        ))}
        {busy && <div className="chat-msg assistant typing"><Loader2 size={15} className="spin" /> Thinking…</div>}
        {error && <p className="msg error">{error}</p>}
        {issue && <IssueForm draft={issue} busy={busy} onCancel={() => setIssue(null)} onSubmit={sendIssue} />}
        <div ref={endRef} />
      </div>

      <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(input) }}>
        <textarea rows={1} value={input} onChange={(e) => setInput(e.target.value)} maxLength={2000}
          placeholder="Ask about your plant or the app…" disabled={busy || Boolean(issue)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input) } }} />
        <button type="submit" className="btn primary sm" disabled={busy || !input.trim() || Boolean(issue)} aria-label="Send"><Send size={15} /></button>
      </form>
      <footer className="chat-foot">
        <button onClick={startIssue} disabled={busy || Boolean(issue)}><Flag size={13} /> Report an issue</button>
        {messages.length > 0 && <button onClick={() => { setMessages([]); setError(''); setIssue(null) }} disabled={busy}>New chat</button>}
      </footer>
    </section>
  )
}
