CREATE TABLE "import_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"created_by_person_id" uuid NOT NULL,
	"file_name" text NOT NULL,
	"file_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"rows" jsonb,
	"summary" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "import_batch_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "import_batch_status_ck" CHECK ("import_batch"."status" in ('pending','applied'))
);
--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_batch" ADD CONSTRAINT "import_batch_created_by_fk" FOREIGN KEY ("camp_id","created_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
SELECT enable_camp_rls('import_batch');
