-- The only reads across camps the camp Worker may make, both about one login. They run as
-- app_definer (NOLOGIN, BYPASSRLS), return nothing but camp ids or a yes/no, and pin their
-- search_path. scripts/db-grants.ts lets only app_runtime execute them and checks their owner.

-- The camps where this login has a person (active or not): used to keep the person's email in
-- step with the login when it changes. Camp ids only, never names.
CREATE FUNCTION public.login_camps(login_id text) RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT DISTINCT camp_id FROM public.person WHERE auth_user_id = login_id
  $$;--> statement-breakpoint

-- Whether an email is already someone else's, in any camp: another login uses it, or an active
-- person not linked to this login has it. Only yes or no.
CREATE FUNCTION public.email_in_use(address text, login_id text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT exists (
      SELECT 1 FROM public."user" WHERE lower(email) = lower(address) AND id <> login_id
    ) OR exists (
      SELECT 1 FROM public.person
      WHERE lower(email) = lower(address) AND active
        AND auth_user_id IS DISTINCT FROM login_id
    )
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.login_camps(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.email_in_use(text, text) FROM PUBLIC;--> statement-breakpoint
-- A new owner needs CREATE on the schema. app_definer gets it only for these two statements:
-- it keeps ownership afterwards, but never the right to create anything.
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.login_camps(text) OWNER TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.email_in_use(text, text) OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
