ALTER TABLE "camp" ADD COLUMN "created_in_console" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "agreement_version" text;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "agreement_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "agreement_accepted_by" uuid;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "features_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD COLUMN "checklist_dismissed_at" timestamp with time zone;