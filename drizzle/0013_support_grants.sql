CREATE TABLE "support_grant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by_person_id" uuid,
	"ended_notified_at" timestamp with time zone,
	"token_hash" text,
	"token_expires_at" timestamp with time zone,
	"token_used_at" timestamp with time zone,
	"session_hash" text,
	"opened_by_operator_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "support_grant_camp_id_ux" UNIQUE("camp_id","id")
);
--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_opened_by_operator_id_operator_id_fk" FOREIGN KEY ("opened_by_operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_created_by_fk" FOREIGN KEY ("camp_id","created_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grant" ADD CONSTRAINT "support_grant_revoked_by_fk" FOREIGN KEY ("camp_id","revoked_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "support_grant_token_ux" ON "support_grant" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "support_grant_session_ux" ON "support_grant" USING btree ("session_hash");--> statement-breakpoint
SELECT enable_camp_rls('support_grant');
