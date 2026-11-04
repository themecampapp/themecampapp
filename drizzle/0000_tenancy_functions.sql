-- Runs before the tables exist: every camp table's camp_id defaults to current_camp_id(), so the
-- function must exist first. Its body names the camp table, which 0001 creates, so body
-- checking is off for this transaction only.
SET LOCAL check_function_bodies = off;--> statement-breakpoint

-- The camp this transaction acts for: set with set_config('app.camp_id', <uuid>, true) at the
-- start of every transaction (never per session: Hyperdrive reuses connections). nullif()
-- matters: once the setting has been used on a pooled connection it reads '' rather than NULL.
-- With no camp set it returns NULL, so defaults fail and row-level security matches nothing.
--
-- BRIDGE (removed in U3): until the app sets a camp per transaction, a transaction with no camp
-- set acts for the only camp, if there is exactly one. With two or more camps it returns NULL,
-- so isolation still fails closed.
-- Tables are schema-qualified so a temporary table can't shadow them.
CREATE FUNCTION public.current_camp_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$
    SELECT coalesce(
      nullif(current_setting('app.camp_id', true), '')::uuid,
      (SELECT id FROM public.camp WHERE (SELECT count(*) FROM public.camp) = 1)
    )
  $$;
