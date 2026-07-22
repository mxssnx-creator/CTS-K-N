CREATE TABLE `cts_runtime_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`payload` text NOT NULL,
	`updated_at` integer NOT NULL,
	`lease_owner` text,
	`lease_scope` text,
	`lease_until` integer,
	CONSTRAINT "cts_runtime_snapshot_singleton" CHECK("cts_runtime_snapshot"."id" = 1)
);
