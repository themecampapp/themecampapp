CREATE TABLE "camp_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"builtin" text,
	"name" text,
	"description" text,
	"grants" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "camp_role_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "camp_role_kind_ck" CHECK (("camp_role"."builtin" is null) = ("camp_role"."name" is not null)),
	CONSTRAINT "camp_role_name_ck" CHECK ("camp_role"."name" is null or char_length("camp_role"."name") between 1 and 40),
	CONSTRAINT "camp_role_description_ck" CHECK ("camp_role"."description" is null or char_length("camp_role"."description") <= 200),
	CONSTRAINT "camp_role_builtin_archived_ck" CHECK ("camp_role"."builtin" is null or "camp_role"."archived_at" is null)
);
--> statement-breakpoint
ALTER TABLE "member_role" DROP CONSTRAINT "member_role_role_ck";--> statement-breakpoint
DROP INDEX "member_role_active_ux";--> statement-breakpoint
ALTER TABLE "member_role" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "camp_role" ADD CONSTRAINT "camp_role_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "camp_role_builtin_ux" ON "camp_role" USING btree ("camp_id","builtin") WHERE "camp_role"."builtin" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "camp_role_name_ux" ON "camp_role" USING btree ("camp_id",lower("name")) WHERE "camp_role"."name" is not null and "camp_role"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_custom_role_fk" FOREIGN KEY ("camp_id","custom_role_id") REFERENCES "public"."camp_role"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_role_custom_active_ux" ON "member_role" USING btree ("person_id","custom_role_id") WHERE "member_role"."revoked_at" is null and "member_role"."role" = 'custom';--> statement-breakpoint
CREATE UNIQUE INDEX "member_role_active_ux" ON "member_role" USING btree ("person_id","role") WHERE "member_role"."revoked_at" is null and "member_role"."role" <> 'custom';--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_custom_ck" CHECK (("member_role"."role" = 'custom') = ("member_role"."custom_role_id" is not null));--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_role_ck" CHECK ("member_role"."role" in ('lead','treasurer','admin','custom'));--> statement-breakpoint
SELECT enable_camp_rls('camp_role');
