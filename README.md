# Sentinels LCS Coaching Hub

A monitoring and intelligence hub for the Sentinels LCS performance programme (League of Legends, LCS 2026 Summer Split). It gives the coaching staff a single dashboard for team session results, opponent scouting intel, per-player wellbeing tracking, and correlation analysis between sleep/vibe/goal-scores and win rate — reading live from the programme's Supabase database. It also includes simple data-entry forms so staff can log new scrim/official sessions and daily player check-ins directly from the app.

## Local development

```
npm install
npm run dev
```

The app expects a `.env` file (already included) with:

```
VITE_SUPABASE_URL=https://xzfoingmkgwxsjvmwdum.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_XBLWEYHJWo5cHFjn4xP26w_I6-P6nYy
```

These are public anon/publishable keys — safe to commit, since Supabase Row Level Security policies control what they can actually read/write.

## Deploying

1. `git init`
2. Create a new GitHub repo named `sentinels-lol-coaching` via [github.com/new](https://github.com/new), or with the GitHub CLI:
   ```
   gh repo create sentinels-lol-coaching --public --source=. --remote=origin
   ```
3. `git remote add origin <repo-url>` (skip if you used `gh repo create` above — it sets the remote for you)
4. `git push -u origin main`
5. In Netlify:
   - "Add new site" → "Import an existing project" → connect the GitHub repo
   - Build command: `npm run build`
   - Publish directory: `dist`
   - Add environment variables `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (values above) under Site settings → Environment variables
   - Deploy

Note: this app uses simple tab-state for navigation instead of client-side routing (no react-router), so no SPA redirect rule / `netlify.toml` is required.

## Tech stack

- React + Vite
- `@supabase/supabase-js` for data access
- `recharts` for charts
- Plain CSS (`src/App.css`) — dark, functional, esports-coaching aesthetic
