CREATE TABLE "platform_alert" (
	"key" text PRIMARY KEY NOT NULL,
	"detail" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
