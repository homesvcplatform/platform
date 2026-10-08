-- files: metadata for every stored object (uploads are scanned before use). Phase 1 10 §6.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA files;

CREATE TABLE files.file_objects (
  id                     uuid PRIMARY KEY,
  kind                   text NOT NULL CHECK (kind IN ('PROBLEM_PHOTO','PROBLEM_VOICE','DIAGNOSIS_PHOTO','AFTER_PHOTO','RECEIPT',
                                                       'COMPLAINT_MEDIA','KYC_DOC','PROFILE_PHOTO','CALL_RECORDING','INVOICE',
                                                       'CREDIT_NOTE','DSR_EXPORT','EVIDENCE_PACK')),
  owner_module           text NOT NULL,
  owner_ref_type         text NOT NULL,
  owner_ref_id           uuid NOT NULL,
  uploaded_by_actor_type text NOT NULL,
  uploaded_by_actor_id   uuid,
  declared_content_type  text NOT NULL,
  declared_size          bigint NOT NULL CHECK (declared_size > 0),
  detected_content_type  text,
  final_size             bigint CHECK (final_size > 0),
  sha256                 bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
  perceptual_hash        bytea,
  bucket                 text NOT NULL,
  quarantine_key         text,
  clean_key              text,
  status                 text NOT NULL CHECK (status IN ('PENDING_UPLOAD','SCANNING','CLEAN','REJECTED','DELETED','PURGED')),
  rejection_reason       text,
  captured_in_app        boolean,
  retention_until        timestamptz,
  legal_hold             boolean NOT NULL DEFAULT false,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'CLEAN' OR (clean_key IS NOT NULL AND sha256 IS NOT NULL)),
  CHECK (status <> 'REJECTED' OR rejection_reason IS NOT NULL),
  CHECK (declared_content_type <> 'image/svg+xml')   -- SVG is never accepted (10 §2)
);
CREATE INDEX files_owner_ix ON files.file_objects (owner_module, owner_ref_type, owner_ref_id);
CREATE INDEX files_retention_ix ON files.file_objects (retention_until) WHERE status = 'CLEAN' AND NOT legal_hold;

SELECT platform.track_updates('files.file_objects');
-- Object contents are classified by kind (10 §4); the metadata row itself is internal.
SELECT platform.classify('files.file_objects', 'I');

GRANT USAGE ON SCHEMA files TO app_api, app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON files.file_objects TO app_api, app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON files.file_objects TO app_worker;
