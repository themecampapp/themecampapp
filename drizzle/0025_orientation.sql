ALTER TABLE "person" ADD COLUMN "orientation_done" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "orientation_step" text;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_orientation_ck" CHECK ("person"."orientation_done" is null or "person"."orientation_done" in ('lead','admin'));--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_orientation_step_ck" CHECK (char_length("person"."orientation_step") <= 40);