CREATE TABLE "companies_catalog" (
	"name" varchar(128) PRIMARY KEY NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"product_id" integer DEFAULT 4 NOT NULL,
	"version" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"company_db" varchar(128),
	"user_id" integer,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_agent" text
);
