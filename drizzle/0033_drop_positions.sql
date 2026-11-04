-- Issue #115: migration 0031 (issue #106) copied every elected position into volunteer_role and
-- every holder into volunteer_signup, with the same ids, and left the old rows as a fallback.
-- Nothing has read or written them since. Refuse, and so roll the whole deploy's migrations back,
-- if anything wrote to them after 0031 reached production on 2026-10-11.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "camp_position" WHERE "created_at" >= '2026-10-12')
    OR EXISTS (SELECT 1 FROM "position_holder" WHERE "created_at" >= '2026-10-12') THEN
    RAISE EXCEPTION 'camp_position or position_holder has rows written after migration 0031; check them before dropping (issue #115)';
  END IF;
END $$;--> statement-breakpoint
-- No CASCADE: anything else that still depends on them should stop the migration, not go too.
DROP TABLE "position_holder";--> statement-breakpoint
DROP TABLE "camp_position";--> statement-breakpoint
ALTER TABLE "camp_settings" DROP COLUMN "feature_positions";
