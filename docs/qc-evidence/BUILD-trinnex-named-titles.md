# BUILD -- Meetings: titles from the named transcript files + speaker identifying lines (2026-11-20)

WHAT:       Meetings shows the descriptive name from the owner's OneDrive transcript file instead of Fireflies'
            date-only title, and each speaker card shows up to 5 identifying lines.
WHY:        Owner, 2026-11-20 (phone + OneDrive screenshots): "Why aren't the titles from the files on the server
            kept instead of using the date as a title?" and "I'm unable to see enough text to determine who is speaking".
SUPERSEDES: nothing.  SUPERSEDED-BY: nothing -- current.
EVIDENCE:   probe runs 44734555516 / 44734811029; tests + mutation proofs below.

## Ground truth (read, not assumed)
| Fact | Source |
|---|---|
| All 29 `chat.fireflies_meetings.title` are date-only ("Nov 10, 09:37 AM"), meetings Nov 10-19 | huddle-pg-mcp-write query, 2026-11-20 |
| Huddle takes the title from Fireflies GraphQL `transcript.title` | `lib/fireflies/fireflies.server.ts` `recordMeetingInfo(id, t.title, ...)` |
| The owner's files pair 1:1 by stamp: "Nov 10, 09:37 AM" <-> "Nov 10- 09-37 AM-Planni..." (8 of 8 visible in the screenshot) | screenshot vs DB rows Nov 10-11 |
| Huddle's OneDrive is the risedigitalsolutions drive; folder at `/automation/Fireflies Transcripts`; 28 files, 28 `.md`, 28 named, 0 date-only | probe 44734555516 (drive, root 404, search 403) + 44734811029 (folder walk) |
| One speaker line per card, first >=4-word line, cut to 200 chars, `truncate` to one screen line | `meeting-triage-core.ts` `speakerRows`, `MeetingsView.tsx` |

## What changed
- `meeting-triage-core.ts`: `stampKeyFromTitle`, `parseNamedFile`, `matchNamedFiles` (exact stamp, file created within
  14 days of the meeting because the stamp has no year, closest wins, one file per meeting); `speakerClues`
  (turns, then introductions > called-on-by-name > longest; each carries the previous speaker's line).
- `named-files.server.ts` (new): lists the folder with the EXISTING app-only Graph token (no new secret, $0 idle),
  cached 5 min, FAIL-SOFT to [] (Meetings then shows the Fireflies title exactly as before). Logs status codes only.
  Folder override: `FIREFLIES_NAMED_FOLDER`.
- `meetings.server.ts`: title order = owner's own title > file name > Fireflies title; name suggestions read the
  file name ("Alex Sync" -> Alex). `MeetingListItem.fileTitle` added.
- `MeetingsView.tsx`: the speaker card shows the most identifying line (3 lines, plus the line before when someone
  was called on), and "More of what they said (N)" opens all clues.

## Real-data check (in-session only; no names or quotes are recorded here -- this repo is public)
Ran speakerClues on two real stored transcripts (a 2-person meeting, 608 lines; an 8-person meeting, 1,049 lines).
In the 8-person meeting, 4 of 8 speakers got a "called on by name" clue whose line-before contained the person's name
(the owner was identifiable from one of them). Two false "introductions" were found on real data and fixed: a client
name after "it's" and "have <Name> here" mid-sentence (tests SC5, SC9 pin both with invented names).

## Tests and proofs
- `scripts/trinnex-named-titles.test.ts` 25/25 (16-row spelling table of titles and file names incl. negatives).
- `scripts/trinnex-speaker-clues.test.ts` 10/10.
- mutate.sh: NT2 time window FIRED (control EQUIVALENT); NF5 fail-soft catch FIRED (control EQUIVALENT); SC9 narrowed
  intro FIRED (control EQUIVALENT). NF2 (early return on 403) INERT -- behaviourally equivalent: the catch and the
  empty body already yield []; the real guard is the catch, proven by NF5.
- `tsc --noEmit` 0 errors; `vite build` rc 0. Full Trinnex suite: only GUARD3 fails, the pre-existing combined-run
  interference (fails identically on clean main; passes alone).
