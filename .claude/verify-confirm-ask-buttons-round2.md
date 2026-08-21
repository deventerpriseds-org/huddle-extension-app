# Verification Report — confirm-ask reach-out buttons (round 2, independent re-run)

Prior round-2 attempt was killed mid-run by container restart; this replaces it from scratch.
Branch: `claude/confirm-ask-buttons`, local HEAD 46060e0 + uncommitted working-tree changes.

## Step 1 — Confirm the two call sites (type sig + object literal) — DONE

### HuddleView.tsx `applyTurnStream`
Grep hits: lines 338 (ConfirmAskRow reads `m.confirmAsk`), 559 (`{m.confirmAsk && <ConfirmAskRow m={m} />}`), 744 (type), 800 (object literal).

Type signature, lines 739-746:
```
    replies:
      | {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
        }[]
      | undefined,
```

Object literal, `upsertAgent(...)` call, lines 791-801:
```
      upsertAgent({
        id: mid,
        huddleId: huddle.id,
        author: { kind: "agent", agentId: reply.agentId },
        text: reply.text,
        ts: prev?.ts ?? Date.now() + i,
        replyTo: turnId,
        artifacts: reply.artifacts,
        toolUses: crumbs,
        confirmAsk: reply.confirmAsk,
      });
```
CONFIRMED: both the type and the literal include `confirmAsk`.

### HuddleApp.tsx away/backfill poll loop
Grep hits: lines 76 (type), 110 (object literal).

Type signature, lines 72-77 (inline reply type inside the `turns as {...}[]` cast):
```
        replies: {
          agentId: AgentId;
          text: string;
          artifacts?: { id: string; name: string }[];
          confirmAsk?: { taskId: string; taskTitle: string; proposedDod: string };
        }[];
```

Object literal, `add({...})` call, lines 102-112:
```
          add({
            id: mid,
            huddleId: t.huddleId,
            author: { kind: "agent", agentId: reply.agentId },
            text: reply.text,
            ts: (t.updated_ms || Date.now()) + i,
            replyTo: t.id,
            artifacts: reply.artifacts,
            confirmAsk: reply.confirmAsk,
            toolUses: t.toolUses ? breadcrumbToolsFor(reply.agentId, t.toolUses) : undefined,
          });
```
CONFIRMED: both the type and the literal include `confirmAsk`.

STEP 1 VERDICT: both claimed call sites are real and correctly wired, as claimed.

## Step 2 — grep sweep for other message-construction sites (IN PROGRESS)
