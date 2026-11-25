import { useSearchParams } from 'react-router-dom'
import { ShieldAlert, ClipboardList } from 'lucide-react'
import Anomalies from './Anomalies'
import MaintenanceTasks from './MaintenanceTasks'

const TABS = [
  { id: 'anomalies', label: 'Anomalies', icon: ShieldAlert },
  { id: 'tasks', label: 'Maintenance tasks', icon: ClipboardList },
]

// Maintenance = find problems (anomalies) + act on them (tasks). The tab is kept in the URL (?tab=…).
export default function Maintenance() {
  const [params, setParams] = useSearchParams()
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'anomalies'

  return (
    <div className="maintenance">
      <div className="tabs page-tabs" role="tablist">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''}
            onClick={() => setParams(id === 'anomalies' ? {} : { tab: id })}>
            <Icon size={15} /> {label}
          </button>
        ))}
      </div>
      {tab === 'anomalies' ? <Anomalies /> : <MaintenanceTasks />}
    </div>
  )
}
