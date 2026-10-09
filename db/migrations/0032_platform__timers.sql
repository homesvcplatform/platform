-- platform (Gate 5, ADR-015, ADR-026 #3): durable timers. The Graphile Worker queue lives in schema graphile_worker,
-- installed by the migrator after these SQL migrations (@hsp/db installTimerQueue). Modules never touch it directly:
-- they schedule and cancel timers through these two functions, in the transaction that changes state.
-- The functions run as their owner (the migrator, who owns the queue schema), so runtime roles need no queue grants.
-- plpgsql resolves graphile_worker.* at call time, so this migration doesn't depend on the queue being installed yet.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE FUNCTION platform.schedule_timer(p_task text, p_key text, p_run_at timestamptz, p_payload jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_task IS NULL OR p_task !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,4}$' THEN
    RAISE EXCEPTION 'invalid timer task' USING ERRCODE = 'HS040';
  END IF;
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9:._-]{3,200}$' THEN
    RAISE EXCEPTION 'invalid timer key' USING ERRCODE = 'HS040';
  END IF;
  IF p_run_at IS NULL OR p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION 'invalid timer' USING ERRCODE = 'HS040';
  END IF;
  PERFORM graphile_worker.add_job(p_task, p_payload::json, run_at => p_run_at, job_key => p_key, job_key_mode => 'replace',
                                  max_attempts => 25);
END $$;

CREATE FUNCTION platform.cancel_timer(p_key text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9:._-]{3,200}$' THEN
    RAISE EXCEPTION 'invalid timer key' USING ERRCODE = 'HS040';
  END IF;
  PERFORM graphile_worker.remove_job(p_key);
END $$;

REVOKE ALL ON FUNCTION platform.schedule_timer(text, text, timestamptz, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.cancel_timer(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform.schedule_timer(text, text, timestamptz, jsonb) TO app_api, app_admin, app_voice, app_worker;
GRANT EXECUTE ON FUNCTION platform.cancel_timer(text) TO app_api, app_admin, app_voice, app_worker;
