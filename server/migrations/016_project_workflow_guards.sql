-- Project workflow guard compatibility for the profile/question lock rules.
-- The columns are additive so this migration is safe for databases that were
-- created from the earlier baseline migrations.
ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS website_locked_at TIMESTAMPTZ;

-- Empty strings are equivalent to an omitted optional website.  Converting
-- legacy blanks to NULL keeps the one-time post-confirmation fill predicate
-- deterministic without changing a real URL.
UPDATE geo_projects
   SET website_url = NULL
 WHERE website_url IS NOT NULL
   AND length(btrim(website_url)) = 0;

-- Existing confirmed projects already have an immutable website when one was
-- saved.  Backfill only the lock marker; never rewrite the URL or any output.
UPDATE geo_projects
   SET website_locked_at = questions_locked_at
 WHERE questions_locked_at IS NOT NULL
   AND website_url IS NOT NULL
   AND website_locked_at IS NULL;

CREATE INDEX IF NOT EXISTS geo_diagnosis_runs_project_started_idx
  ON geo_diagnosis_runs (project_id, run_type, started_at DESC);
