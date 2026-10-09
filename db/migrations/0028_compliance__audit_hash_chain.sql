-- compliance (Gate 3): hash-chained audit log writer (Phase 1 11 §8, 05 §10).
-- row_hash = SHA-256(prev_hash ‖ canonical(row)), one chain per monthly partition (chain_partition = 'YYYY-MM', UTC).
-- Runtime roles no longer INSERT into compliance.audit_logs directly: they call platform.append_audit_log, which takes
-- the chain head lock, links the row and advances the head. A direct INSERT could otherwise forge a row that breaks or
-- forks the chain. Callers write the audit row as the last statement of their transaction: the head lock is held until
-- commit, which serialises audited commits per month (acceptable at pilot volume; revisit with sharded chains).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE TABLE compliance.audit_chain_heads (
  chain_partition text PRIMARY KEY CHECK (chain_partition ~ '^[0-9]{4}-[0-9]{2}$'),
  last_hash       bytea NOT NULL CHECK (octet_length(last_hash) = 32),
  row_count       bigint NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Canonical form: jsonb text (keys in jsonb's deterministic order), timestamps as UTC microseconds, bytea as hex.
CREATE FUNCTION compliance.audit_row_hash(
  prev bytea, id uuid, occurred_at timestamptz, actor_type text, actor_id uuid, actor_session_id uuid, action text,
  resource_type text, resource_id uuid, city_id uuid, outcome text, reason_code text, change_summary jsonb,
  request_id uuid, ip_hash bytea, ua_hash bytea, chain_partition text
) RETURNS bytea
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT sha256(prev || convert_to(jsonb_build_object(
    'id', id, 'occurred_at', to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'actor_type', actor_type, 'actor_id', actor_id, 'actor_session_id', actor_session_id, 'action', action,
    'resource_type', resource_type, 'resource_id', resource_id, 'city_id', city_id, 'outcome', outcome,
    'reason_code', reason_code, 'change_summary', change_summary, 'request_id', request_id,
    'ip_hash', encode(ip_hash, 'hex'), 'ua_hash', encode(ua_hash, 'hex'), 'chain_partition', chain_partition
  )::text, 'UTF8'))
$$;

CREATE FUNCTION compliance.audit_genesis(chain_partition text) RETURNS bytea
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT sha256(convert_to('hsp-audit-genesis|' || chain_partition, 'UTF8'))
$$;

CREATE FUNCTION platform.append_audit_log(
  p_id uuid, p_actor_type text, p_actor_id uuid, p_actor_session_id uuid, p_action text, p_resource_type text,
  p_resource_id uuid, p_city_id uuid, p_outcome text, p_reason_code text, p_change_summary jsonb, p_request_id uuid,
  p_ip_hash bytea, p_ua_hash bytea
) RETURNS bytea
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  v_part text;
  v_at   timestamptz;
  v_prev bytea;
  v_hash bytea;
BEGIN
  IF p_action !~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){1,4}$' OR p_resource_type !~ '^[a-z][a-z0-9_.]{1,60}$' THEN
    RAISE EXCEPTION 'audit: invalid action or resource type' USING ERRCODE = '22023';
  END IF;
  IF p_change_summary IS NOT NULL AND jsonb_typeof(p_change_summary) <> 'object' THEN
    RAISE EXCEPTION 'audit: change_summary must be an object' USING ERRCODE = '22023';
  END IF;
  LOOP
    v_part := to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM');
    INSERT INTO compliance.audit_chain_heads (chain_partition, last_hash)
    VALUES (v_part, compliance.audit_genesis(v_part)) ON CONFLICT (chain_partition) DO NOTHING;
    SELECT last_hash INTO v_prev FROM compliance.audit_chain_heads WHERE chain_partition = v_part FOR UPDATE;
    -- Timestamp taken while holding the head lock: strictly increasing within a chain.
    v_at := clock_timestamp();
    EXIT WHEN to_char(v_at AT TIME ZONE 'UTC', 'YYYY-MM') = v_part;   -- month rolled over while waiting: retry
  END LOOP;
  v_hash := compliance.audit_row_hash(v_prev, p_id, v_at, p_actor_type, p_actor_id, p_actor_session_id, p_action,
    p_resource_type, p_resource_id, p_city_id, p_outcome, p_reason_code, p_change_summary, p_request_id, p_ip_hash, p_ua_hash, v_part);
  INSERT INTO compliance.audit_logs (id, occurred_at, actor_type, actor_id, actor_session_id, action, resource_type, resource_id,
    city_id, outcome, reason_code, change_summary, request_id, ip_hash, ua_hash, chain_partition, prev_hash, row_hash)
  VALUES (p_id, v_at, p_actor_type, p_actor_id, p_actor_session_id, p_action, p_resource_type, p_resource_id,
    p_city_id, p_outcome, p_reason_code, p_change_summary, p_request_id, p_ip_hash, p_ua_hash, v_part, v_prev, v_hash);
  UPDATE compliance.audit_chain_heads SET last_hash = v_hash, row_count = row_count + 1, updated_at = v_at
   WHERE chain_partition = v_part;
  RETURN v_hash;
END $$;

-- Recomputes one month's chain (daily verification job, 11 §8). Returns the first row that breaks it, if any.
CREATE FUNCTION compliance.verify_audit_chain(p_partition text)
RETURNS TABLE (ok boolean, rows_checked bigint, first_bad_id uuid)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  r record;
  v_expected bytea := compliance.audit_genesis(p_partition);
  v_count bigint := 0;
  v_head record;
BEGIN
  FOR r IN SELECT * FROM compliance.audit_logs a WHERE a.chain_partition = p_partition ORDER BY a.occurred_at, a.id LOOP
    v_count := v_count + 1;
    IF r.prev_hash <> v_expected OR r.row_hash <> compliance.audit_row_hash(r.prev_hash, r.id, r.occurred_at, r.actor_type, r.actor_id,
         r.actor_session_id, r.action, r.resource_type, r.resource_id, r.city_id, r.outcome, r.reason_code, r.change_summary,
         r.request_id, r.ip_hash, r.ua_hash, r.chain_partition) THEN
      RETURN QUERY SELECT false, v_count, r.id;
      RETURN;
    END IF;
    v_expected := r.row_hash;
  END LOOP;
  SELECT h.last_hash, h.row_count INTO v_head FROM compliance.audit_chain_heads h WHERE h.chain_partition = p_partition;
  IF (v_head IS NULL AND v_count > 0) OR (v_head IS NOT NULL AND (v_head.last_hash <> v_expected OR v_head.row_count <> v_count)) THEN
    RETURN QUERY SELECT false, v_count, NULL::uuid;   -- rows missing at the end, or the head was tampered with
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, NULL::uuid;
END $$;

SELECT platform.classify('compliance.audit_chain_heads', 'I');

REVOKE ALL ON FUNCTION compliance.audit_row_hash(bytea, uuid, timestamptz, text, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, uuid, bytea, bytea, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.audit_genesis(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.append_audit_log(uuid, text, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, uuid, bytea, bytea) FROM PUBLIC;
REVOKE ALL ON FUNCTION compliance.verify_audit_chain(text) FROM PUBLIC;

REVOKE INSERT ON compliance.audit_logs FROM app_api, app_voice, app_admin, app_worker;
GRANT EXECUTE ON FUNCTION platform.append_audit_log(uuid, text, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, uuid, bytea, bytea)
  TO app_api, app_voice, app_admin, app_worker;
GRANT EXECUTE ON FUNCTION compliance.verify_audit_chain(text), compliance.audit_row_hash(bytea, uuid, timestamptz, text, uuid, uuid, text, text, uuid, uuid, text, text, jsonb, uuid, bytea, bytea, text),
  compliance.audit_genesis(text) TO app_admin, app_worker;
GRANT SELECT ON compliance.audit_chain_heads TO app_admin, app_worker;
