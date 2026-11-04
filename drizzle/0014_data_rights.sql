CREATE TABLE "camp_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"key" text NOT NULL,
	"bytes" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "camp_export_camp_id_ux" UNIQUE("camp_id","id")
);
--> statement-breakpoint
CREATE TABLE "data_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"kind" text NOT NULL,
	"requester_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_expires_at" timestamp with time zone NOT NULL,
	"confirmed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_by_operator_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_request_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "data_request_kind_ck" CHECK ("data_request"."kind" in ('export','delete_camp','delete_login'))
);
--> statement-breakpoint
ALTER TABLE "operator_log" DROP CONSTRAINT "operator_log_kind_ck";--> statement-breakpoint
ALTER TABLE "operator_log" ALTER COLUMN "operator_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "privacy_notice_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "camp_export" ADD CONSTRAINT "camp_export_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_request" ADD CONSTRAINT "data_request_created_by_operator_id_operator_id_fk" FOREIGN KEY ("created_by_operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_request_token_ux" ON "data_request" USING btree ("token_hash");--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_actor_ck" CHECK (("operator_log"."kind" = 'system_job') = ("operator_log"."operator_id" is null));--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_kind_ck" CHECK ("operator_log"."kind" in ('console_action','database_access','system_job'));--> statement-breakpoint
SELECT enable_camp_rls('data_request');--> statement-breakpoint
SELECT enable_camp_rls('camp_export');--> statement-breakpoint

-- A camp is only ever deleted 30 days after it was marked for deletion (R44), whoever asks.
-- The cascade then removes every camp-owned row (foreign-key actions skip row-level security).
CREATE FUNCTION public.camp_delete_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF OLD.status <> 'pending_deletion' OR OLD.delete_after IS NULL OR OLD.delete_after > now() THEN
      RAISE EXCEPTION 'camp % is not due for deletion', OLD.slug;
    END IF;
    RETURN OLD;
  END
  $$;--> statement-breakpoint
CREATE TRIGGER camp_delete_guard BEFORE DELETE ON public.camp
  FOR EACH ROW EXECUTE FUNCTION public.camp_delete_guard();--> statement-breakpoint

-- The console's list of data requests across camps: never the requester's email.
CREATE FUNCTION public.data_requests() RETURNS TABLE (
    id uuid,
    camp_id uuid,
    kind text,
    created_at timestamptz,
    token_expires_at timestamptz,
    confirmed_at timestamptz,
    completed_at timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT r.id, r.camp_id, r.kind, r.created_at, r.token_expires_at, r.confirmed_at, r.completed_at
    FROM public.data_request r ORDER BY r.created_at DESC LIMIT 200
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.data_requests() FROM PUBLIC;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.data_requests() OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;--> statement-breakpoint

-- Login deletion (R45) without giving the platform Worker Better Auth's tables: the id of the
-- login with this email, and removing that login with its pending magic links.
CREATE FUNCTION public.login_id(address text) RETURNS text
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    SELECT id FROM public."user" WHERE lower(email) = lower(address)
  $$;--> statement-breakpoint
-- A pending link carries the email in its JSON value: an exact substring match, never LIKE (an
-- email may contain % or _). Sessions and accounts cascade from the user row.
CREATE FUNCTION public.forget_login(address text) RETURNS void
  LANGUAGE sql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
    DELETE FROM public.verification WHERE strpos(value, to_json(lower(address))::text) > 0;
    DELETE FROM public."user" WHERE lower(email) = lower(address);
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.login_id(text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.forget_login(text) FROM PUBLIC;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.login_id(text) OWNER TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.forget_login(text) OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
