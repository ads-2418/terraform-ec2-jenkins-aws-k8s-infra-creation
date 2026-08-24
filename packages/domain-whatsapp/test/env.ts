// Runs before any test file's imports resolve `@app/db`'s Prisma client
// singleton, so DATABASE_URL must be pinned to the dedicated test database
// here rather than in an individual test file.
process.env["DATABASE_URL"] ??= "postgresql://app:app@localhost:5432/appdb_test?schema=public";
