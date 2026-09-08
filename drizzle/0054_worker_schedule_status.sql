CREATE TABLE `worker_schedule_status` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduled_at` text NOT NULL,
	`observed_at` text NOT NULL,
	CONSTRAINT "worker_schedule_status_id" CHECK("worker_schedule_status"."id"='minute')
);
