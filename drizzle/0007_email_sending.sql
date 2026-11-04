CREATE TABLE "email_suppression" (
	"email" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppression_reason_ck" CHECK ("email_suppression"."reason" in ('bounce','complaint'))
);
--> statement-breakpoint
CREATE TABLE "email_webhook_event" (
	"event_id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "send_log" ADD COLUMN "provider_id" text;--> statement-breakpoint
ALTER TABLE "send_log" ADD COLUMN "outcome" text;--> statement-breakpoint
CREATE INDEX "send_log_provider_ix" ON "send_log" USING btree ("provider_id");--> statement-breakpoint
-- Two narrow reads across camps, run as app_definer (NOLOGIN, BYPASSRLS) with a pinned
-- search_path. scripts/db-grants.ts gives each to one role and checks the owner.

-- Camp Worker: which of these addresses no camp may email. Returns only addresses it was given,
-- so it never reveals the rest of the list.
CREATE FUNCTION public.suppressed_emails(addresses text[]) RETURNS SETOF text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT email FROM public.email_suppression
    WHERE email IN (SELECT lower(a) FROM unnest(addresses) AS a)
  $$;--> statement-breakpoint

-- Platform Worker (email webhook): the camp that sent a message, by the provider's id, and
-- only if it went to this address. The webhook acts only on events that match a real send, so
-- a forged event (the webhook's secret is a static bearer token) can't suppress or pause
-- anything without also knowing a message id. The webhook then works inside that camp under
-- row-level security.
CREATE FUNCTION public.send_log_camp(message_id text, address text) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT camp_id FROM public.send_log
    WHERE provider_id = message_id AND lower(recipient) = lower(address)
    LIMIT 1
  $$;--> statement-breakpoint

REVOKE ALL ON FUNCTION public.suppressed_emails(text[]) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.send_log_camp(text, text) FROM PUBLIC;--> statement-breakpoint
-- As in 0005: app_definer needs CREATE on the schema only while taking ownership.
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.suppressed_emails(text[]) OWNER TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.send_log_camp(text, text) OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
