ALTER TABLE "camp_settings" ADD COLUMN "feature_mailing" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "mailing_address" jsonb;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_mailing_ck" CHECK ("person"."mailing_address" is null or jsonb_typeof("person"."mailing_address") = 'object');