CREATE TABLE "diary_saved_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diary_entries" ADD COLUMN "filename" text;--> statement-breakpoint
ALTER TABLE "diary_fact_evidences" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "diary_fact_evidences" DROP CONSTRAINT "diary_fact_evidences_pkey";--> statement-breakpoint
ALTER TABLE "diary_fact_evidences" ADD CONSTRAINT "diary_fact_evidences_fact_id_ordinal_pk" PRIMARY KEY("fact_id","ordinal");--> statement-breakpoint
ALTER TABLE "diary_saved_batches" ADD CONSTRAINT "diary_saved_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;