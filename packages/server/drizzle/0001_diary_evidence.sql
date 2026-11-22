CREATE TABLE "diary_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"entry_date" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "diary_fact_evidences" (
	"fact_id" text PRIMARY KEY NOT NULL,
	"diary_id" text NOT NULL,
	"quote" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_entries" ADD CONSTRAINT "diary_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_fact_evidences" ADD CONSTRAINT "diary_fact_evidences_fact_id_structured_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."structured_facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diary_fact_evidences" ADD CONSTRAINT "diary_fact_evidences_diary_id_diary_entries_id_fk" FOREIGN KEY ("diary_id") REFERENCES "public"."diary_entries"("id") ON DELETE cascade ON UPDATE no action;