-- Camps that already exist keep every feature on (they were using them); new camps get the
-- defaults. Adding with DEFAULT true and then changing the default does that without an UPDATE,
-- which row-level security would limit to no camp at all.
ALTER TABLE "dues" DROP CONSTRAINT "dues_method_ck";--> statement-breakpoint
ALTER TABLE "ticket_request" DROP CONSTRAINT "ticket_request_count_ck";--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "accent" text;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "contact_email" text;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "join_intro" text;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "inquiry_notify" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "max_tickets" integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "payment_methods" jsonb DEFAULT '["venmo","zelle","cash","other"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_dues" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_join" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_yearbook" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_saps" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ALTER COLUMN "feature_saps" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_volunteer" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ALTER COLUMN "feature_volunteer" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "feature_positions" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ALTER COLUMN "feature_positions" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD CONSTRAINT "camp_settings_accent_ck" CHECK ("camp_settings"."accent" is null or "camp_settings"."accent" ~ '^#[0-9a-f]{6}$');--> statement-breakpoint
ALTER TABLE "camp_settings" ADD CONSTRAINT "camp_settings_max_tickets_ck" CHECK ("camp_settings"."max_tickets" between 1 and 10);--> statement-breakpoint
ALTER TABLE "ticket_request" ADD CONSTRAINT "ticket_request_count_ck" CHECK ("ticket_request"."tickets_needed" between 0 and 10);