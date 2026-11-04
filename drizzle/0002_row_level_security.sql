-- Row-level security for every camp table: the database itself keeps each camp's rows to that
-- camp, as a backstop to the app's own checks. FORCE applies it to the table owner too; only a
-- BYPASSRLS role (the NOLOGIN app_definer that owns the SECURITY DEFINER functions) skips it.
-- A future migration that adds a camp table calls enable_camp_rls('<table>'). The catalog test
-- (tests/tenancy/rls.test.ts) and scripts/db-grants.ts fail if any table with camp_id lacks it.
CREATE FUNCTION public.enable_camp_rls(tbl regclass) RETURNS void
  LANGUAGE plpgsql
  AS $$
  BEGIN
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS camp_isolation ON %s', tbl);
    EXECUTE format(
      'CREATE POLICY camp_isolation ON %s USING (camp_id = (SELECT public.current_camp_id())) '
      'WITH CHECK (camp_id = (SELECT public.current_camp_id()))',
      tbl
    );
  END
  $$;--> statement-breakpoint

DO $$
DECLARE t regclass;
BEGIN
  FOR t IN
    SELECT c.oid::regclass FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'camp_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    PERFORM enable_camp_rls(t);
  END LOOP;
END
$$;--> statement-breakpoint

-- The current season of the current camp. Every season query asks this function.
CREATE FUNCTION public.current_year() RETURNS integer
  LANGUAGE sql STABLE
  AS $$
    SELECT current_year FROM public.camp_settings WHERE camp_id = public.current_camp_id()
  $$;--> statement-breakpoint

-- Deleting a person keeps their sign-in log rows but forgets who they were. A plain composite
-- SET NULL would also null camp_id (NOT NULL), so only person_id is nulled (PostgreSQL 15+).
ALTER TABLE "auth_event" DROP CONSTRAINT "auth_event_person_fk";--> statement-breakpoint
ALTER TABLE "auth_event" ADD CONSTRAINT "auth_event_person_fk"
  FOREIGN KEY ("camp_id", "person_id") REFERENCES "person"("camp_id", "id") ON DELETE SET NULL ("person_id");
