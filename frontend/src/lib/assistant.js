// "Ask RenewX" chat. The backend adds the app/project guides + a snapshot of the selected plant and asks the LLM
// (Gemini free tier). Issue reports are saved by the browser in support_reports (009_support_reports.sql).
import { supabase } from './supabaseClient'
import { API_URL } from './api'

async function call(method, path, body) {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) return { error: 'Your session has expired. Please sign in again.' }
  let res
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body && { 'Content-Type': 'application/json' }) },
      body: body ? JSON.stringify(body) : undefined,
    })
  } catch {
    return { error: 'Could not reach the RenewX backend. Make sure it is running.' }
  }
  const json = await res.json().catch(() => ({}))
  if (!res.ok) return { error: typeof json.detail === 'string' ? json.detail : 'The assistant could not answer right now.' }
  return { result: json }
}

export const assistantStatus = () => call('GET', '/assistant/status')
export const askAssistant = (plantId, messages) => call('POST', '/assistant/chat', { plant_id: plantId ?? null, messages })
export const draftIssue = (plantId, messages) => call('POST', '/assistant/issue-draft', { plant_id: plantId ?? null, messages })

export async function submitIssue({ plantId, category, title, description, page, conversation }) {
  const { error } = await supabase.from('support_reports').insert({
    plant_id: plantId ?? null, category, title: title.trim(), description: description.trim(),
    page, conversation: conversation.slice(-20),
  })
  if (error) return { error: error.message.includes('support_reports') ? 'Run 009_support_reports.sql in Supabase first.' : error.message }
  return {}
}
