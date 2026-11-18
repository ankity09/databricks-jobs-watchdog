-- @param refresh INT = 0
-- workspace_id is sent as a string, so a 16-digit ID keeps every digit in the browser.
SELECT CAST(workspace_id AS STRING) AS workspace_id, workspace_name, status
FROM system.access.workspaces_latest
WHERE :refresh >= 0
ORDER BY workspace_name
