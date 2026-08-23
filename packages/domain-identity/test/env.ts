process.env["DATABASE_URL"] ??=
  "postgresql://app:app@localhost:5432/appdb_test?schema=public&connection_limit=20&pool_timeout=20";
