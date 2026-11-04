-- Sessions belong to one camp. Sessions from before that have no camp, so they end (signing
-- those people out) rather than working at a camp they weren't created at.
DELETE FROM "session";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "camp_id" uuid DEFAULT current_camp_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Like every camp table: a camp sees, refreshes and ends only its own sessions.
SELECT enable_camp_rls('session');