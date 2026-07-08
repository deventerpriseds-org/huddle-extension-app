## Plan: add avatars + two new agents

### 1. New agents in `src/features/huddle/data/agents.ts`
Add two entries to `AgentId` and `AGENTS`:

- **`cam-post`** — Cam Post, Communications
  - domains: messaging, drafts, replies, tone
  - themes: reply, email draft, message, tone, wording
  - tone: `warm`, colorVar: `--agent-cyan` (or new var if collision)
- **`troy-lennox`** — Troy Lennox, Travel
  - domains: flights, hotels, bookings, travel logistics
  - themes: flight, hotel, booking, airport, trip cost
  - tone: `direct`
  - Note: distinct from Iris (day-of itinerary) and Eli (general EA). Troy owns bookings/travel logistics.

### 2. Avatar field
Add `avatarUrl?: string` to the `Agent` interface. Update `AgentAvatar` component to render `<img>` when set, falling back to initials tile.

### 3. Upload headshots via `lovable-assets`
From `/mnt/user-uploads/`, upload and write pointer JSON to `src/assets/agents/`:

| Upload | Agent |
|---|---|
| `Startup1.png` | sam-trent |
| `Tasks.png` | tess-sutton |
| `Team_Lead.png` | terry-locke (confirmed woman) |
| `Travel_Agent2.png` | troy-lennox (new) |
| `Communications.png` (earlier batch) | cam-post (new) |
| + the 9 earlier-batch mappings already discussed | cole, charleston, elle, ezra, eli, faith, finn, flex, iris |

Wire each `avatarUrl` from the imported `.asset.json` pointer's `url`.

### 4. Add to group channel seed
Update `src/features/huddle/data/seed.ts` group channel members to include `cam-post` and `troy-lennox` alongside existing members.

### 5. Files touched
- `src/features/huddle/data/agents.ts` (add 2 agents, `avatarUrl` field, wire pointers)
- `src/features/huddle/components/AgentAvatar.tsx` (image + initials fallback)
- `src/features/huddle/data/seed.ts` (add to group)
- `src/assets/agents/*.asset.json` (11 new pointer files)

No routing/prompt logic changes.
