-- End any transaction left idle for a minute. The app's transactions take milliseconds; one
-- left open means a connection is stuck (Hyperdrive once lost a statement queued behind a
-- COMMIT, leaving connections idle in transaction and requests hanging). Ending it frees the
-- connection for Hyperdrive's pool. Set on the database, which the migration owner owns, so it
-- covers every role; it applies to new sessions.
DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET idle_in_transaction_session_timeout = %L',
    current_database(),
    '60s'
  );
END
$$;
