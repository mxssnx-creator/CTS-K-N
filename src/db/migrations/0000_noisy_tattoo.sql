CREATE TABLE `job_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` integer NOT NULL,
	`step_index` integer NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`error` text,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`total_steps` integer DEFAULT 0 NOT NULL,
	`current_step` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer,
	`updated_at` integer
);
