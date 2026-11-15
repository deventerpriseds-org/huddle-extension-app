<!--
WHAT:          acceptance criteria + spelling table for rewriting each element's tag at parse5's own
               source spans (startTag/endTag) in visibleHtml, so htmlToText's `/<[^>]+>/g` never sees a
               `>` inside an attribute value.
WHY:           main's tag rule ends a tag at the first `>`; 8 of 88 Chromium-recorded loop-5 rows differ
               from the browser only by attribute fragments like `b">`. Two regex attempts (verifier
               loops 8, 9) dropped visible words on malformed shapes. Owner approved the span-rewrite
               approach 2026-11-15.
SUPERSEDES:    nothing
SUPERSEDED-BY: nothing -- current
EVIDENCE:      base claude_task-proposals @ c479cc33; loops 7..9 on claude_verify-correspondence-proposals-7/8/9
WRITER:        independent AC-writing subagent, cold, no access to the implementer's plan.
-->

# Acceptance Criteria — html tag span rewrite (Tier 1, live work-email text path)

Status: IN PROGRESS (skeleton committed first; sections appended as written)

## 0. Sources read
PENDING

## 1. Existing system this extends
PENDING

## 2. Acceptance criteria
PENDING

## 3. Spelling table
PENDING

## 4. Goal -> AC coverage
PENDING

## 5. Open questions for the owner
PENDING
