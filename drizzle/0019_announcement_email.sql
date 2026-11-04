ALTER TABLE "announcement" ADD COLUMN "emailed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "announcement" ADD COLUMN "emailed_by_person_id" uuid;--> statement-breakpoint
ALTER TABLE "announcement" ADD COLUMN "emailed_count" integer;--> statement-breakpoint
ALTER TABLE "key_date" ADD COLUMN "remind" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "key_date" ADD COLUMN "reminded_at" timestamp with time zone;