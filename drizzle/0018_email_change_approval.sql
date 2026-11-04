ALTER TABLE "email_change" ALTER COLUMN "token_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "email_change" ADD COLUMN "approve_token_hash" text;--> statement-breakpoint
ALTER TABLE "email_change" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "email_change" ADD CONSTRAINT "email_change_approve_token_hash_unique" UNIQUE("approve_token_hash");