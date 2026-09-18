CREATE TABLE `analysis_cache` (
	`id` integer PRIMARY KEY NOT NULL,
	`snapshot_id` text,
	`revision` integer DEFAULT -1 NOT NULL,
	`moderation_revision` integer DEFAULT -1 NOT NULL,
	`computed_at` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `community_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`votes` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`moderation_revision` integer DEFAULT 0 NOT NULL,
	`ready` integer DEFAULT 0 NOT NULL,
	`backfill_phase` text DEFAULT 'opinions' NOT NULL,
	`backfill_cursor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `release_opinions` (
	`release_id` text NOT NULL,
	`opinion_id` text NOT NULL,
	`revision` integer NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`release_id`, `opinion_id`)
);
--> statement-breakpoint
CREATE TABLE `release_parts` (
	`release_id` text NOT NULL,
	`part_id` text NOT NULL,
	`kind` text NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`row_count` integer NOT NULL,
	`byte_length` integer NOT NULL,
	PRIMARY KEY(`release_id`, `part_id`)
);
--> statement-breakpoint
ALTER TABLE `opinions` ADD `agree_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `disagree_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `pass_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `unrelated_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_opinions_kind` ON `opinions` (`kind`);--> statement-breakpoint
ALTER TABLE `releases` ADD `schema_version` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `phase` text DEFAULT 'done' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `build_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `watermarks` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `counts` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `releases` ADD `moderation_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `approved_vote_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_events_impression_type` ON `events` (`impression_id`,`type`);--> statement-breakpoint
CREATE INDEX `idx_impressions_opinion_open` ON `impressions` (`opinion_id`,`answered_at`,`retired_at`);--> statement-breakpoint
CREATE INDEX `idx_votes_impression` ON `votes` (`impression_id`);--> statement-breakpoint
CREATE INDEX `idx_votes_opinion_session` ON `votes` (`opinion_id`,`session_id`);
--> statement-breakpoint
INSERT INTO community_state(id) VALUES(1);
--> statement-breakpoint
INSERT INTO analysis_cache(id) VALUES(1);
--> statement-breakpoint
-- Reference triggers for Yokohama Voices. This file does not alter the site.
-- Assumptions:
--   * One community_state row exists with id=1.
--   * All counters are INTEGER NOT NULL DEFAULT 0.
--   * votes has PRIMARY KEY(session_id, opinion_id), immutable response fields,
--     value IN (-1,0,1), and unrelated IN (0,1).
--   * All visitor and moderation writes are blocked while ready=0.
--     Paged backfill changes counter columns only; enable ready=1 after checking.
--   * Opinion counters include all retained raw votes, even while not approved.
--   * community_state.sessions counts sessions with approved_vote_count>0,
--     independently of the session's phase.
--   * No application-side increments duplicate these trigger updates.

CREATE TRIGGER trg_votes_insert_counters_v1
AFTER INSERT ON votes
WHEN EXISTS (SELECT 1 FROM community_state WHERE id=1 AND ready=1)
BEGIN
  UPDATE opinions
  SET agree_count=agree_count+IIF(NEW.unrelated=0 AND NEW.value=-1,1,0),
      disagree_count=disagree_count+IIF(NEW.unrelated=0 AND NEW.value=1,1,0),
      pass_count=pass_count+IIF(NEW.unrelated=0 AND NEW.value=0,1,0),
      unrelated_count=unrelated_count+IIF(NEW.unrelated=1,1,0)
  WHERE id=NEW.opinion_id;

  -- Read the session's count BEFORE incrementing it.
  UPDATE community_state
  SET votes=votes+1,
      sessions=sessions+IIF((SELECT approved_vote_count FROM sessions WHERE id=NEW.session_id)=0,1,0),
      revision=revision+1
  WHERE id=1
    AND EXISTS (SELECT 1 FROM opinions WHERE id=NEW.opinion_id AND status='approved');

  UPDATE sessions
  SET approved_vote_count=approved_vote_count+1
  WHERE id=NEW.session_id
    AND EXISTS (SELECT 1 FROM opinions WHERE id=NEW.opinion_id AND status='approved');
END;
--> statement-breakpoint

CREATE TRIGGER trg_votes_delete_counters_v1
AFTER DELETE ON votes
WHEN EXISTS (SELECT 1 FROM community_state WHERE id=1 AND ready=1)
BEGIN
  UPDATE opinions
  SET agree_count=agree_count-IIF(OLD.unrelated=0 AND OLD.value=-1,1,0),
      disagree_count=disagree_count-IIF(OLD.unrelated=0 AND OLD.value=1,1,0),
      pass_count=pass_count-IIF(OLD.unrelated=0 AND OLD.value=0,1,0),
      unrelated_count=unrelated_count-IIF(OLD.unrelated=1,1,0)
  WHERE id=OLD.opinion_id;

  -- Read the session's count BEFORE decrementing it.
  UPDATE community_state
  SET votes=votes-1,
      sessions=sessions-IIF((SELECT approved_vote_count FROM sessions WHERE id=OLD.session_id)=1,1,0),
      revision=revision+1
  WHERE id=1
    AND EXISTS (SELECT 1 FROM opinions WHERE id=OLD.opinion_id AND status='approved');

  UPDATE sessions
  SET approved_vote_count=approved_vote_count-1
  WHERE id=OLD.session_id
    AND EXISTS (SELECT 1 FROM opinions WHERE id=OLD.opinion_id AND status='approved');
END;
--> statement-breakpoint

CREATE TRIGGER trg_opinions_approved_boundary_v1
AFTER UPDATE OF status ON opinions
WHEN (OLD.status='approved') != (NEW.status='approved')
 AND EXISTS (SELECT 1 FROM community_state WHERE id=1 AND ready=1)
BEGIN
  -- delta = +1 when entering approved, -1 when leaving it.
  -- The vote PK guarantees one affected vote per session for this opinion.
  -- Raw opinion counters remain unchanged through moderation.
  UPDATE community_state
  SET votes=votes+((NEW.status='approved')-(OLD.status='approved'))*
        (NEW.agree_count+NEW.disagree_count+NEW.pass_count+NEW.unrelated_count),
      sessions=sessions+((NEW.status='approved')-(OLD.status='approved'))*(
        SELECT COUNT(*)
        FROM sessions AS s JOIN votes AS v ON v.session_id=s.id
        WHERE v.opinion_id=NEW.id
          AND s.approved_vote_count=IIF(NEW.status='approved',0,1)
      )
  WHERE id=1;

  UPDATE sessions
  SET approved_vote_count=approved_vote_count+((NEW.status='approved')-(OLD.status='approved'))
  WHERE id IN (SELECT session_id FROM votes WHERE opinion_id=NEW.id);

  -- Revision updates belong to the metadata trigger below, once per row update.
END;
--> statement-breakpoint

CREATE TRIGGER trg_opinions_metadata_revision_v1
AFTER UPDATE OF status,revision,text,tag_id ON opinions
WHEN (OLD.status IS NOT NEW.status OR OLD.revision IS NOT NEW.revision
   OR OLD.text IS NOT NEW.text OR OLD.tag_id IS NOT NEW.tag_id)
 AND EXISTS (SELECT 1 FROM community_state WHERE id=1 AND ready=1)
BEGIN
  -- Conservative invalidation also includes pending/rejected metadata changes.
  -- This protects release review and analysis snapshots. No-op writes do not
  -- invalidate; keep/review actions do invalidate when opinion.revision changes.
  UPDATE community_state
  SET revision=revision+1, moderation_revision=moderation_revision+1
  WHERE id=1;
END;
--> statement-breakpoint

CREATE TRIGGER trg_opinions_insert_revision_v1 AFTER INSERT ON opinions
WHEN NEW.status='approved' AND EXISTS(SELECT 1 FROM community_state WHERE id=1 AND ready=1)
BEGIN UPDATE community_state SET revision=revision+1,moderation_revision=moderation_revision+1 WHERE id=1; END;
--> statement-breakpoint
CREATE TRIGGER trg_impressions_retired_event_v1 AFTER UPDATE OF retired_at ON impressions
WHEN OLD.retired_at IS NULL AND NEW.retired_at IS NOT NULL
BEGIN INSERT OR IGNORE INTO events(id,session_id,type,impression_id,created_at) VALUES('retired:'||NEW.id,NEW.session_id,'retired',NEW.id,NEW.retired_at); END;
--> statement-breakpoint
CREATE TRIGGER trg_votes_initializing BEFORE INSERT ON votes WHEN (SELECT ready FROM community_state WHERE id=1)=0
BEGIN SELECT RAISE(ABORT,'Counters are initializing'); END;
--> statement-breakpoint
CREATE TRIGGER trg_sessions_initializing BEFORE INSERT ON sessions WHEN (SELECT ready FROM community_state WHERE id=1)=0
BEGIN SELECT RAISE(ABORT,'Counters are initializing'); END;
--> statement-breakpoint
CREATE TRIGGER trg_opinions_initializing BEFORE UPDATE OF status,revision,text,tag_id ON opinions WHEN (SELECT ready FROM community_state WHERE id=1)=0
BEGIN SELECT RAISE(ABORT,'Counters are initializing'); END;
--> statement-breakpoint
CREATE TRIGGER trg_votes_delete_initializing BEFORE DELETE ON votes WHEN (SELECT ready FROM community_state WHERE id=1)=0
BEGIN SELECT RAISE(ABORT,'Counters are initializing'); END;
--> statement-breakpoint
CREATE TRIGGER trg_votes_immutable BEFORE UPDATE ON votes
BEGIN SELECT RAISE(ABORT,'Saved responses are immutable'); END;
