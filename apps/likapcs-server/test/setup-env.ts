// Test environment: a dedicated PostgreSQL database that is wiped before each test file.
process.env.LIKAPCS_DATABASE_URL =
  process.env.LIKAPCS_TEST_DATABASE_URL ??
  'postgres://likapcs:likapcs_dev_password@127.0.0.1:5432/likapcs_test';
process.env.LIKAPCS_LOG_LEVEL = 'silent';
process.env.LIKAPCS_SESSION_HOURS = '1';
