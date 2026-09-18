CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`type` text NOT NULL,
	`impression_id` text,
	`snapshot_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_events_session_time` ON `events` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `impressions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`opinion_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`text_snapshot` text NOT NULL,
	`tag_snapshot` text NOT NULL,
	`source_snapshot` text NOT NULL,
	`kind_snapshot` text NOT NULL,
	`routing_version` text NOT NULL,
	`probability` real NOT NULL,
	`candidates` text NOT NULL,
	`issued_at` integer NOT NULL,
	`displayed_at` integer,
	`answered_at` integer,
	`retired_at` integer,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_id`) REFERENCES `opinions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_impressions_sequence` ON `impressions` (`session_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_impressions_open` ON `impressions` (`session_id`,`answered_at`,`retired_at`);--> statement-breakpoint
CREATE TABLE `moderation_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`opinion_id` text NOT NULL,
	`action` text NOT NULL,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`run_url` text NOT NULL,
	`previous_status` text NOT NULL,
	`next_status` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_moderation_revision` ON `moderation_actions` (`opinion_id`,`revision`);--> statement-breakpoint
CREATE TABLE `releases` (
	`id` text PRIMARY KEY NOT NULL,
	`sha256` text NOT NULL,
	`object_key` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`published_at` integer,
	`summary` text NOT NULL,
	`opinion_revisions` text NOT NULL,
	`actor` text NOT NULL,
	`reason` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`opinion_id` text NOT NULL,
	`category` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_id`) REFERENCES `opinions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reports_dedup` ON `reports` (`session_id`,`opinion_id`);--> statement-breakpoint
CREATE INDEX `idx_reports_opinion` ON `reports` (`opinion_id`);--> statement-breakpoint
CREATE TABLE `result_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `opinions` ADD `status` text DEFAULT 'approved' NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `reviewed_unrelated` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `opinions` ADD `reviewed_reports` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_opinions_status` ON `opinions` (`status`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `notice_version` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_at` integer;--> statement-breakpoint
ALTER TABLE `votes` ADD `impression_id` text;