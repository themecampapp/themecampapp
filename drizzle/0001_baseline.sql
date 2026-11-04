CREATE TABLE "app_setting" (
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"key" text NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_setting_pk" PRIMARY KEY("camp_id","key")
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"actor_person_id" uuid,
	"action" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"event" text NOT NULL,
	"email" text,
	"person_id" uuid,
	"ip" text,
	"user_agent" text,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "burn" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"year" integer NOT NULL,
	"dues_amount_cents" integer,
	"payment_instructions" text,
	"ticket_requests_locked" boolean DEFAULT false NOT NULL,
	"sap_days" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "burn_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "burn_camp_year_ux" UNIQUE("camp_id","year")
);
--> statement-breakpoint
CREATE TABLE "camp" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'camp' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"delete_after" timestamp with time zone,
	"daily_send_cap" integer DEFAULT 300 NOT NULL,
	"sending_paused" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "camp_slug_unique" UNIQUE("slug"),
	CONSTRAINT "camp_slug_ck" CHECK ("camp"."slug" ~ '^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$'),
	CONSTRAINT "camp_kind_ck" CHECK ("camp"."kind" in ('camp','demo')),
	CONSTRAINT "camp_status_ck" CHECK ("camp"."status" in ('active','suspended','pending_deletion'))
);
--> statement-breakpoint
CREATE TABLE "camp_position" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"title" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "camp_position_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "camp_position_camp_title_ux" UNIQUE("camp_id","title")
);
--> statement-breakpoint
CREATE TABLE "camp_settings" (
	"camp_id" uuid PRIMARY KEY DEFAULT current_camp_id() NOT NULL,
	"current_year" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"participation_id" uuid NOT NULL,
	"status" text DEFAULT 'unpaid' NOT NULL,
	"amount_cents" integer,
	"paid_on" date,
	"method" text,
	"flagged" boolean DEFAULT false NOT NULL,
	"updated_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dues_participation_id_unique" UNIQUE("participation_id"),
	CONSTRAINT "dues_status_ck" CHECK ("dues"."status" in ('unpaid','paid','waived')),
	CONSTRAINT "dues_method_ck" CHECK ("dues"."method" is null or "dues"."method" in ('venmo','zelle','cash','other'))
);
--> statement-breakpoint
CREATE TABLE "email_change" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"new_email" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_change_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "import_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"source_key" text NOT NULL,
	"source_sheet" text NOT NULL,
	"source_row" integer NOT NULL,
	"row_hash" text NOT NULL,
	"target_table" text NOT NULL,
	"target_id" uuid NOT NULL,
	"batch_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "import_record_camp_source_ux" UNIQUE("camp_id","source_key")
);
--> statement-breakpoint
CREATE TABLE "inquiry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"person_id" uuid,
	"name" text NOT NULL,
	"playa_name" text,
	"email" text,
	"phone" text,
	"heard_from" text,
	"note" text,
	"status" text DEFAULT 'new' NOT NULL,
	"source" text NOT NULL,
	"assigned_to_person_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"anonymized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inquiry_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "inquiry_status_ck" CHECK ("inquiry"."status" in ('new','contacted','met','invited','declined')),
	CONSTRAINT "inquiry_source_ck" CHECK ("inquiry"."source" in ('join_form','import'))
);
--> statement-breakpoint
CREATE TABLE "inquiry_note" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"inquiry_id" uuid NOT NULL,
	"author_person_id" uuid,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invite" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"sent_by_person_id" uuid,
	"sent_at" timestamp with time zone,
	"linked_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invite_status_ck" CHECK ("invite"."status" in ('pending','linked','revoked'))
);
--> statement-breakpoint
CREATE TABLE "lead_queue_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"kind" text NOT NULL,
	"person_id" uuid,
	"auth_user_id" text,
	"payload" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_person_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lead_queue_kind_ck" CHECK ("lead_queue_item"."kind" in ('link_conflict','shared_email','no_email','email_change_conflict','send_failure')),
	CONSTRAINT "lead_queue_status_ck" CHECK ("lead_queue_item"."status" in ('open','resolved'))
);
--> statement-breakpoint
CREATE TABLE "member_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text NOT NULL,
	"granted_by_person_id" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_by_person_id" uuid,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "member_role_role_ck" CHECK ("member_role"."role" in ('lead','treasurer','admin'))
);
--> statement-breakpoint
CREATE TABLE "participation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"person_id" uuid NOT NULL,
	"burn_id" uuid NOT NULL,
	"intent" text,
	"pre_burn_intent" text,
	"attended" boolean,
	"arrival_date" date,
	"departure_date" date,
	"sap_requested" boolean,
	"sap_date" date,
	"dwelling_description" text,
	"dwelling_size" text,
	"generator" boolean,
	"updated_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "participation_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "participation_intent_ck" CHECK ("participation"."intent" is null or "participation"."intent" in ('going','leaning_yes','leaning_no','not_going')),
	CONSTRAINT "participation_pre_burn_intent_ck" CHECK ("participation"."pre_burn_intent" is null or "participation"."pre_burn_intent" in ('yes_going','leaning_yes','leaning_no','not_sure','not_going'))
);
--> statement-breakpoint
CREATE TABLE "person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"legal_name" text NOT NULL,
	"playa_name" text,
	"email" text,
	"phone" text,
	"home_location" text,
	"auth_user_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"directory_hidden" boolean DEFAULT false NOT NULL,
	"directory_choice_seen_at" timestamp with time zone,
	"photo_key" text,
	"photo_updated_at" timestamp with time zone,
	"yearbook_show_first_name" boolean DEFAULT false NOT NULL,
	"note_2026" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_camp_id_ux" UNIQUE("camp_id","id")
);
--> statement-breakpoint
CREATE TABLE "position_holder" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"burn_id" uuid NOT NULL,
	"position_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"assigned_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sap_pass" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"burn_id" uuid NOT NULL,
	"valid_date" date NOT NULL,
	"serial" text NOT NULL,
	"pdf_key" text,
	"pdf_uploaded_at" timestamp with time zone,
	"holder_participation_id" uuid,
	"assigned_by_person_id" uuid,
	"assigned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sap_review" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"participation_id" uuid NOT NULL,
	"status" text NOT NULL,
	"approved_date" date,
	"flagged" boolean DEFAULT false NOT NULL,
	"decided_by_person_id" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sap_review_participation_id_unique" UNIQUE("participation_id"),
	CONSTRAINT "sap_review_status_ck" CHECK ("sap_review"."status" in ('approved','denied'))
);
--> statement-breakpoint
CREATE TABLE "send_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"participation_id" uuid NOT NULL,
	"tickets_needed" integer NOT NULL,
	"has_ticket_elsewhere" boolean DEFAULT false NOT NULL,
	"vehicle_pass_needed" boolean DEFAULT false NOT NULL,
	"note" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_request_participation_id_unique" UNIQUE("participation_id"),
	CONSTRAINT "ticket_request_count_ck" CHECK ("ticket_request"."tickets_needed" between 0 and 2)
);
--> statement-breakpoint
CREATE TABLE "volunteer_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"title" text NOT NULL,
	"commitment" text,
	"description" text,
	"slots" integer DEFAULT 1 NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"retired" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "volunteer_role_camp_id_ux" UNIQUE("camp_id","id"),
	CONSTRAINT "volunteer_role_slots_ck" CHECK ("volunteer_role"."slots" between 1 and 50)
);
--> statement-breakpoint
CREATE TABLE "volunteer_signup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"camp_id" uuid DEFAULT current_camp_id() NOT NULL,
	"burn_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"added_by_person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limit_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_setting" ADD CONSTRAINT "app_setting_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_fk" FOREIGN KEY ("camp_id","actor_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_event" ADD CONSTRAINT "auth_event_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_event" ADD CONSTRAINT "auth_event_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "burn" ADD CONSTRAINT "burn_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_position" ADD CONSTRAINT "camp_position_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD CONSTRAINT "camp_settings_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "camp_settings" ADD CONSTRAINT "camp_settings_current_year_fk" FOREIGN KEY ("camp_id","current_year") REFERENCES "public"."burn"("camp_id","year") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dues" ADD CONSTRAINT "dues_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dues" ADD CONSTRAINT "dues_participation_fk" FOREIGN KEY ("camp_id","participation_id") REFERENCES "public"."participation"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dues" ADD CONSTRAINT "dues_updated_by_fk" FOREIGN KEY ("camp_id","updated_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_change" ADD CONSTRAINT "email_change_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_change" ADD CONSTRAINT "email_change_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_record" ADD CONSTRAINT "import_record_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry" ADD CONSTRAINT "inquiry_assigned_to_fk" FOREIGN KEY ("camp_id","assigned_to_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_note" ADD CONSTRAINT "inquiry_note_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_note" ADD CONSTRAINT "inquiry_note_inquiry_fk" FOREIGN KEY ("camp_id","inquiry_id") REFERENCES "public"."inquiry"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inquiry_note" ADD CONSTRAINT "inquiry_note_author_fk" FOREIGN KEY ("camp_id","author_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_sent_by_fk" FOREIGN KEY ("camp_id","sent_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_queue_item" ADD CONSTRAINT "lead_queue_item_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_queue_item" ADD CONSTRAINT "lead_queue_item_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lead_queue_item" ADD CONSTRAINT "lead_queue_item_resolved_by_fk" FOREIGN KEY ("camp_id","resolved_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_granted_by_fk" FOREIGN KEY ("camp_id","granted_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_role" ADD CONSTRAINT "member_role_revoked_by_fk" FOREIGN KEY ("camp_id","revoked_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participation" ADD CONSTRAINT "participation_updated_by_fk" FOREIGN KEY ("camp_id","updated_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person" ADD CONSTRAINT "person_auth_user_id_user_id_fk" FOREIGN KEY ("auth_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_holder" ADD CONSTRAINT "position_holder_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_holder" ADD CONSTRAINT "position_holder_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_holder" ADD CONSTRAINT "position_holder_position_fk" FOREIGN KEY ("camp_id","position_id") REFERENCES "public"."camp_position"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_holder" ADD CONSTRAINT "position_holder_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "position_holder" ADD CONSTRAINT "position_holder_assigned_by_fk" FOREIGN KEY ("camp_id","assigned_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_pass" ADD CONSTRAINT "sap_pass_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_pass" ADD CONSTRAINT "sap_pass_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_pass" ADD CONSTRAINT "sap_pass_holder_fk" FOREIGN KEY ("camp_id","holder_participation_id") REFERENCES "public"."participation"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_pass" ADD CONSTRAINT "sap_pass_assigned_by_fk" FOREIGN KEY ("camp_id","assigned_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_review" ADD CONSTRAINT "sap_review_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_review" ADD CONSTRAINT "sap_review_participation_fk" FOREIGN KEY ("camp_id","participation_id") REFERENCES "public"."participation"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sap_review" ADD CONSTRAINT "sap_review_decided_by_fk" FOREIGN KEY ("camp_id","decided_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "send_log" ADD CONSTRAINT "send_log_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_request" ADD CONSTRAINT "ticket_request_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_request" ADD CONSTRAINT "ticket_request_participation_fk" FOREIGN KEY ("camp_id","participation_id") REFERENCES "public"."participation"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_request" ADD CONSTRAINT "ticket_request_updated_by_fk" FOREIGN KEY ("camp_id","updated_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_role" ADD CONSTRAINT "volunteer_role_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_camp_id_camp_id_fk" FOREIGN KEY ("camp_id") REFERENCES "public"."camp"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_burn_fk" FOREIGN KEY ("camp_id","burn_id") REFERENCES "public"."burn"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_role_fk" FOREIGN KEY ("camp_id","role_id") REFERENCES "public"."volunteer_role"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_person_fk" FOREIGN KEY ("camp_id","person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "volunteer_signup" ADD CONSTRAINT "volunteer_signup_added_by_fk" FOREIGN KEY ("camp_id","added_by_person_id") REFERENCES "public"."person"("camp_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_subject_ix" ON "audit_log" USING btree ("camp_id","subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_created_ix" ON "audit_log" USING btree ("actor_person_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_camp_created_ix" ON "audit_log" USING btree ("camp_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_event_created_ix" ON "auth_event" USING btree ("camp_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_event_email_created_ix" ON "auth_event" USING btree ("camp_id","email","created_at");--> statement-breakpoint
CREATE INDEX "email_change_person_ix" ON "email_change" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "inquiry_email_ix" ON "inquiry" USING btree ("camp_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "invite_one_pending_per_person_ux" ON "invite" USING btree ("person_id") WHERE "invite"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invite_email_ix" ON "invite" USING btree ("camp_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "member_role_active_ux" ON "member_role" USING btree ("person_id","role") WHERE "member_role"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "participation_person_burn_ux" ON "participation" USING btree ("person_id","burn_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_auth_user_ux" ON "person" USING btree ("camp_id","auth_user_id");--> statement-breakpoint
CREATE INDEX "person_email_ix" ON "person" USING btree ("camp_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "position_holder_ux" ON "position_holder" USING btree ("burn_id","position_id","person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sap_pass_burn_serial_ux" ON "sap_pass" USING btree ("burn_id","serial");--> statement-breakpoint
CREATE UNIQUE INDEX "sap_pass_holder_ux" ON "sap_pass" USING btree ("holder_participation_id") WHERE "sap_pass"."holder_participation_id" is not null;--> statement-breakpoint
CREATE INDEX "send_log_recipient_created_ix" ON "send_log" USING btree ("camp_id","recipient","created_at");--> statement-breakpoint
CREATE INDEX "send_log_camp_created_ix" ON "send_log" USING btree ("camp_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "volunteer_signup_ux" ON "volunteer_signup" USING btree ("burn_id","role_id","person_id");--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");