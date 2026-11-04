CREATE TABLE "camp_signup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_name" text NOT NULL,
	"slug" text NOT NULL,
	"admins" jsonb NOT NULL,
	"season_year" integer NOT NULL,
	"camp_size" text,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_operator_id" uuid,
	"created_camp_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "camp_signup_status_ck" CHECK ("camp_signup"."status" in ('pending','approved','declined')),
	CONSTRAINT "camp_signup_name_ck" CHECK (char_length("camp_signup"."camp_name") between 1 and 80),
	CONSTRAINT "camp_signup_slug_ck" CHECK ("camp_signup"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "camp_signup_admins_ck" CHECK (jsonb_typeof("camp_signup"."admins") = 'array' and jsonb_array_length("camp_signup"."admins") between 1 and 5),
	CONSTRAINT "camp_signup_size_ck" CHECK ("camp_signup"."camp_size" is null or "camp_signup"."camp_size" in ('under_25','25_50','50_100','over_100')),
	CONSTRAINT "camp_signup_note_ck" CHECK ("camp_signup"."note" is null or char_length("camp_signup"."note") <= 1000),
	CONSTRAINT "camp_signup_decided_ck" CHECK (("camp_signup"."status" = 'pending') = ("camp_signup"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "camp_signup" ADD CONSTRAINT "camp_signup_decided_by_operator_id_operator_id_fk" FOREIGN KEY ("decided_by_operator_id") REFERENCES "public"."operator"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_signup" ADD CONSTRAINT "camp_signup_created_camp_id_camp_id_fk" FOREIGN KEY ("created_camp_id") REFERENCES "public"."camp"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "camp_signup_status_ix" ON "camp_signup" USING btree ("status","created_at");