CREATE TABLE "search_export_checkpoints" (
	"generation_id" uuid NOT NULL,
	"source" text NOT NULL,
	"organization_id" uuid,
	"cursor" text,
	"complete" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_export_checkpoints_scope_unique" UNIQUE NULLS NOT DISTINCT("generation_id","source","organization_id"),
	CONSTRAINT "search_export_checkpoints_source_check" CHECK ("search_export_checkpoints"."source" in ('organization', 'task', 'list', 'space', 'document', 'storage')),
	CONSTRAINT "search_export_checkpoints_scope_check" CHECK (("search_export_checkpoints"."source" = 'organization' and "search_export_checkpoints"."organization_id" is null) or ("search_export_checkpoints"."source" <> 'organization' and "search_export_checkpoints"."organization_id" is not null)),
	CONSTRAINT "search_export_checkpoints_cursor_length_check" CHECK ("search_export_checkpoints"."cursor" is null or length("search_export_checkpoints"."cursor") between 1 and 1024)
);
--> statement-breakpoint
ALTER TABLE "search_export_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_index_generations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"index_uid" text NOT NULL,
	"status" text NOT NULL,
	"engine_created_at" text,
	"broker_at_start" jsonb NOT NULL,
	"certified_broker_frontier" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_index_generations_uid_length_check" CHECK (length("search_index_generations"."index_uid") between 1 and 512),
	CONSTRAINT "search_index_generations_status_check" CHECK ("search_index_generations"."status" in ('building', 'active', 'abandoned', 'retired')),
	CONSTRAINT "search_index_generations_frontier_check" CHECK ("search_index_generations"."certified_broker_frontier" is null or "search_index_generations"."certified_broker_frontier" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "search_index_generations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_pending_refreshes" (
	"generation_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"resource_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"max_broker_sequence" bigint NOT NULL,
	"revision" bigint DEFAULT 1 NOT NULL,
	"claim_token" uuid,
	"claim_deadline" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_pending_refreshes_generation_id_organization_id_resource_kind_source_id_pk" PRIMARY KEY("generation_id","organization_id","resource_kind","source_id"),
	CONSTRAINT "search_pending_refreshes_kind_check" CHECK ("search_pending_refreshes"."resource_kind" in ('task', 'list', 'space', 'document', 'storage')),
	CONSTRAINT "search_pending_refreshes_source_length_check" CHECK (length("search_pending_refreshes"."source_id") between 1 and 512),
	CONSTRAINT "search_pending_refreshes_sequence_check" CHECK ("search_pending_refreshes"."max_broker_sequence" between 1 and 9007199254740991),
	CONSTRAINT "search_pending_refreshes_revision_check" CHECK ("search_pending_refreshes"."revision" between 1 and 9007199254740991),
	CONSTRAINT "search_pending_refreshes_claim_check" CHECK (("search_pending_refreshes"."claim_token" is null and "search_pending_refreshes"."claim_deadline" is null) or ("search_pending_refreshes"."claim_token" is not null and "search_pending_refreshes"."claim_deadline" is not null))
);
--> statement-breakpoint
ALTER TABLE "search_pending_refreshes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_rebuild_control" (
	"id" integer PRIMARY KEY NOT NULL,
	CONSTRAINT "search_rebuild_control_singleton_check" CHECK ("search_rebuild_control"."id" = 1)
);
--> statement-breakpoint
ALTER TABLE "search_rebuild_control" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "search_terminal_advisories" (
	"stream" text NOT NULL,
	"stream_created_at" text NOT NULL,
	"consumer" text NOT NULL,
	"sequence" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "search_terminal_advisories_stream_stream_created_at_consumer_sequence_pk" PRIMARY KEY("stream","stream_created_at","consumer","sequence"),
	CONSTRAINT "search_terminal_advisories_sequence_check" CHECK ("search_terminal_advisories"."sequence" between 1 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "search_terminal_advisories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_export_checkpoints" ADD CONSTRAINT "search_export_checkpoints_generation_id_search_index_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."search_index_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_pending_refreshes" ADD CONSTRAINT "search_pending_refreshes_generation_id_search_index_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."search_index_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_index_generations_uid_unique" ON "search_index_generations" USING btree ("index_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "search_index_generations_building_unique" ON "search_index_generations" USING btree ("status") WHERE "search_index_generations"."status" = 'building';--> statement-breakpoint
CREATE UNIQUE INDEX "search_index_generations_active_unique" ON "search_index_generations" USING btree ("status") WHERE "search_index_generations"."status" = 'active';--> statement-breakpoint
CREATE INDEX "search_pending_refreshes_claim_index" ON "search_pending_refreshes" USING btree ("generation_id","claim_deadline","max_broker_sequence","organization_id","resource_kind","source_id");--> statement-breakpoint
CREATE INDEX "search_terminal_advisories_unresolved_index" ON "search_terminal_advisories" USING btree ("created_at") WHERE "search_terminal_advisories"."resolved_at" is null;--> statement-breakpoint
CREATE POLICY "search_export_checkpoints_system_only" ON "search_export_checkpoints" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "search_index_generations_system_only" ON "search_index_generations" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "search_pending_refreshes_system_only" ON "search_pending_refreshes" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "search_rebuild_control_system_only" ON "search_rebuild_control" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
CREATE POLICY "search_terminal_advisories_system_only" ON "search_terminal_advisories" AS PERMISSIVE FOR ALL TO public USING (current_setting('app.system_access', true) = 'on') WITH CHECK (current_setting('app.system_access', true) = 'on');--> statement-breakpoint
-- Seed the migration-owned mutex before forcing its system-only policy.
INSERT INTO "search_rebuild_control" ("id") VALUES (1);--> statement-breakpoint
-- Drizzle enables row-level security but does not force it for the table owner.
ALTER TABLE "search_export_checkpoints" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_index_generations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_pending_refreshes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_rebuild_control" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_terminal_advisories" FORCE ROW LEVEL SECURITY;
