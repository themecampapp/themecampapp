CREATE TABLE "operator" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "operator_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"operator_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"subject_camp_id" uuid,
	"action" text NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operator_log_kind_ck" CHECK ("operator_log"."kind" in ('console_action','database_access'))
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_type" text DEFAULT 'person' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_operator_id" uuid;--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_operator_id_operator_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_subject_camp_id_camp_id_fk" FOREIGN KEY ("subject_camp_id") REFERENCES "public"."camp"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_log_created_ix" ON "operator_log" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_operator_id_operator_id_fk" FOREIGN KEY ("actor_operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_ck" CHECK (("audit_log"."actor_type" = 'operator') = ("audit_log"."actor_operator_id" is not null) and ("audit_log"."actor_type" <> 'operator' or "audit_log"."actor_person_id" is null));--> statement-breakpoint
-- The operator console's only read across camps (R38): numbers per camp, never a name, an
-- email or anything a camp wrote. Runs as app_definer; scripts/db-grants.ts gives it to
-- app_platform only.
CREATE FUNCTION public.camp_counts() RETURNS TABLE (
    camp_id uuid,
    members integer,
    invites_pending integer,
    emails_sent_7d integer,
    bounces_7d integer,
    complaints_7d integer,
    last_activity timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT c.id,
      (SELECT count(*)::int FROM public.person p WHERE p.camp_id = c.id AND p.active),
      (SELECT count(*)::int FROM public.invite i WHERE i.camp_id = c.id AND i.status = 'pending'),
      (SELECT count(*)::int FROM public.send_log s
        WHERE s.camp_id = c.id AND s.status = 'sent' AND s.created_at > now() - interval '7 days'),
      (SELECT count(*)::int FROM public.send_log s
        WHERE s.camp_id = c.id AND s.outcome = 'bounced' AND s.created_at > now() - interval '7 days'),
      (SELECT count(*)::int FROM public.send_log s
        WHERE s.camp_id = c.id AND s.outcome = 'complained' AND s.created_at > now() - interval '7 days'),
      greatest(
        (SELECT max(a.created_at) FROM public.audit_log a WHERE a.camp_id = c.id),
        (SELECT max(e.created_at) FROM public.auth_event e WHERE e.camp_id = c.id)
      )
    FROM public.camp c
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.camp_counts() FROM PUBLIC;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.camp_counts() OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
