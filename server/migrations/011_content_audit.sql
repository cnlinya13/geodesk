-- Keep only the latest content fact-checking run on each project.  The JSONB
-- value is replaced atomically by the service; no history, page snapshot, or
-- archive table is introduced.
ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS content_audit JSONB;
