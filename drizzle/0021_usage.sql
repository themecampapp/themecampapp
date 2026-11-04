CREATE TABLE "usage_daily" (
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"day" date DEFAULT current_date NOT NULL,
	"metric" text NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "usage_daily_camp_id_day_metric_pk" PRIMARY KEY("camp_id","day","metric"),
	CONSTRAINT "usage_daily_metric_ck" CHECK ("usage_daily"."metric" ~ '^[a-z_]+:[A-Za-z0-9_.$/:-]{1,160}$')
);
--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "last_seen_on" date;--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
SELECT enable_camp_rls('usage_daily');--> statement-breakpoint

-- R74: the console's usage numbers, across camps, as (camp, day, metric, count) and nothing
-- else: never a name, an email, a URL or anything a camp wrote. Metrics are fixed names plus
-- route ids, audit action names and sign-in event names. Runs as app_definer; scripts/db-grants.ts
-- gives it to app_platform only. At most 400 days back.
CREATE FUNCTION public.camp_usage(since date) RETURNS TABLE (
    camp_id uuid,
    day date,
    metric text,
    count integer
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    WITH bounds AS (SELECT greatest(since, current_date - 400) AS since)
    -- Counted as it happens by the camp Worker: views, error responses, browser errors.
    SELECT u.camp_id, u.day, u.metric, u.count
    FROM public.usage_daily u, bounds WHERE u.day >= bounds.since
    UNION ALL
    -- Features used: the audit log's action names.
    SELECT a.camp_id, a.created_at::date, 'action:' || a.action, count(*)::int
    FROM public.audit_log a, bounds WHERE a.created_at >= bounds.since
    GROUP BY 1, 2, 3
    UNION ALL
    -- Sign-in: the sign-in log's event names, and why a sign-in failed (a fixed error code).
    SELECT e.camp_id, e.created_at::date,
      'auth:' || e.event || CASE
        WHEN e.event <> 'sign_in_failed' THEN ''
        WHEN e.detail->>'error' ~ '^[a-z_]{1,40}$' THEN ':' || (e.detail->>'error')
        ELSE ':other' END,
      count(*)::int
    FROM public.auth_event e, bounds WHERE e.created_at >= bounds.since
    GROUP BY 1, 2, 3
    UNION ALL
    -- Email: sent, held (skipped, suppressed, paused, capped) and failed; bounces, complaints.
    SELECT s.camp_id, s.created_at::date, 'mail:' || s.status, count(*)::int
    FROM public.send_log s, bounds WHERE s.created_at >= bounds.since
    GROUP BY 1, 2, 3
    UNION ALL
    SELECT s.camp_id, s.created_at::date, 'mail:' || s.outcome, count(*)::int
    FROM public.send_log s, bounds WHERE s.created_at >= bounds.since AND s.outcome IS NOT NULL
    GROUP BY 1, 2, 3
    UNION ALL
    -- Join-form inquiries.
    SELECT i.camp_id, i.created_at::date, 'join:inquiry', count(*)::int
    FROM public.inquiry i, bounds WHERE i.created_at >= bounds.since
    GROUP BY 1, 2, 3
    UNION ALL
    -- Distinct members who used the app in the last 7 and 30 days (today's figure only).
    SELECT p.camp_id, current_date, 'active:7d', count(*)::int
    FROM public.person p WHERE p.last_seen_on > current_date - 7 GROUP BY 1
    UNION ALL
    SELECT p.camp_id, current_date, 'active:30d', count(*)::int
    FROM public.person p WHERE p.last_seen_on > current_date - 30 GROUP BY 1
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.camp_usage(date) FROM PUBLIC;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.camp_usage(date) OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
