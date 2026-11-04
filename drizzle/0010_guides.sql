CREATE TABLE "guide" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone,
	"updated_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guide_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "guide_camp_slug_ux" UNIQUE("camp_id","slug"),
	CONSTRAINT "guide_slug_ck" CHECK ("guide"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,78}[a-z0-9])?$'),
	CONSTRAINT "guide_visibility_ck" CHECK ("guide"."visibility" in ('public','members','leads'))
);
--> statement-breakpoint
ALTER TABLE "guide" ADD CONSTRAINT "guide_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guide" ADD CONSTRAINT "guide_updated_by_fk" FOREIGN KEY ("camp_id","updated_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT enable_camp_rls('guide');
