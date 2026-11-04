CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_camp_id" uuid NOT NULL,
	"path" text NOT NULL,
	"role" text NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notified_at" timestamp with time zone,
	CONSTRAINT "feedback_role_ck" CHECK ("feedback"."role" in ('member','lead','treasurer','admin')),
	CONSTRAINT "feedback_message_ck" CHECK (length("feedback"."message") between 1 and 4000),
	CONSTRAINT "feedback_path_ck" CHECK ("feedback"."path" like '/%' and length("feedback"."path") <= 200)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_source_camp_id_camp_id_fk" FOREIGN KEY ("source_camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_created_ix" ON "feedback" USING btree ("created_at");--> statement-breakpoint

-- R65: the camp Worker's only way to the feedback table. It adds a row for the camp the
-- request is for (never one the caller names), and never reads anything back. A camp can send
-- at most 30 an hour, so the operator's inbox and the table can't be flooded.
CREATE FUNCTION public.submit_feedback(p_path text, p_role text, p_message text) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, public
  AS $$
  DECLARE
    camp uuid := public.current_camp_id();
  BEGIN
    IF camp IS NULL THEN
      RAISE EXCEPTION 'no camp is set';
    END IF;
    IF (SELECT count(*) FROM public.feedback
        WHERE source_camp_id = camp AND created_at > now() - interval '1 hour') >= 30 THEN
      RAISE EXCEPTION 'feedback_rate_limited';
    END IF;
    INSERT INTO public.feedback (source_camp_id, path, role, message)
    VALUES (camp, p_path, p_role, p_message);
  END
  $$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.submit_feedback(text, text, text) FROM PUBLIC;--> statement-breakpoint
GRANT CREATE ON SCHEMA public TO app_definer;--> statement-breakpoint
ALTER FUNCTION public.submit_feedback(text, text, text) OWNER TO app_definer;--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM app_definer;
