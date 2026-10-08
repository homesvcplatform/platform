-- G-7 / SR-07 (3) + 03 §14.8: archives hold pseudonymous data only. The archive job selects exactly the columns this
-- view lists for a table: columns classified P or I. Confidential / restricted, encrypted and blind-index columns are
-- never archived. Derived from the classification tags, so a newly classified PII column is excluded automatically.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE VIEW platform.archive_columns AS
SELECT p.table_schema,
       p.table_name,
       a.attname::text AS column_name,
       col_description(c.oid, a.attnum) AS classification
  FROM platform.archive_policies p
  JOIN pg_catalog.pg_namespace n ON n.nspname = p.table_schema
  JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid AND c.relname = p.table_name
  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
 WHERE p.archive_mode = 'ARCHIVE_PSEUDONYMISED'
   AND col_description(c.oid, a.attnum) IN ('P', 'I');

COMMENT ON VIEW platform.archive_columns IS 'Columns an archive may contain (P / I only). Used by the retention / archive job.';

GRANT SELECT ON platform.archive_policies, platform.archive_columns TO app_worker;
