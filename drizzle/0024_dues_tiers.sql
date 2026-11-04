CREATE TABLE "dues_tier" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"burn_id" uuid NOT NULL,
	"name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dues_tier_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "dues_tier_name_ck" CHECK (char_length("dues_tier"."name") between 1 and 60),
	CONSTRAINT "dues_tier_amount_ck" CHECK ("dues_tier"."amount_cents" between 0 and 10000000)
);
--> statement-breakpoint
ALTER TABLE "dues" ADD COLUMN "tier_id" uuid;--> statement-breakpoint
ALTER TABLE "dues_tier" ADD CONSTRAINT "dues_tier_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dues_tier" ADD CONSTRAINT "dues_tier_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dues_tier_name_ux" ON "dues_tier" USING btree ("burn_id",lower("name"));--> statement-breakpoint
ALTER TABLE "dues" ADD CONSTRAINT "dues_tier_fk" FOREIGN KEY ("camp_id","tier_id") REFERENCES "public"."dues_tier"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT enable_camp_rls('dues_tier');