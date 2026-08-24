// Runs before any test file's imports resolve `@app/db`'s Prisma client
// singleton, so DATABASE_URL must be pinned to the dedicated test database
// here rather than in an individual test file.
// Unconditional assignment, not `??=`: these tests TRUNCATE every table on
// every run (resetDb()), so silently inheriting a DATABASE_URL already set
// in the shell (e.g. pointing at the dev database) would wipe real data
// instead of the disposable test one. Tests must never be able to touch
// anything but appdb_test.
// connection_limit bumped comfortably above the concurrency test's
// simultaneous transaction count, so contention shows up as row-lock
// waiting inside Postgres (what we're actually testing) rather than as
// Prisma's own connection-pool queueing.
process.env["DATABASE_URL"] =
  "postgresql://app:app@localhost:5432/appdb_test?schema=public&connection_limit=40&pool_timeout=20";
