import { useState } from 'react'
import './App.css'
import TeamSessionDashboard from './views/TeamSessionDashboard.jsx'
import OpponentDossier from './views/OpponentDossier.jsx'
import PlayerWellbeing from './views/PlayerWellbeing.jsx'
import CorrelationExplorer from './views/CorrelationExplorer.jsx'
import DataEntry from './views/DataEntry.jsx'
import SleepDebtAnalysis from './views/SleepDebtAnalysis.jsx'
import IndividualPlayerPerformance from './views/IndividualPlayerPerformance.jsx'
import Interventions from './views/Interventions.jsx'
import WinConditions from './views/WinConditions.jsx'
import GamePrep from './views/GamePrep.jsx'

const TABS = [
  { key: 'sessions', label: 'Team Session Dashboard' },
  { key: 'opponents', label: 'Opponent Dossier' },
  { key: 'wellbeing', label: 'Player Wellbeing' },
  { key: 'correlation', label: 'Correlation Explorer' },
  { key: 'entry', label: 'Data Entry' },
  { key: 'sleepDebt', label: 'Sleep Debt Analysis' },
  { key: 'individualPerf', label: 'Player Performance Dashboard' },
  { key: 'winConditions', label: 'Win Conditions' },
  { key: 'gamePrep', label: 'Game Prep (Trial)' },
  { key: 'interventions', label: 'Pre-Official Interventions' },
]

function App() {
  const [activeTab, setActiveTab] = useState('sessions')

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <span className="org">SENTINELS LCS</span>
          <span className="sub">Performance &amp; Intelligence Hub</span>
        </div>
        <div className="sub" style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          2026 Summer Split
        </div>
      </header>

      <nav className="tab-bar">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <main>
        {activeTab === 'sessions' && <TeamSessionDashboard />}
        {activeTab === 'opponents' && <OpponentDossier />}
        {activeTab === 'wellbeing' && <PlayerWellbeing />}
        {activeTab === 'correlation' && <CorrelationExplorer />}
        {activeTab === 'entry' && <DataEntry />}
        {activeTab === 'sleepDebt' && <SleepDebtAnalysis />}
        {activeTab === 'individualPerf' && <IndividualPlayerPerformance />}
        {activeTab === 'winConditions' && <WinConditions />}
        {activeTab === 'gamePrep' && <GamePrep />}
        {activeTab === 'interventions' && <Interventions />}
      </main>
    </>
  )
}

export default App
