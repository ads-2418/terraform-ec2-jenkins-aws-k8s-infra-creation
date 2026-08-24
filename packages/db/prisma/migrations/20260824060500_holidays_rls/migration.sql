-- Row-Level Security for the new `holidays` table - same pattern as the
-- other strictly tenant-scoped tables in 20260823210700_rls_and_constraints
-- (that migration is already applied, so this one is deliberately separate
-- rather than editing history).
ALTER TABLE "holidays" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "holidays" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "holidays"
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), ''));
