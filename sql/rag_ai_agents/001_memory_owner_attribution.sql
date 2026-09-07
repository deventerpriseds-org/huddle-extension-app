-- WHAT:       Adds owner attribution to Huddle's memory store: an `owner_entra_oid` column on
--             public.rag_chunks and public.rag_triples, indexed, plus a one-time backfill of the
--             existing rows.
-- WHY:        Neither table has ever had a column saying WHOSE a row is. `agent_id` and
--             `author_agent_ids` record which AGENT wrote a chunk, not which PERSON it belongs to
--             (verified live 2026-09-07: rag_chunks has 9 columns, rag_triples 11, and none of them
--             identifies a user). That is harmless with one user and unfixable with two, which is
--             why the owner directed it now: "I actually want to go with b, add the owner column".
--             Option B routes Nexus chat through Huddle's agent, so Nexus turns start writing into
--             this store; rows written before the column exists cannot be attributed afterwards
--             because the information to do it never existed anywhere.
-- SUPERSEDES: nothing -- this is the first migration in this directory.
-- SUPERSEDED-BY: nothing -- current.
-- EVIDENCE:   nexus-hub/docs/cross-app-agent/DECISION-option-b.md step 2 and its "The owner column is
--             MORE load-bearing under B" section; DECISION-identity-anchor.md (anchor on the stable
--             object-id, never on email); live shape + counts from db-query.yml run 34159355206.
--
-- ANCHORED ON entra_object_id, NOT EMAIL. DECISION-identity-anchor.md settled this: one person holds
-- many emails (von.ellis@ and dev@ both hang off a89e3652-...), emails are mutable and many-per-person,
-- and keying on one of them is what produced the silent cross-app mismatch this research already
-- found. identity.profiles is keyed on entra_object_id and holds no email column at all -- Huddle's
-- own schema already models it correctly, so this column follows it.
--
-- DELIBERATELY NO FOREIGN KEY, and this is a real decision rather than an omission. Memory writes are
-- fire-and-forget: Huddle's CLAUDE.md records that every turn auto-writes the user message as a
-- scope='global' chunk without awaiting it. A FK to identity.profiles would make such an insert THROW
-- for any person not yet in the profiles table, and because nothing awaits the write, the memory
-- would be lost with no error surfacing anywhere. A nullable column plus an index gives attribution
-- without giving the store a new way to fail silently.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, and a backfill whose WHERE clause
-- is already satisfied on a second run. Safe to re-apply.

ALTER TABLE public.rag_chunks  ADD COLUMN IF NOT EXISTS owner_entra_oid TEXT;
ALTER TABLE public.rag_triples ADD COLUMN IF NOT EXISTS owner_entra_oid TEXT;

CREATE INDEX IF NOT EXISTS rag_chunks_owner_idx  ON public.rag_chunks  (owner_entra_oid);
CREATE INDEX IF NOT EXISTS rag_triples_owner_idx ON public.rag_triples (owner_entra_oid);

-- BACKFILL, GUARDED BY THE ONLY CONDITION THAT MAKES IT HONEST.
--
-- With exactly one profile, every existing row provably belongs to that person -- there is nobody
-- else it could belong to. With two or more, that inference is worthless and assigning rows would be
-- inventing attribution rather than recording it, so the backfill declines and leaves them NULL.
-- NULL means "written before attribution existed", which is a true and useful statement; a wrong
-- owner id is neither.
DO $$
DECLARE
  profile_n       integer;
  sole_oid        text;
  filled_chunks   integer;
  filled_triples  integer;
BEGIN
  SELECT count(*) INTO profile_n FROM identity.profiles;

  IF profile_n <> 1 THEN
    RAISE NOTICE 'BACKFILL SKIPPED: identity.profiles holds % rows. Existing memory rows stay NULL '
                 '(= written before attribution existed). Assigning them to a guessed owner would '
                 'be fabricating attribution.', profile_n;
    RETURN;
  END IF;

  SELECT entra_object_id INTO sole_oid FROM identity.profiles;

  UPDATE public.rag_chunks  SET owner_entra_oid = sole_oid WHERE owner_entra_oid IS NULL;
  GET DIAGNOSTICS filled_chunks = ROW_COUNT;

  UPDATE public.rag_triples SET owner_entra_oid = sole_oid WHERE owner_entra_oid IS NULL;
  GET DIAGNOSTICS filled_triples = ROW_COUNT;

  RAISE NOTICE 'BACKFILL: sole profile %; attributed % rag_chunks and % rag_triples.',
               sole_oid, filled_chunks, filled_triples;
END $$;
