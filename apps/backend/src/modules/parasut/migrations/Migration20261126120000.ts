import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261126120000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "parasut_connection" ("id" text not null, "client_id" text null, "env" text null, "refresh_token" text null, "refresh_expires_at" timestamptz null, "access_token" text null, "access_expires_at" timestamptz null, "scope" text null, "connected_at" timestamptz null, "connected_by" text null, "last_refreshed_at" timestamptz null, "last_error" text null, "last_error_at" timestamptz null, "pending_state" text null, "pending_verifier" text null, "pending_expires_at" timestamptz null, "pending_actor" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "parasut_connection_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_parasut_connection_deleted_at" ON "parasut_connection" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "parasut_connection" cascade;`);
  }

}
