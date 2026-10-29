-- Creates the Watchdog schema. Safe to re-run.
-- Parameters: :catalog, :schema
CREATE SCHEMA IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema)
COMMENT 'Watchdog: which jobs to check, how they depend on each other, and what each scan found'
