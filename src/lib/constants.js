// Shared constants for the Sentinels LCS coaching hub.

export const ROSTER_PLAYERS = ['Impact', 'HamBak', 'DARKWINGS', 'Huhi', 'Rahel']

export const SESSION_TYPES = ['Green', 'Orange', 'Red', 'Official']

export const RESULTS = ['Win', 'Loss']

export const READINESS_SESSION_TYPES = ['Red', 'Official']

export const OPPONENT_TIERS = [1, 2, 3, 4, 5]

// The ~24 boolean habit columns tracked on daily_entries, grouped for display.
export const HABIT_GROUPS = {
  FOUNDATION: [
    { key: 'sleep_7_30', label: 'Sleep 7:30+' },
    { key: 'balanced_meals', label: 'Balanced Meals' },
    { key: 'daily_movement', label: 'Daily Movement (5k steps)' },
    { key: 'reset_breathing', label: 'Reset Breathing' },
    { key: 'water', label: 'Water' },
  ],
  COGNITIVE: [
    { key: 'mindfulness', label: 'Mindfulness' },
    { key: 'eye_care', label: 'Eye Care' },
    { key: 'blue_light_mgmt', label: 'Blue Light Mgmt' },
    { key: 'cognitive_cooldown', label: 'Cognitive Cooldown' },
    { key: 'creatine', label: 'Creatine' },
  ],
  PHYSICAL: [
    { key: 'strength_training', label: 'Strength Training' },
    { key: 'mobility_stretch', label: 'Mobility / Stretch' },
    { key: 'posture_resets', label: 'Posture Resets' },
    { key: 'wrist_prehab', label: 'Wrist / Forearm Prehab' },
  ],
  LIFESTYLE: [
    { key: 'social_time', label: 'Social Time' },
    { key: 'outdoor_time', label: 'Outdoor Time' },
    { key: 'creative', label: 'Creative' },
    { key: 'hot_tub_sauna', label: 'Hot Tub / Sauna' },
    { key: 'gratitude_journaling', label: 'Gratitude / Journaling' },
  ],
  BREATHING: [
    { key: 'breathing_pre_training', label: 'Pre-Training' },
    { key: 'breathing_game_1', label: 'Game 1' },
    { key: 'breathing_game_2', label: 'Game 2' },
    { key: 'breathing_game_3', label: 'Game 3' },
    { key: 'breathing_game_4', label: 'Game 4' },
    { key: 'breathing_game_5', label: 'Game 5' },
    { key: 'breathing_game_6', label: 'Game 6' },
    { key: 'breathing_post_training', label: 'Post-Training' },
  ],
}

// Flat list of all boolean habit keys (used for overall completion rate).
export const ALL_HABIT_KEYS = Object.values(HABIT_GROUPS).flat().map((h) => h.key)

// Breathing-specific keys, called out separately because compliance is a known gap.
export const BREATHING_KEYS = HABIT_GROUPS.BREATHING.map((h) => h.key)

export const SLEEP_BUCKETS = [
  { label: '<6.5h', min: -Infinity, max: 6.5 },
  { label: '6.5-7h', min: 6.5, max: 7 },
  { label: '7-7.5h', min: 7, max: 7.5 },
  { label: '7.5h+', min: 7.5, max: Infinity },
]

export const VIBE_BUCKETS = [
  { label: '1-3', min: 1, max: 3 },
  { label: '4-5', min: 4, max: 5 },
  { label: '6-7', min: 6, max: 7 },
  { label: '8-10', min: 8, max: 10 },
]

export const GOAL_SCORE_BUCKETS = [
  { label: '0-3', min: 0, max: 3 },
  { label: '3-5', min: 3, max: 5 },
  { label: '5-7', min: 5, max: 7 },
  { label: '7-10', min: 7, max: 10 },
]

export function bucketize(value, buckets) {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  for (const b of buckets) {
    if (value >= b.min && value < b.max) return b.label
  }
  // Catch the top edge (e.g. exactly max of last bucket)
  const last = buckets[buckets.length - 1]
  if (value >= last.min) return last.label
  return null
}

export function formatDate(dateStr) {
  if (!dateStr) return '—'
  try {
    const d = new Date(dateStr)
    if (Number.isNaN(d.getTime())) return dateStr
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
  } catch {
    return dateStr
  }
}

export function average(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && !Number.isNaN(n))
  if (valid.length === 0) return null
  return valid.reduce((a, b) => a + b, 0) / valid.length
}

// 3-night rolling-average sleep-debt bands (research doc thresholds).
// Distinct from SLEEP_BUCKETS above, which buckets same-night team_avg_sleep_hours.
export const SLEEP_DEBT_BANDS = [
  { label: '<6.0h (severe)', min: -Infinity, max: 6.0, color: '#b23b3b' },
  { label: '6.0-6.5h (significant)', min: 6.0, max: 6.5, color: '#e0524a' },
  { label: '6.5-7.0h (moderate)', min: 6.5, max: 7.0, color: '#e0a940' },
  { label: '7.0-7.5h (minor)', min: 7.0, max: 7.5, color: '#cbb23a' },
  { label: '7.5h+ (optimal)', min: 7.5, max: Infinity, color: '#3aa76d' },
]

export function sleepDebtColor(hours) {
  if (hours == null || Number.isNaN(hours)) return '#5a606c'
  for (const b of SLEEP_DEBT_BANDS) {
    if (hours >= b.min && hours < b.max) return b.color
  }
  return SLEEP_DEBT_BANDS[SLEEP_DEBT_BANDS.length - 1].color
}

// Hard-gate / isolated-disruption thresholds, per the research addendum.
export const HARD_GATE_HOURS = 5.0
export const ISOLATED_DISRUPTION_HOURS = 6.5
export const ISOLATED_DISRUPTION_ROLLING_FLOOR = 7.0
// A gap of more than this many calendar days between two logged nights means the
// rolling average spans a stale window and should be visually/textually flagged.
export const ROLLING_WINDOW_GAP_DAYS = 4
