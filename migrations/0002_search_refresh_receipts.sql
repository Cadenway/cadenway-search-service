CREATE TABLE "search_refresh_receipts" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "search_refresh_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "search_refresh_receipts_processed_index" ON "search_refresh_receipts" USING btree ("processed_at");--> statement-breakpoint
CREATE POLICY "search_refresh_receipts_system_only" ON "search_refresh_receipts" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
-- Drizzle enables row-level security but does not force it for the table owner.
ALTER TABLE "search_refresh_receipts" FORCE ROW LEVEL SECURITY;
