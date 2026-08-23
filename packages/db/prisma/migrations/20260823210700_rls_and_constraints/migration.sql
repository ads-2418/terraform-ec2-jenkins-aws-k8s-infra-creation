-- Hand-written migration (Prisma's schema language cannot express any of
-- this): Row-Level Security policies for tenant isolation, the partial
-- unique index that is the real double-booking guard, and the audit_log
-- immutability trigger.
--
-- See docs/DATABASE.md §1, §3, §6 and docs/SECURITY.md §3, §9 for the
-- rationale. The application sets `SET LOCAL app.tenant_id = '<uuid>'` at
-- the start of every transaction (packages/db/src/tenant-context.ts) -
-- derived server-side from the authenticated principal, never from
-- client input.

-- ---------------------------------------------------------------------------
-- The actual double-booking guard: at most one HELD/CONFIRMED appointment
-- may exist per slot at any instant. Older EXPIRED/CANCELLED/COMPLETED/
-- NO_SHOW/RESCHEDULED rows for the same slot are expected to accumulate
-- over its lifetime and are NOT covered by this index.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "uq_appointment_active_slot"
  ON "appointments" ("slot_id")
  WHERE "status" IN ('HELD', 'CONFIRMED');

-- ---------------------------------------------------------------------------
-- Row-Level Security
--
-- IMPORTANT: in production the role the application connects as must NOT
-- be the role that owns these tables (migrations run as a separate,
-- more-privileged role) and must have BYPASSRLS revoked - table owners
-- and superusers bypass RLS regardless of ENABLE/FORCE. In this local dev
-- setup a single role does both, so FORCE ROW LEVEL SECURITY is what
-- makes the policies actually apply here too.
-- ---------------------------------------------------------------------------

-- Strictly tenant-scoped tables: tenant_id is NOT NULL, exactly one policy.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinics', 'role_assignments',
    'doctors', 'staff', 'services', 'patients',
    'doctor_availability', 'slots', 'appointments', 'appointment_events',
    'idempotency_keys',
    'calendar_connections', 'calendar_busy_blocks',
    'whatsapp_sessions', 'whatsapp_messages',
    'notification_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''));',
      t
    );
  END LOOP;
END $$;

-- Tables where tenant_id is nullable (platform-level rows: platform admin
-- users, platform-level audit entries). Two policies (permissive, OR'd by
-- Postgres): the normal tenant match, plus an explicit "no tenant context
-- set -> only platform-level rows" case. Fails closed: with app.tenant_id
-- unset, tenant-scoped rows are invisible; with it set, platform-level
-- (NULL tenant_id) rows are invisible too - a tenant session never sees
-- platform-admin data.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users', 'audit_log']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''));',
      t
    );
    EXECUTE format(
      'CREATE POLICY platform_level_access ON %I USING (tenant_id IS NULL AND NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL);',
      t
    );
  END LOOP;
END $$;

-- `api_keys` and `refresh_tokens` are looked up by an opaque, high-entropy
-- secret hash (the raw API key / refresh token) BEFORE the caller's tenant
-- is known at all - that lookup is how the tenant gets resolved in the
-- first place, so a strict tenant_isolation policy would make the
-- bootstrap query unable to find its own row. Two policies instead: the
-- normal tenant match (so a dashboard listing "my tenant's API keys"
-- still only sees its own tenant, once a context IS set), plus a
-- "no tenant context set -> all rows visible" bootstrap policy. This is
-- safe only because every bootstrap-mode query the application issues is
-- a `WHERE hashed_key = $1` / `WHERE token_hash = $1` exact match on a
-- unique, unguessable value - never an unfiltered scan. See
-- packages/db/src/tenant-context.ts and docs/SECURITY.md §1.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_keys', 'refresh_tokens']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY;', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), ''''));',
      t
    );
    EXECUTE format(
      'CREATE POLICY bootstrap_lookup ON %I USING (NULLIF(current_setting(''app.tenant_id'', true), '''') IS NULL);',
      t
    );
  END LOOP;
END $$;

-- `tenants` itself is not tenant-scoped (it IS the tenant) and stays
-- readable without a tenant context (the login/tenant-resolution path
-- needs to look up a tenant by slug before a tenant context exists). It is
-- intentionally excluded from RLS - platform-admin-only mutation is
-- enforced at the application/RBAC layer, not RLS, since every row must
-- remain resolvable pre-authentication.

-- ---------------------------------------------------------------------------
-- audit_log immutability
--
-- The REVOKE below documents intent for the production topology (a
-- migration/admin role distinct from the runtime app role) but is not
-- itself sufficient here since table ownership grants implicit privileges
-- that REVOKE cannot remove. The trigger is what actually enforces
-- immutability regardless of role or ownership.
-- ---------------------------------------------------------------------------
REVOKE UPDATE, DELETE ON "audit_log" FROM PUBLIC;

CREATE OR REPLACE FUNCTION audit_log_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
