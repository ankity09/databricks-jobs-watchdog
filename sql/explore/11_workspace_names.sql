-- Workspace names and URLs for the whole account, from the workspaces system
-- table (Public Preview). workspace_url comes back with https:// and no
-- trailing slash, ready to build links. The scan notebooks save this result
-- as the temp view watchdog_workspace_names; if you cannot read the table,
-- findings still work, just without workspace names and run links.
SELECT
  workspace_id,
  workspace_name,
  CASE
    WHEN workspace_url IS NULL OR workspace_url = '' THEN NULL
    WHEN workspace_url RLIKE '^https?://' THEN regexp_replace(workspace_url, '/+$', '')
    ELSE concat('https://', regexp_replace(workspace_url, '/+$', ''))
  END AS workspace_url,
  status
FROM system.access.workspaces_latest
ORDER BY workspace_name
