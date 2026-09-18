CREATE TABLE `opinions` (
	`id` text PRIMARY KEY NOT NULL,
	`tag_id` text NOT NULL,
	`text` text NOT NULL,
	`kind` text NOT NULL,
	`author_session` text,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`author_session`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_opinions_author` ON `opinions` (`author_session`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`phase` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`ended_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_hash_unique` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE TABLE `votes` (
	`session_id` text NOT NULL,
	`opinion_id` text NOT NULL,
	`value` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`session_id`, `opinion_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opinion_id`) REFERENCES `opinions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "vote_value" CHECK("votes"."value" IN (-1,0,1))
);
--> statement-breakpoint
CREATE INDEX `idx_votes_opinion` ON `votes` (`opinion_id`);