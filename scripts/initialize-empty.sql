-- Only initialize counters in a new database without participant records.
UPDATE community_state
SET votes=0, sessions=0, ready=1, backfill_phase='done', backfill_cursor=0
WHERE id=1
  AND NOT EXISTS(SELECT 1 FROM votes)
  AND NOT EXISTS(SELECT 1 FROM sessions);
SELECT ready FROM community_state WHERE id=1;
