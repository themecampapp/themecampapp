-- Issue #56: the join page's intro moves from camp_settings into page wording (app_setting
-- page_text:join_intro), with every camp's text kept. The page used to add "Tell us a little
-- about yourself..." after the camp's intro; the page wording is the whole paragraph, so that
-- sentence is added here to any intro that doesn't already say it.
INSERT INTO "app_setting" ("camp_id", "key", "value")
SELECT "camp_id", 'page_text:join_intro',
  to_jsonb(CASE
    WHEN "join_intro" ILIKE '%Tell us a little about yourself%' THEN btrim("join_intro")
    ELSE btrim("join_intro") || ' Tell us a little about yourself and a camp lead will reach out to say hello.'
  END)
FROM "camp_settings"
WHERE "join_intro" IS NOT NULL AND btrim("join_intro") <> ''
ON CONFLICT ("camp_id", "key") DO NOTHING;--> statement-breakpoint
ALTER TABLE "camp_settings" DROP COLUMN "join_intro";