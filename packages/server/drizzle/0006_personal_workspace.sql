CREATE TABLE "personal_workspaces" (
    "user_id" text PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "state" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_vectors" (
    "user_id" text NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
    "document_id" text NOT NULL,
    "signature" text NOT NULL,
    "embedding" jsonb NOT NULL,
    PRIMARY KEY ("user_id", "document_id")
);
