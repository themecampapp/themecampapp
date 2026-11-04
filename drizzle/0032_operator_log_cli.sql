-- Open-source plan 3.3: commands run with the owner connection (scripts/create-camp.ts) write the
-- operator log as "cli", with no operator, like the scheduled jobs.
ALTER TABLE "operator_log" DROP CONSTRAINT "operator_log_kind_ck";--> statement-breakpoint
ALTER TABLE "operator_log" DROP CONSTRAINT "operator_log_actor_ck";--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_kind_ck" CHECK ("operator_log"."kind" in ('console_action','database_access','system_job','cli'));--> statement-breakpoint
ALTER TABLE "operator_log" ADD CONSTRAINT "operator_log_actor_ck" CHECK (("operator_log"."kind" in ('system_job','cli')) = ("operator_log"."operator_id" is null));