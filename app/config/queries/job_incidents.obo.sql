-- The problems the Monitoring page marks, from the incidents view: every open incident, and every incident
-- that cleared in the last 24 hours. Incidents that are NOT_CHECKED (the job left the list, or its check
-- writes rows only while it finds a problem) are left out. is_new is true when the incident opened in its
-- source's newest scan. A view that is not there yet makes this query fail, and the page then shows without it.
-- @param catalog STRING = main
-- @param schema STRING = watchdog
-- @param refresh INT = 0
SELECT incident_id,
       state,
       source,
       check_id,
       job_name,
       workspace_id,
       workspace_name,
       job_id,
       severity,
       opened_at,
       scans_seen,
       current_status,
       resolved_at,
       error_summary,
       run_page_url,
       is_new
FROM IDENTIFIER(:catalog || '.' || :schema || '.incidents')
WHERE :refresh >= 0
  AND (state = 'OPEN'
       OR (state = 'RESOLVED'
           AND resolved_at >= timestampadd(HOUR, -24, current_timestamp())))
