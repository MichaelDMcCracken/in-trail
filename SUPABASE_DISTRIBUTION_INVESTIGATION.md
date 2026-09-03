# Investigate Moving FAA Data Distribution to Supabase

## Scope and constraints
- This is an architecture investigation only.
- No runtime behavior, caching, or WebSocket implementation was modified.

## 1) Current architecture (code-verified)

### Data ingestion and processing on Render
- `backend/server.js` starts SWIM ingestion (`connectToSWIM()`) and FAA scraping refresh (`refreshRestrictions()`) on boot.
- `backend/src/swim.js` keeps a continuous SWIM connection, parses XML events, updates in-memory state, and broadcasts full snapshots to listeners.
- `backend/src/scraper.js` fetches FAA public data for:
  - Restrictions (`fetchRestrictions`)
  - Current reroutes (`fetchCurrentReroutes`)
  - NAS closures (`fetchNasClosures`)
  - Airport operations (`fetchAirportOperations`)
  - Ops plan (`fetchOpsPlan`)

### Refresh cadence and caching
- `refreshRestrictions()` runs at startup and then every **5 minutes** (`setInterval(..., 5 * 60 * 1000)`).
- Scraper uses file cache in `/tmp/faa-cache` with **5-minute TTL** (`CACHE_TTL_MS = 5 * 60 * 1000`).

### Snapshot construction and distribution
- Backend exposes `GET /api/state` returning `getSnapshot()`.
- WebSocket clients receive:
  - full `snapshot` immediately on connect
  - full `update` snapshots whenever state mutates
  - status events on SWIM connection changes
- Frontend (`frontend/src/App.jsx`) consumes backend via WebSocket and then does most display filtering/grouping/search in browser memory.

### Important update behavior detail
Inside one `refreshRestrictions()` pass, backend calls five setters (`setScrapedRestrictions`, `setCurrentReroutes`, `setNasClosures`, `setOpsPlan`, `setAirportOperations`), and **each setter broadcasts a full snapshot**.

That means baseline scrape-driven broadcast rate is:
- 5 snapshots every 5 minutes = **~1 full snapshot/minute/client**
- plus additional full-snapshot broadcasts from SWIM event changes

## 2) Snapshot size and measured constraints
- In this execution environment, FAA endpoints (`fly.faa.gov`, `nasstatus.faa.gov`) were DNS-blocked, so live payload pull/measurement could not be completed here.
- Using the observed production bandwidth shared in issue context plus the code’s full-snapshot broadcast behavior, practical snapshot size is best modeled as **~100–130 KB per full snapshot** (working value used below: **120 KB**).

## 3) Proposed architecture feasibility

Proposed flow:
FAA/SWIM → Render ingestion/processing → Supabase current-state table → Vercel frontend → Pilot browser

Feasibility assessment:
- **Render write every ~1 minute:** Yes (simple timed upsert of current snapshot JSON).
- **Frontend direct read from Supabase:** Yes (polling from public read-only table).
- **Pilot-specific filtering/calculation in browser:** Yes (already mostly client-side in `App.jsx`).
- **Eliminate/reduce WebSocket traffic:** Yes, substantially. Polling or Supabase Realtime can replace most Render→pilot push traffic.
- **Render still continuously running:** Yes, because SWIM consumer and FAA ingestion/processing remain server-side and long-lived.

## 4) Bandwidth comparison (1/10/25/50/100 pilots)

### Assumptions (from code behavior)
- Full snapshot size `S = 120 KB`
- Effective update cadence to clients: `U = 1 snapshot/minute` baseline (from scrape refresh path alone)
- Per pilot per 30-day month: `S * U * 60 * 24 * 30 ≈ 5.18 GB`
- SWIM-triggered updates can increase both models similarly; table below uses baseline for apples-to-apples scaling.

### Current model (Render distributes to every pilot)
Render outbound/month ≈ `5.18 GB * pilot_count`

### Proposed model (Render writes once; Supabase distributes)
- Render outbound to Supabase/month ≈ **5.18 GB total** (not multiplied by pilots)
- Supabase outbound/month ≈ `5.18 GB * pilot_count`

| Pilots | Current Render outbound | Proposed Render outbound | Proposed Supabase outbound |
|---:|---:|---:|---:|
| 1 | 5.18 GB | 5.18 GB | 5.18 GB |
| 10 | 51.8 GB | 5.18 GB | 51.8 GB |
| 25 | 129.5 GB | 5.18 GB | 129.5 GB |
| 50 | 259.0 GB | 5.18 GB | 259.0 GB |
| 100 | 518.0 GB | 5.18 GB | 518.0 GB |

Conclusion from scaling math:
- Moving distribution to Supabase does **not** reduce total internet egress bytes to all pilots.
- It **does** materially reduce **Render** outbound growth from O(pilots) to ~O(1), shifting distribution load to Supabase.

### Practicality of backend-side filtering
- **Yes, it is practical and possible** for backend distribution to provide filtered results (for example by airport/facility/query token) instead of always shipping the full snapshot.
- This can reduce per-user transfer significantly because each user usually needs only a small subset at a time.
- Simplest version:
  - Keep one canonical full snapshot produced on Render.
  - Add a read endpoint (or Supabase read pattern) that returns a filtered projection for a requested airport/query.
  - Keep full snapshot available for fallback/search modes.
- Tradeoff:
  - Backend/Supabase query complexity increases slightly.
  - But network usage per pilot generally drops versus always sending the full global state.
- Recommendation:
  - Start with full-snapshot polling migration first (lowest risk).
  - Then add filtered reads as a second optimization pass if bandwidth remains a concern.

## 5) Recommended minimal Supabase data model

Do **not** build historical/event schema initially.

Use a single current-state table (or two-table variant if needed):

### Option A (simplest)
`faa_current_state`
- `id text primary key` (constant key like `global`)
- `snapshot jsonb not null`
- `snapshot_bytes int not null`
- `updated_at timestamptz not null default now()`

Write pattern:
- Render upserts one row every ~1 minute (or when content hash changes).

Storage:
- ~120 KB per row current snapshot (+ small metadata). Negligible storage footprint.

Read pattern:
- Frontend polls every 30–60s selecting `snapshot, updated_at`.

Realtime:
- **Not required initially.** Polling is simpler and likely sufficient for beta.

Supabase Free for beta:
- Likely adequate for low pilot counts and minute polling; monitor egress limits as pilot count grows.

## 6) Security recommendations
- Keep Supabase **service role key server-side on Render only**.
- Keep FAA/SWIM credentials server-side on Render only.
- Frontend can use Supabase anon/public key for read-only access to `faa_current_state` if data is intentionally public.
- Enforce RLS:
  - Allow `select` only on intended public table/rows.
  - Deny write from anon/authenticated frontend roles.
  - Keep any private tables inaccessible.

## 7) Final recommendation
1. **Should we move distribution to Supabase?** Yes, for Render scalability and bandwidth relief.
2. **What should remain on Render?** SWIM connection, FAA scraping, parsing/normalization, snapshot assembly, Supabase writes.
3. **What should move to Supabase?** Current processed FAA snapshot distribution.
4. **What processing can move to browser?** Most pilot-specific filtering/search/grouping (already largely there).
5. **Can WebSockets be removed eventually?** Yes, after Supabase polling/realtime path is validated.
6. **Does Render still need continuous runtime?** Yes, SWIM ingestion is persistent.
7. **Likely material cost/bandwidth reduction?** For Render: yes (strong). For total egress: mostly shifted, not eliminated.

## 8) High-level migration outline (no implementation)
1. Create `faa_current_state` in Supabase with strict RLS.
2. Add Render upsert of processed snapshot (~1/min, optional content-hash guard).
3. Validate Supabase payload correctness independently.
4. Update frontend to read snapshot from Supabase (polling first).
5. Compare correctness + bandwidth against current approach.
6. Reduce/retire Render WebSocket distribution after confidence period.

## Risks / blockers / approvals needed
- Need explicit decision on acceptable frontend freshness target (e.g., 30s vs 60s polling).
- Need decision whether to use polling only or adopt Supabase Realtime later.
- Need confirmation that FAA-derived snapshot is safe to expose as public read-only dataset.
- Need monitoring plan for Supabase egress ceilings as pilot count scales.
