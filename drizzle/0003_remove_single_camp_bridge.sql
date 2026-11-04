-- U3: every request now sets its camp on every transaction (app/lib/tenancy.server.ts), so the
-- "only camp" fallback from 0000 goes. With no camp set, current_camp_id() is NULL: camp_id
-- defaults fail and row-level security matches nothing, however many camps exist.
CREATE OR REPLACE FUNCTION public.current_camp_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT nullif(current_setting('app.camp_id', true), '')::uuid
  $$;
