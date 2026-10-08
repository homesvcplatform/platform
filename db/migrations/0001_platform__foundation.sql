-- Gate 2 foundation (Phase 1 03 §1, §12.2, §14; errata G-7 / SR-07).
-- The platform schema holds cross-cutting infrastructure: helper functions used by every module's migrations,
-- the classification and key-subject registries, and (0002) the outbox / idempotency tables.
-- Error codes raised by guard triggers use SQLSTATE class HS (custom):
--   HS001 append-only violation, HS002 immutable-record violation, HS003 invalid state transition,
--   HS010 ledger imbalance / reversal mismatch, HS020 cross-row invariant violation.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA IF NOT EXISTS platform;
COMMENT ON SCHEMA platform IS 'Cross-cutting infrastructure: outbox, idempotency, registries, DB helper functions.';

-- updated_at maintenance for mutable tables ------------------------------------------------------------------------
CREATE FUNCTION platform.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION platform.track_updates(target regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER touch_updated_at BEFORE UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION platform.touch_updated_at()', target);
END $$;

-- Append-only enforcement (03 §12.2): grants never include UPDATE/DELETE, AND a trigger rejects them anyway so a
-- future grant mistake (or the owner) cannot rewrite history. Row triggers on partitioned tables apply to partitions.
CREATE FUNCTION platform.reject_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %.%: % is not allowed', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'HS001';
END $$;

CREATE FUNCTION platform.make_append_only(target regclass) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER append_only_rows BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION platform.reject_mutation()', target);
  EXECUTE format('CREATE TRIGGER append_only_truncate BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION platform.reject_mutation()', target);
  EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %s FROM PUBLIC', target);
END $$;

-- Column classification (03 §1): every column carries a tag P / I / C / R, optionally ",enc" (encrypted, *_enc) or
-- ",bidx" (blind index, *_bidx). Stored as the column comment. `default_tag` is applied only to columns that have
-- no tag yet; explicit (column, tag) pairs always win. A DB test fails if any column in an application schema is
-- untagged, so a later ALTER TABLE ... ADD COLUMN must classify the new column in the same migration.
CREATE FUNCTION platform.classify(target regclass, default_tag text, VARIADIC overrides text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  i int;
  col record;
BEGIN
  IF default_tag !~ '^[PICR](,(enc|bidx))?$' THEN
    RAISE EXCEPTION 'invalid default classification tag %', default_tag;
  END IF;
  IF coalesce(array_length(overrides, 1), 0) % 2 <> 0 THEN
    RAISE EXCEPTION 'classify(%): overrides must be (column, tag) pairs', target;
  END IF;
  FOR i IN 1 .. coalesce(array_length(overrides, 1), 0) BY 2 LOOP
    IF overrides[i + 1] !~ '^[PICR](,(enc|bidx))?$' THEN
      RAISE EXCEPTION 'invalid classification tag % for %.%', overrides[i + 1], target, overrides[i];
    END IF;
    EXECUTE format('COMMENT ON COLUMN %s.%I IS %L', target, overrides[i], overrides[i + 1]);
  END LOOP;
  FOR col IN
    SELECT a.attname FROM pg_attribute a
     WHERE a.attrelid = target AND a.attnum > 0 AND NOT a.attisdropped
       AND col_description(target, a.attnum) IS NULL
  LOOP
    EXECUTE format('COMMENT ON COLUMN %s.%I IS %L', target, col.attname, default_tag);
  END LOOP;
END $$;

-- Key-subject registry (G-7 / SR-07 (1)): every encrypted column declares whose key protects it, so erasure can
-- destroy the right subject key and archives can drop the right columns. Multi-party data uses the platform key and
-- must state how it is minimised.
CREATE TABLE platform.encrypted_columns (
  table_schema   text NOT NULL,
  table_name     text NOT NULL,
  column_name    text NOT NULL,
  key_subject    text NOT NULL CHECK (key_subject IN ('USER','CUSTOMER','TECHNICIAN','PLATFORM')),
  subject_column text,
  erasure_action text NOT NULL CHECK (erasure_action IN ('NULL_AND_DESTROY_SUBJECT_KEY','DESTROY_SUBJECT_KEY','ANONYMISE_WITH_RECORD','RETAIN_AS_EVIDENCE')),
  minimisation   text,
  PRIMARY KEY (table_schema, table_name, column_name),
  CHECK ((key_subject = 'PLATFORM') = (subject_column IS NULL)),
  CHECK (key_subject <> 'PLATFORM' OR minimisation IS NOT NULL)
);

CREATE FUNCTION platform.register_encrypted(
  target regclass, column_name text, key_subject text, subject_column text, erasure_action text, minimisation text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  sch text;
  tbl text;
BEGIN
  SELECT n.nspname, c.relname INTO sch, tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = target;
  INSERT INTO platform.encrypted_columns (table_schema, table_name, column_name, key_subject, subject_column, erasure_action, minimisation)
  VALUES (sch, tbl, column_name, key_subject, subject_column, erasure_action, minimisation);
END $$;

-- Archive policy (03 §14.8, G-7): partitioned tables are archived by detaching expired partitions. Archives contain
-- only pseudonymous IDs and non-PII columns: the archive column list is derived from classification (P / I only).
CREATE TABLE platform.archive_policies (
  table_schema    text NOT NULL,
  table_name      text NOT NULL,
  hot_retention   interval NOT NULL,
  archive_mode    text NOT NULL CHECK (archive_mode IN ('ARCHIVE_PSEUDONYMISED','DROP_WITHOUT_ARCHIVE')),
  legal_basis     text NOT NULL,
  PRIMARY KEY (table_schema, table_name)
);

-- Monthly partition maintenance (03 §14.8). pg_partman is the intended tool on the managed database; it isn't in the
-- local/CI image, so this function creates the same layout (parent_pYYYYMM, UTC month bounds). Idempotent.
CREATE FUNCTION platform.ensure_monthly_partitions(parent regclass, months_back int, months_ahead int) RETURNS int
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  sch text;
  tbl text;
  m int;
  month_start timestamp;
  part_name text;
  created int := 0;
BEGIN
  SELECT n.nspname, c.relname INTO sch, tbl FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = parent AND c.relkind = 'p';
  IF tbl IS NULL THEN
    RAISE EXCEPTION '% is not a partitioned table', parent;
  END IF;
  FOR m IN -months_back .. months_ahead LOOP
    month_start := date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => m);
    part_name := tbl || '_p' || to_char(month_start, 'YYYYMM');
    IF to_regclass(format('%I.%I', sch, part_name)) IS NULL THEN
      EXECUTE format('CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES FROM (%L) TO (%L)',
                     sch, part_name, sch, tbl,
                     month_start AT TIME ZONE 'UTC', (month_start + interval '1 month') AT TIME ZONE 'UTC');
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;

-- Only the owner (migrator) may call the helpers. Trigger functions are not checked for EXECUTE when they fire.
REVOKE ALL ON FUNCTION platform.touch_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.track_updates(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.reject_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.make_append_only(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.classify(regclass, text, text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.register_encrypted(regclass, text, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION platform.ensure_monthly_partitions(regclass, int, int) FROM PUBLIC;

SELECT platform.classify('platform.schema_migrations', 'I');
SELECT platform.classify('platform.encrypted_columns', 'I');
SELECT platform.classify('platform.archive_policies', 'I');
