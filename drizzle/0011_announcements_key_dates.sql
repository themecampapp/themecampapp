CREATE TABLE "announcement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"show_until" date NOT NULL,
	"created_by_person_id" uuid,
	"updated_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "announcement_camp_id_ux" UNIQUE("camp_id","id")
);
--> statement-breakpoint
CREATE TABLE "key_date" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"burn_id" uuid NOT NULL,
	"label" text NOT NULL,
	"date" date NOT NULL,
	"action" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "key_date_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "key_date_action_ck" CHECK ("key_date"."action" is null or "key_date"."action" in ('tickets_close','dues_due','rsvp_by'))
);
--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_created_by_fk" FOREIGN KEY ("camp_id","created_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "announcement" ADD CONSTRAINT "announcement_updated_by_fk" FOREIGN KEY ("camp_id","updated_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_date" ADD CONSTRAINT "key_date_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "key_date" ADD CONSTRAINT "key_date_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "announcement_camp_show_until_ix" ON "announcement" USING btree ("camp_id","show_until");--> statement-breakpoint
CREATE INDEX "key_date_camp_burn_date_ix" ON "key_date" USING btree ("camp_id","burn_id","date");--> statement-breakpoint
SELECT enable_camp_rls('announcement');--> statement-breakpoint
SELECT enable_camp_rls('key_date');
