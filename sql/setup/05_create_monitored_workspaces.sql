-- Config table: an environment label for each workspace, such as production
-- or lower, so findings can be split and alerts routed by environment.
-- Notebook 02 replaces its rows from the workspaces section of your
-- monitored-jobs YAML file. A workspace matches by ID or by name.
-- Parameters: :catalog, :schema
CREATE TABLE IF NOT EXISTS IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces') (
  workspace_id STRING COMMENT 'Workspace ID; empty when the entry matches by name',
  workspace_name STRING COMMENT 'Workspace name; empty when the entry matches by ID',
  environment STRING NOT NULL COMMENT 'Environment label, for example production or lower',
  notes STRING,
  loaded_at TIMESTAMP NOT NULL COMMENT 'When this row was loaded from the YAML file'
)
COMMENT 'Watchdog config: environment labels for workspaces'
