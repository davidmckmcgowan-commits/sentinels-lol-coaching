import { useState } from 'react'
import { supabase } from '../lib/supabaseClient.js'
import { ROSTER_PLAYERS, SESSION_TYPES, RESULTS, OPPONENT_TIERS, HABIT_GROUPS } from '../lib/constants.js'

const emptySession = {
  session_type: '',
  opponent: '',
  opponent_tier: '',
  tier_label: '',
  session_date: '',
  result: '',
  team_avg_sleep_hours: '',
  impact_sleep_hours: '',
  hambak_sleep_hours: '',
  darkwings_sleep_hours: '',
  huhi_sleep_hours: '',
  rahel_sleep_hours: '',
  goal1_score: '',
  goal2_score: '',
  goal3_score: '',
  goal1_name: '',
  goal2_name: '',
  goal3_name: '',
}

const emptyDaily = {
  player: '',
  entry_date: '',
  vibe_check: '',
  reflection_well: '',
  reflection_improve: '',
  team_played: '',
}

function initHabits() {
  const h = {}
  for (const group of Object.values(HABIT_GROUPS)) {
    for (const item of group) h[item.key] = false
  }
  return h
}

function Toast({ status, message }) {
  if (!status) return null
  return <div className={`toast ${status}`}>{message}</div>
}

function numOrNull(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

export default function DataEntry() {
  const [formMode, setFormMode] = useState('session') // 'session' | 'daily'

  // Session form state
  const [sessionForm, setSessionForm] = useState(emptySession)
  const [sessionErrors, setSessionErrors] = useState({})
  const [sessionStatus, setSessionStatus] = useState(null)
  const [sessionMsg, setSessionMsg] = useState('')
  const [sessionSubmitting, setSessionSubmitting] = useState(false)

  // Daily entry form state
  const [dailyForm, setDailyForm] = useState(emptyDaily)
  const [habits, setHabits] = useState(initHabits())
  const [dailyErrors, setDailyErrors] = useState({})
  const [dailyStatus, setDailyStatus] = useState(null)
  const [dailyMsg, setDailyMsg] = useState('')
  const [dailySubmitting, setDailySubmitting] = useState(false)

  function updateSessionField(key, value) {
    setSessionForm((f) => ({ ...f, [key]: value }))
  }

  function updateDailyField(key, value) {
    setDailyForm((f) => ({ ...f, [key]: value }))
  }

  function toggleHabit(key) {
    setHabits((h) => ({ ...h, [key]: !h[key] }))
  }

  function validateSession() {
    const errs = {}
    if (!sessionForm.session_date) errs.session_date = 'Required'
    if (!sessionForm.session_type) errs.session_type = 'Required'
    if (!sessionForm.opponent.trim()) errs.opponent = 'Required'
    if (!sessionForm.result) errs.result = 'Required'
    if (!sessionForm.opponent_tier) errs.opponent_tier = 'Required'
    setSessionErrors(errs)
    return Object.keys(errs).length === 0
  }

  function validateDaily() {
    const errs = {}
    if (!dailyForm.player) errs.player = 'Required'
    if (!dailyForm.entry_date) errs.entry_date = 'Required'
    setDailyErrors(errs)
    return Object.keys(errs).length === 0
  }

  async function submitSession(e) {
    e.preventDefault()
    setSessionStatus(null)
    if (!validateSession()) return
    setSessionSubmitting(true)
    const payload = {
      session_type: sessionForm.session_type,
      opponent: sessionForm.opponent.trim(),
      opponent_tier: numOrNull(sessionForm.opponent_tier),
      tier_label: sessionForm.tier_label.trim() || null,
      session_date: sessionForm.session_date,
      result: sessionForm.result,
      team_avg_sleep_hours: numOrNull(sessionForm.team_avg_sleep_hours),
      impact_sleep_hours: numOrNull(sessionForm.impact_sleep_hours),
      hambak_sleep_hours: numOrNull(sessionForm.hambak_sleep_hours),
      darkwings_sleep_hours: numOrNull(sessionForm.darkwings_sleep_hours),
      huhi_sleep_hours: numOrNull(sessionForm.huhi_sleep_hours),
      rahel_sleep_hours: numOrNull(sessionForm.rahel_sleep_hours),
      goal1_score: numOrNull(sessionForm.goal1_score),
      goal2_score: numOrNull(sessionForm.goal2_score),
      goal3_score: numOrNull(sessionForm.goal3_score),
      goal1_name: sessionForm.goal1_name.trim() || null,
      goal2_name: sessionForm.goal2_name.trim() || null,
      goal3_name: sessionForm.goal3_name.trim() || null,
      win_value: sessionForm.result === 'Win' ? 5 : 0,
    }
    const { error } = await supabase.from('sessions').insert(payload)
    setSessionSubmitting(false)
    if (error) {
      setSessionStatus('error')
      setSessionMsg(`Insert failed: ${error.message}`)
    } else {
      setSessionStatus('success')
      setSessionMsg('Session logged successfully.')
      setSessionForm(emptySession)
      setSessionErrors({})
    }
  }

  async function submitDaily(e) {
    e.preventDefault()
    setDailyStatus(null)
    if (!validateDaily()) return
    setDailySubmitting(true)
    const payload = {
      player: dailyForm.player,
      entry_date: dailyForm.entry_date,
      vibe_check: numOrNull(dailyForm.vibe_check),
      reflection_well: dailyForm.reflection_well.trim() || null,
      reflection_improve: dailyForm.reflection_improve.trim() || null,
      team_played: dailyForm.team_played.trim() || null,
      ...habits,
    }
    const { error } = await supabase.from('daily_entries').insert(payload)
    setDailySubmitting(false)
    if (error) {
      setDailyStatus('error')
      setDailyMsg(`Insert failed: ${error.message}`)
    } else {
      setDailyStatus('success')
      setDailyMsg('Daily entry logged successfully.')
      setDailyForm(emptyDaily)
      setHabits(initHabits())
      setDailyErrors({})
    }
  }

  return (
    <div>
      <div className="panel entry-forms-toggle">
        <h2>Data Entry</h2>
        <p className="panel-caption">
          Data entry stays here for now; the app is otherwise read-only. Use the toggle to switch between
          logging a session and logging a daily habit/wellbeing entry.
        </p>
        <div className="toggle-group">
          <button type="button" className={formMode === 'session' ? 'active' : ''} onClick={() => setFormMode('session')}>
            Log a Session
          </button>
          <button type="button" className={formMode === 'daily' ? 'active' : ''} onClick={() => setFormMode('daily')}>
            Log a Daily Entry
          </button>
        </div>
      </div>

      {formMode === 'session' && (
        <form className="panel" onSubmit={submitSession}>
          <h2>Log a New Session</h2>
          <Toast status={sessionStatus} message={sessionMsg} />

          <div className="form-grid">
            <div className={`form-field ${sessionErrors.session_date ? 'error' : ''}`}>
              <label>Date *</label>
              <input type="date" value={sessionForm.session_date} onChange={(e) => updateSessionField('session_date', e.target.value)} />
              {sessionErrors.session_date && <span className="field-error-text">{sessionErrors.session_date}</span>}
            </div>

            <div className={`form-field ${sessionErrors.session_type ? 'error' : ''}`}>
              <label>Session Type *</label>
              <select value={sessionForm.session_type} onChange={(e) => updateSessionField('session_type', e.target.value)}>
                <option value="">Select…</option>
                {SESSION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {sessionErrors.session_type && <span className="field-error-text">{sessionErrors.session_type}</span>}
            </div>

            <div className={`form-field ${sessionErrors.result ? 'error' : ''}`}>
              <label>Result *</label>
              <select value={sessionForm.result} onChange={(e) => updateSessionField('result', e.target.value)}>
                <option value="">Select…</option>
                {RESULTS.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
              {sessionErrors.result && <span className="field-error-text">{sessionErrors.result}</span>}
            </div>

            <div className={`form-field ${sessionErrors.opponent ? 'error' : ''}`}>
              <label>Opponent *</label>
              <input type="text" placeholder="e.g. TL, C9, Lyon…" value={sessionForm.opponent} onChange={(e) => updateSessionField('opponent', e.target.value)} />
              {sessionErrors.opponent && <span className="field-error-text">{sessionErrors.opponent}</span>}
            </div>

            <div className={`form-field ${sessionErrors.opponent_tier ? 'error' : ''}`}>
              <label>Opponent Tier (1-5) *</label>
              <select value={sessionForm.opponent_tier} onChange={(e) => updateSessionField('opponent_tier', e.target.value)}>
                <option value="">Select…</option>
                {OPPONENT_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              {sessionErrors.opponent_tier && <span className="field-error-text">{sessionErrors.opponent_tier}</span>}
            </div>

            <div className="form-field">
              <label>Tier Label</label>
              <input type="text" placeholder="e.g. Upper, Middle…" value={sessionForm.tier_label} onChange={(e) => updateSessionField('tier_label', e.target.value)} />
            </div>

            <div className="form-field">
              <label>Team Avg Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.team_avg_sleep_hours} onChange={(e) => updateSessionField('team_avg_sleep_hours', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Impact Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.impact_sleep_hours} onChange={(e) => updateSessionField('impact_sleep_hours', e.target.value)} />
            </div>
            <div className="form-field">
              <label>HamBak Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.hambak_sleep_hours} onChange={(e) => updateSessionField('hambak_sleep_hours', e.target.value)} />
            </div>
            <div className="form-field">
              <label>DARKWINGS Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.darkwings_sleep_hours} onChange={(e) => updateSessionField('darkwings_sleep_hours', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Huhi Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.huhi_sleep_hours} onChange={(e) => updateSessionField('huhi_sleep_hours', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Rahel Sleep (hrs)</label>
              <input type="number" step="0.01" value={sessionForm.rahel_sleep_hours} onChange={(e) => updateSessionField('rahel_sleep_hours', e.target.value)} />
            </div>

            <div className="form-field">
              <label>Goal 1 Score (0-10)</label>
              <input type="number" step="0.1" min="0" max="10" value={sessionForm.goal1_score} onChange={(e) => updateSessionField('goal1_score', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Goal 1 Name</label>
              <input type="text" placeholder="e.g. stable early game" value={sessionForm.goal1_name} onChange={(e) => updateSessionField('goal1_name', e.target.value)} />
            </div>
            <div />

            <div className="form-field">
              <label>Goal 2 Score (0-10)</label>
              <input type="number" step="0.1" min="0" max="10" value={sessionForm.goal2_score} onChange={(e) => updateSessionField('goal2_score', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Goal 2 Name</label>
              <input type="text" placeholder="e.g. understanding tempo" value={sessionForm.goal2_name} onChange={(e) => updateSessionField('goal2_name', e.target.value)} />
            </div>
            <div />

            <div className="form-field">
              <label>Goal 3 Score (0-10)</label>
              <input type="number" step="0.1" min="0" max="10" value={sessionForm.goal3_score} onChange={(e) => updateSessionField('goal3_score', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Goal 3 Name</label>
              <input type="text" placeholder="e.g. objective set ups/fighting" value={sessionForm.goal3_name} onChange={(e) => updateSessionField('goal3_name', e.target.value)} />
            </div>
            <div />
          </div>

          <div className="submit-row">
            <button type="submit" className="primary" disabled={sessionSubmitting}>
              {sessionSubmitting ? 'Saving…' : 'Log Session'}
            </button>
          </div>
        </form>
      )}

      {formMode === 'daily' && (
        <form className="panel" onSubmit={submitDaily}>
          <h2>Log a New Daily Entry</h2>
          <Toast status={dailyStatus} message={dailyMsg} />

          <div className="form-grid cols-2">
            <div className={`form-field ${dailyErrors.player ? 'error' : ''}`}>
              <label>Player *</label>
              <select value={dailyForm.player} onChange={(e) => updateDailyField('player', e.target.value)}>
                <option value="">Select…</option>
                {ROSTER_PLAYERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              {dailyErrors.player && <span className="field-error-text">{dailyErrors.player}</span>}
            </div>
            <div className={`form-field ${dailyErrors.entry_date ? 'error' : ''}`}>
              <label>Date *</label>
              <input type="date" value={dailyForm.entry_date} onChange={(e) => updateDailyField('entry_date', e.target.value)} />
              {dailyErrors.entry_date && <span className="field-error-text">{dailyErrors.entry_date}</span>}
            </div>
            <div className="form-field">
              <label>Vibe Check (1-10)</label>
              <input type="number" min="1" max="10" step="1" value={dailyForm.vibe_check} onChange={(e) => updateDailyField('vibe_check', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Team Played (opponent that day)</label>
              <input type="text" value={dailyForm.team_played} onChange={(e) => updateDailyField('team_played', e.target.value)} />
            </div>
          </div>

          {Object.entries(HABIT_GROUPS).map(([groupName, items]) => (
            <div key={groupName}>
              <div className="habit-group-title">{groupName}</div>
              <div className="checkbox-grid">
                {items.map((item) => (
                  <label className="checkbox-item" key={item.key}>
                    <input type="checkbox" checked={habits[item.key]} onChange={() => toggleHabit(item.key)} />
                    {item.label}
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="form-grid cols-2" style={{ marginTop: 14 }}>
            <div className="form-field">
              <label>Reflection — something done well</label>
              <textarea value={dailyForm.reflection_well} onChange={(e) => updateDailyField('reflection_well', e.target.value)} />
            </div>
            <div className="form-field">
              <label>Reflection — something to improve</label>
              <textarea value={dailyForm.reflection_improve} onChange={(e) => updateDailyField('reflection_improve', e.target.value)} />
            </div>
          </div>

          <div className="submit-row">
            <button type="submit" className="primary" disabled={dailySubmitting}>
              {dailySubmitting ? 'Saving…' : 'Log Daily Entry'}
            </button>
          </div>
        </form>
      )}
    </div>
  )
}
