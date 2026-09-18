ALTER TABLE `events` ADD `client_at` integer;--> statement-breakpoint
ALTER TABLE `events` ADD `client_sequence` integer;--> statement-breakpoint
ALTER TABLE `releases` ADD `prepare_run_url` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `publish_run_url` text;--> statement-breakpoint
ALTER TABLE `releases` ADD `publication_reason` text;