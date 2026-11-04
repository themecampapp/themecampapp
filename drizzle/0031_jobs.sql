ALTER TABLE "volunteer_role" ADD COLUMN "self_signup" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "volunteer_role" ADD COLUMN "show_in_yearbook" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- Issue #106: elected positions become jobs that Leads assign. Each keeps its id, so past
-- Activity entries still point at it, and shows in the Yearbook's Who's who as before. It needs
-- as many people as it ever had holders in one season (at least 1), and comes before the
-- sign-up jobs in the list. The old rows stay in camp_position and position_holder until
-- production is verified; nothing reads them after this.
INSERT INTO "volunteer_role" ("id", "camp_id", "title", "slots", "self_signup", "show_in_yearbook", "sort", "retired", "created_at")
SELECT p."id", p."camp_id", p."title",
  greatest(1, least(50, coalesce((
    SELECT max(n) FROM (
      SELECT count(*) AS n FROM "position_holder" h WHERE h."position_id" = p."id" GROUP BY h."burn_id"
    ) per_season), 1))),
  false, true, p."sort" - 10000, p."retired", p."created_at"
FROM "camp_position" p
ON CONFLICT ("id") DO NOTHING;--> statement-breakpoint
INSERT INTO "volunteer_signup" ("id", "camp_id", "burn_id", "role_id", "person_id", "added_by_person_id", "created_at")
SELECT h."id", h."camp_id", h."burn_id", h."position_id", h."person_id", h."assigned_by_person_id", h."created_at"
FROM "position_holder" h
ON CONFLICT DO NOTHING;--> statement-breakpoint
-- One feature switch for both: a camp that had positions on gets jobs.
UPDATE "camp_settings" SET "feature_volunteer" = true WHERE "feature_positions" AND NOT "feature_volunteer";
