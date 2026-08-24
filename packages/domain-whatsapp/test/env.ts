// Runs before any test file's imports resolve `@app/db`'s Prisma client
// singleton, so DATABASE_URL must be pinned to the dedicated test database
// here rather than in an individual test file.
// Unconditional, not `??=`: these tests TRUNCATE every table on every run
// (resetDb()) - inheriting a DATABASE_URL already set in the shell (e.g.
// pointing at the dev database) would wipe real data instead of the
// disposable test one.
process.env["DATABASE_URL"] = "postgresql://app:app@localhost:5432/appdb_test?schema=public";
