CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `chunk` (
	`hash` text NOT NULL,
	`size` integer NOT NULL,
	`user_id` text NOT NULL,
	`refcount` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `hash`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "chunk_refcount_nonneg" CHECK(refcount >= 0),
	CONSTRAINT "chunk_size_nonneg" CHECK(size >= 0)
);
--> statement-breakpoint
CREATE TABLE `device` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `device_user_id_idx` ON `device` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_token_hash_unq` ON `device` (`token_hash`);--> statement-breakpoint
CREATE TABLE `file` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_root_id` text NOT NULL,
	`path` text NOT NULL,
	`current_version_id` text,
	`deleted` integer DEFAULT 0 NOT NULL,
	`updated_seq` integer NOT NULL,
	FOREIGN KEY (`sync_root_id`) REFERENCES `sync_root`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "file_deleted_bool" CHECK(deleted in (0, 1))
);
--> statement-breakpoint
CREATE INDEX `file_root_seq_idx` ON `file` (`sync_root_id`,`updated_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `file_root_path_unq` ON `file` (`sync_root_id`,`path`);--> statement-breakpoint
CREATE TABLE `file_chunk` (
	`version_id` text NOT NULL,
	`idx` integer NOT NULL,
	`user_id` text NOT NULL,
	`chunk_hash` text NOT NULL,
	PRIMARY KEY(`version_id`, `idx`),
	FOREIGN KEY (`version_id`) REFERENCES `file_version`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`,`chunk_hash`) REFERENCES `chunk`(`user_id`,`hash`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `file_chunk_user_hash_idx` ON `file_chunk` (`user_id`,`chunk_hash`);--> statement-breakpoint
CREATE TABLE `file_version` (
	`id` text PRIMARY KEY NOT NULL,
	`file_id` text NOT NULL,
	`size` integer NOT NULL,
	`mtime` integer NOT NULL,
	`mode` integer,
	`created_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`file_id`) REFERENCES `file`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `device`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "file_version_size_nonneg" CHECK(size >= 0)
);
--> statement-breakpoint
CREATE INDEX `file_version_file_id_idx` ON `file_version` (`file_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `sync_root` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sync_root_user_id_idx` ON `sync_root` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);