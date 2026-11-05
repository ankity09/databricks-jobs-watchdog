-- Whether the SQL engine accepts a name pattern and its exclusion. It reads no
-- table, so when pattern_matches.obo.sql fails and this query fails too, the
-- pattern has an error; when this one succeeds, the person cannot read the
-- jobs table. The app needs this because the warehouse reports both problems
-- with the same error code, and AppKit does not pass the message on.
-- @param pattern STRING = ^example$
-- @param exclude STRING = ""
-- @param refresh INT = 0
SELECT
  regexp_like('', :pattern) AS pattern_matches_empty,
  regexp_like('', :exclude) AS exclude_matches_empty,
  :refresh AS refresh
