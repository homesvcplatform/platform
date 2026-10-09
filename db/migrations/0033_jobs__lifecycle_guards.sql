-- jobs (Gate 5, ADR-026 #5): the database refuses any status change the transition tables don't allow, and records every
-- status change in an append-only history with actor and channel (INV-18). Presence and close invariants:
-- INV-14 (ON_SITE needs a start-code or audited override proof), INV-15 (a repair visit COMPLETED needs a completion-code
-- or audited override proof), INV-04 (a repair order IN_PROGRESS needs a visit linked to it, checked at commit) and
-- INV-25 (a job CLOSED needs no open repair order and no safety hold; bills are checked through the TCP-3 port).
--
-- Actor context: the application sets transaction-local settings before changing a status
--   set_config('hsp.actor_type', ..., true), set_config('hsp.actor_id', ..., true), set_config('hsp.channel', ..., true),
--   set_config('hsp.correlation_id', ..., true), set_config('hsp.reason_code', ..., true)
-- A status change without them fails (HS031), so no transition can skip its history row.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

-- The allowed moves, generated from packages/modules/jobs/src/domain/transitions.ts ('(new)' = creation).
-- A DB test keeps this table equal to the code tables.
CREATE TABLE jobs.allowed_transitions (
  machine     text NOT NULL CHECK (machine IN ('job','visit','assignment','repair_order')),
  from_status text NOT NULL,
  to_status   text NOT NULL,
  PRIMARY KEY (machine, from_status, to_status)
);
INSERT INTO jobs.allowed_transitions (machine, from_status, to_status) VALUES
  ('job', '(new)', 'REQUESTED'),
  ('job', 'REQUESTED', 'IN_DIAGNOSIS'),
  ('job', 'REQUESTED', 'CANCELLED'),
  ('job', 'IN_DIAGNOSIS', 'AWAITING_APPROVAL'),
  ('job', 'IN_DIAGNOSIS', 'AWAITING_PAYMENT'),
  ('job', 'IN_DIAGNOSIS', 'REQUESTED'),
  ('job', 'IN_DIAGNOSIS', 'CANCELLED'),
  ('job', 'AWAITING_APPROVAL', 'REPAIR_PENDING'),
  ('job', 'AWAITING_APPROVAL', 'REPAIR_IN_PROGRESS'),
  ('job', 'AWAITING_APPROVAL', 'AWAITING_PAYMENT'),
  ('job', 'AWAITING_APPROVAL', 'CLOSED'),
  ('job', 'AWAITING_APPROVAL', 'CANCELLED'),
  ('job', 'REPAIR_PENDING', 'REPAIR_IN_PROGRESS'),
  ('job', 'REPAIR_PENDING', 'CANCELLED'),
  ('job', 'REPAIR_IN_PROGRESS', 'AWAITING_APPROVAL'),
  ('job', 'REPAIR_IN_PROGRESS', 'REPAIR_PENDING'),
  ('job', 'REPAIR_IN_PROGRESS', 'AWAITING_PAYMENT'),
  ('job', 'AWAITING_PAYMENT', 'CLOSED'),
  ('visit', '(new)', 'PLANNED'),
  ('visit', 'PLANNED', 'MATCHING'),
  ('visit', 'PLANNED', 'CANCELLED'),
  ('visit', 'MATCHING', 'ASSIGNED'),
  ('visit', 'MATCHING', 'UNFULFILLED'),
  ('visit', 'MATCHING', 'CANCELLED'),
  ('visit', 'UNFULFILLED', 'MATCHING'),
  ('visit', 'UNFULFILLED', 'CANCELLED'),
  ('visit', 'ASSIGNED', 'EN_ROUTE'),
  ('visit', 'ASSIGNED', 'MATCHING'),
  ('visit', 'ASSIGNED', 'CANCELLED'),
  ('visit', 'EN_ROUTE', 'ON_SITE'),
  ('visit', 'EN_ROUTE', 'MATCHING'),
  ('visit', 'EN_ROUTE', 'CUSTOMER_NO_SHOW'),
  ('visit', 'EN_ROUTE', 'CANCELLED'),
  ('visit', 'ON_SITE', 'IN_PROGRESS'),
  ('visit', 'IN_PROGRESS', 'COMPLETED'),
  ('visit', 'IN_PROGRESS', 'ABORTED'),
  ('assignment', '(new)', 'ACTIVE'),
  ('assignment', 'ACTIVE', 'COMPLETED'),
  ('assignment', 'ACTIVE', 'RELEASED'),
  ('assignment', 'ACTIVE', 'NO_SHOW'),
  ('assignment', 'ACTIVE', 'REVOKED'),
  ('repair_order', '(new)', 'AWAITING_SCHEDULE'),
  ('repair_order', '(new)', 'IN_PROGRESS'),
  ('repair_order', 'AWAITING_SCHEDULE', 'SCHEDULED'),
  ('repair_order', 'AWAITING_SCHEDULE', 'CANCELLED'),
  ('repair_order', 'SCHEDULED', 'IN_PROGRESS'),
  ('repair_order', 'SCHEDULED', 'AWAITING_SCHEDULE'),
  ('repair_order', 'SCHEDULED', 'CANCELLED'),
  ('repair_order', 'IN_PROGRESS', 'CHANGE_PENDING'),
  ('repair_order', 'IN_PROGRESS', 'BLOCKED'),
  ('repair_order', 'IN_PROGRESS', 'COMPLETED'),
  ('repair_order', 'CHANGE_PENDING', 'IN_PROGRESS'),
  ('repair_order', 'BLOCKED', 'AWAITING_SCHEDULE'),
  ('repair_order', 'BLOCKED', 'CANCELLED');
SELECT platform.make_append_only('jobs.allowed_transitions');

-- Assignment history (INV-18 names Assignment; Gate 2 created job / visit / repair-order histories only).
CREATE TABLE jobs.assignment_status_history (
  id             uuid NOT NULL,
  assignment_id  uuid NOT NULL,
  from_status    text,
  to_status      text NOT NULL,
  actor_type     text NOT NULL CHECK (actor_type IN ('CUSTOMER','TECHNICIAN','FIELD_AGENT','ADMIN','SYSTEM')),
  actor_id       uuid,
  channel        text NOT NULL,
  reason_code    text,
  correlation_id uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE INDEX ash_assignment_ix ON jobs.assignment_status_history (assignment_id, created_at);
SELECT platform.ensure_monthly_partitions('jobs.assignment_status_history', 1, 3);
SELECT platform.make_append_only('jobs.assignment_status_history');

CREATE FUNCTION jobs.guard_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_from text := CASE WHEN TG_OP = 'INSERT' THEN '(new)' ELSE OLD.status END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jobs.allowed_transitions t
                  WHERE t.machine = TG_ARGV[0] AND t.from_status = v_from AND t.to_status = NEW.status) THEN
    RAISE EXCEPTION '% transition % -> % is not allowed', TG_ARGV[0], v_from, NEW.status USING ERRCODE = 'HS030';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION jobs.record_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  v_actor_type text := nullif(current_setting('hsp.actor_type', true), '');
  v_actor_id   text := nullif(current_setting('hsp.actor_id', true), '');
  v_channel    text := nullif(current_setting('hsp.channel', true), '');
  v_corr       text := nullif(current_setting('hsp.correlation_id', true), '');
  v_reason     text := nullif(current_setting('hsp.reason_code', true), '');
  v_from       text := CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = OLD.status THEN
    RETURN NULL;
  END IF;
  IF v_actor_type IS NULL OR v_channel IS NULL OR v_corr IS NULL THEN
    RAISE EXCEPTION 'status change of % without actor context', TG_ARGV[0] USING ERRCODE = 'HS031';
  END IF;
  CASE TG_ARGV[0]
    WHEN 'job' THEN
      INSERT INTO jobs.job_status_history (id, job_id, from_status, to_status, actor_type, actor_id, channel, reason_code, correlation_id)
      VALUES (gen_random_uuid(), NEW.id, v_from, NEW.status, v_actor_type, v_actor_id::uuid, v_channel, v_reason, v_corr::uuid);
    WHEN 'visit' THEN
      INSERT INTO jobs.visit_status_history (id, visit_id, from_status, to_status, actor_type, actor_id, channel, reason_code, correlation_id)
      VALUES (gen_random_uuid(), NEW.id, v_from, NEW.status, v_actor_type, v_actor_id::uuid, v_channel, v_reason, v_corr::uuid);
    WHEN 'assignment' THEN
      INSERT INTO jobs.assignment_status_history (id, assignment_id, from_status, to_status, actor_type, actor_id, channel, reason_code, correlation_id)
      VALUES (gen_random_uuid(), NEW.id, v_from, NEW.status, v_actor_type, v_actor_id::uuid, v_channel, v_reason, v_corr::uuid);
    WHEN 'repair_order' THEN
      INSERT INTO jobs.repair_order_status_history (id, repair_order_id, from_status, to_status, actor_type, actor_id, channel, reason_code, correlation_id)
      VALUES (gen_random_uuid(), NEW.id, v_from, NEW.status, v_actor_type, v_actor_id::uuid, v_channel, v_reason, v_corr::uuid);
  END CASE;
  RETURN NULL;
END $$;

-- INV-14 / INV-15: presence proofs are inserted (append-only) before the status changes in the same transaction.
CREATE FUNCTION jobs.guard_visit_presence() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'ON_SITE' AND NOT EXISTS (SELECT 1 FROM jobs.visit_presence_proofs p
       WHERE p.visit_id = NEW.id AND p.kind IN ('START_CODE', 'OPS_OVERRIDE_ARRIVAL')) THEN
    RAISE EXCEPTION 'visit % can become ON_SITE only with a start code or an audited override (INV-14)', NEW.id USING ERRCODE = 'HS032';
  END IF;
  IF NEW.status = 'COMPLETED' AND 'REPAIR' = ANY (NEW.purposes) AND NOT EXISTS (SELECT 1 FROM jobs.visit_presence_proofs p
       WHERE p.visit_id = NEW.id AND p.kind IN ('COMPLETION_CODE', 'OPS_OVERRIDE_COMPLETION')) THEN
    RAISE EXCEPTION 'repair visit % can complete only with a completion code or an audited override (INV-15)', NEW.id USING ERRCODE = 'HS033';
  END IF;
  RETURN NEW;
END $$;

-- INV-25 (database part): no open repair order and no safety hold.
CREATE FUNCTION jobs.guard_job_close() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.safety_hold OR EXISTS (SELECT 1 FROM jobs.repair_orders r WHERE r.job_id = NEW.id AND r.status NOT IN ('COMPLETED', 'CANCELLED')) THEN
    RAISE EXCEPTION 'job % can not close with an open repair order or a safety hold (INV-25)', NEW.id USING ERRCODE = 'HS034';
  END IF;
  RETURN NEW;
END $$;

-- INV-04 (jobs part): a repair order IN_PROGRESS needs a visit linked to it (checked at commit, so the same-visit attach
-- can insert the order and link the visit in one transaction). The approved quote version is checked by diagnosis (Gate 6).
CREATE FUNCTION jobs.guard_repair_order_visit() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NEW.status = 'IN_PROGRESS' AND NOT EXISTS (SELECT 1 FROM jobs.visits v
       WHERE v.repair_order_id = NEW.id AND v.status IN ('ON_SITE', 'IN_PROGRESS')) THEN
    RAISE EXCEPTION 'repair order % is IN_PROGRESS without a linked visit on site (INV-04)', NEW.id USING ERRCODE = 'HS035';
  END IF;
  RETURN NULL;
END $$;

CREATE TRIGGER guard_transition BEFORE INSERT OR UPDATE OF status ON jobs.jobs FOR EACH ROW EXECUTE FUNCTION jobs.guard_transition('job');
CREATE TRIGGER guard_transition BEFORE INSERT OR UPDATE OF status ON jobs.visits FOR EACH ROW EXECUTE FUNCTION jobs.guard_transition('visit');
CREATE TRIGGER guard_transition BEFORE INSERT OR UPDATE OF status ON jobs.assignments FOR EACH ROW EXECUTE FUNCTION jobs.guard_transition('assignment');
CREATE TRIGGER guard_transition BEFORE INSERT OR UPDATE OF status ON jobs.repair_orders FOR EACH ROW EXECUTE FUNCTION jobs.guard_transition('repair_order');
CREATE TRIGGER record_transition AFTER INSERT OR UPDATE OF status ON jobs.jobs FOR EACH ROW EXECUTE FUNCTION jobs.record_transition('job');
CREATE TRIGGER record_transition AFTER INSERT OR UPDATE OF status ON jobs.visits FOR EACH ROW EXECUTE FUNCTION jobs.record_transition('visit');
CREATE TRIGGER record_transition AFTER INSERT OR UPDATE OF status ON jobs.assignments FOR EACH ROW EXECUTE FUNCTION jobs.record_transition('assignment');
CREATE TRIGGER record_transition AFTER INSERT OR UPDATE OF status ON jobs.repair_orders FOR EACH ROW EXECUTE FUNCTION jobs.record_transition('repair_order');
CREATE TRIGGER guard_presence BEFORE UPDATE OF status ON jobs.visits FOR EACH ROW
  WHEN (NEW.status IS DISTINCT FROM OLD.status) EXECUTE FUNCTION jobs.guard_visit_presence();
CREATE TRIGGER guard_close BEFORE UPDATE OF status ON jobs.jobs FOR EACH ROW
  WHEN (NEW.status = 'CLOSED' AND OLD.status IS DISTINCT FROM 'CLOSED') EXECUTE FUNCTION jobs.guard_job_close();
CREATE CONSTRAINT TRIGGER guard_repair_order_visit AFTER INSERT OR UPDATE OF status ON jobs.repair_orders
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION jobs.guard_repair_order_visit();

REVOKE ALL ON FUNCTION jobs.guard_transition(), jobs.record_transition(), jobs.guard_visit_presence(), jobs.guard_job_close(),
  jobs.guard_repair_order_visit() FROM PUBLIC;

SELECT platform.classify('jobs.allowed_transitions', 'I');
SELECT platform.classify('jobs.assignment_status_history', 'I');
INSERT INTO platform.archive_policies (table_schema, table_name, hot_retention, archive_mode, legal_basis) VALUES
  ('jobs', 'assignment_status_history', interval '3 years', 'ARCHIVE_PSEUDONYMISED', 'Phase 1 03 §14.9: jobs/visits close + 3 y, then anonymise');

GRANT SELECT ON jobs.allowed_transitions TO app_api, app_admin, app_voice, app_worker;
GRANT SELECT, INSERT ON jobs.assignment_status_history TO app_api, app_admin, app_worker;
GRANT INSERT ON jobs.assignment_status_history TO app_voice;
