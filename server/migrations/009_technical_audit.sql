-- Keep only the most recent deterministic technical audit on the project.
-- The audit snapshot is replaced atomically after a completed run; no history
-- table is introduced for the MVP.
ALTER TABLE geo_projects
  ADD COLUMN IF NOT EXISTS technical_audit JSONB;
