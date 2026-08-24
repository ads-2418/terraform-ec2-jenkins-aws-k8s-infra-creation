// Unconditional, not `??=`: these tests TRUNCATE every table on every run
// (resetDb()) - inheriting a DATABASE_URL already set in the shell (e.g.
// pointing at the dev database) would wipe real data instead of the
// disposable test one.
process.env["DATABASE_URL"] =
  "postgresql://app:app@localhost:5432/appdb_test?schema=public&connection_limit=20&pool_timeout=20";
