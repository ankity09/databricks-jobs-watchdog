-- Replaces every row of monitored_workspaces with the entries in the temp
-- view watchdog_config_workspaces, which notebook 02 builds from the
-- workspaces section of your monitored-jobs YAML file.
-- Parameters: :catalog, :schema
INSERT OVERWRITE TABLE IDENTIFIER(:catalog || '.' || :schema || '.monitored_workspaces')
SELECT
  workspace_id,
  workspace_name,
  environment,
  notes,
  current_timestamp() AS loaded_at
FROM watchdog_config_workspaces
