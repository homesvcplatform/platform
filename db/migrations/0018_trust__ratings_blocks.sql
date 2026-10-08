-- trust (slice minimum): ratings (INV-16), published rating aggregates, blocks. Phase 1 03 §13.
-- Complaints, disputes, sanctions and safety incidents arrive with their gates (slice: API stubs only, 05 §7).
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA trust;

CREATE TABLE trust.ratings (
  id                       uuid PRIMARY KEY,
  job_id                   uuid NOT NULL,   -- ref: jobs.jobs
  rater_user_id            uuid NOT NULL,
  ratee_user_id            uuid NOT NULL,
  direction                text NOT NULL CHECK (direction IN ('CUSTOMER_TO_TECHNICIAN','TECHNICIAN_TO_CUSTOMER')),
  stars                    smallint NOT NULL CHECK (stars BETWEEN 1 AND 5),
  tags                     text[] NOT NULL DEFAULT '{}',
  comment_enc              bytea,
  excluded_from_aggregates boolean NOT NULL DEFAULT false,
  exclusion_reason_code    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  editable_until           timestamptz NOT NULL,
  locked_at                timestamptz,
  UNIQUE (job_id, rater_user_id, ratee_user_id, direction),   -- INV-16
  CHECK (rater_user_id <> ratee_user_id),
  CHECK (NOT excluded_from_aggregates OR exclusion_reason_code IS NOT NULL),
  CHECK (editable_until > created_at)
);
CREATE INDEX ratings_ratee_ix ON trust.ratings (ratee_user_id, direction, created_at DESC);

CREATE TABLE trust.rating_aggregates (
  technician_user_id uuid NOT NULL,
  segment            text NOT NULL CHECK (segment IN ('ALL','WOMEN_CUSTOMERS')),
  n_ratings          int NOT NULL CHECK (n_ratings >= 0),
  n_distinct_raters  int NOT NULL CHECK (n_distinct_raters >= 0 AND n_distinct_raters <= n_ratings),
  mean_rounded       numeric(2,1) CHECK (mean_rounded BETWEEN 1 AND 5),
  bayes_score        numeric(4,3),
  publishable        boolean NOT NULL,
  computed_at        timestamptz NOT NULL,
  published_at       timestamptz,
  PRIMARY KEY (technician_user_id, segment)
);

CREATE TABLE trust.blocks (
  blocker_user_id       uuid NOT NULL,
  blocked_user_id       uuid NOT NULL,
  reason_code           text NOT NULL,
  created_by_actor_type text NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  lifted_at             timestamptz,
  PRIMARY KEY (blocker_user_id, blocked_user_id),
  CHECK (blocker_user_id <> blocked_user_id)
);

SELECT platform.classify('trust.ratings', 'I', 'comment_enc', 'C,enc');
SELECT platform.classify('trust.rating_aggregates', 'I', 'mean_rounded', 'P', 'n_ratings', 'P');
SELECT platform.classify('trust.blocks', 'I');

SELECT platform.register_encrypted('trust.ratings', 'comment_enc', 'USER', 'rater_user_id', 'NULL_AND_DESTROY_SUBJECT_KEY');

GRANT USAGE ON SCHEMA trust TO app_api, app_admin, app_worker;
GRANT SELECT, INSERT, UPDATE ON trust.ratings TO app_api;
GRANT SELECT ON trust.rating_aggregates TO app_api, app_admin;
GRANT SELECT, INSERT ON trust.blocks TO app_api;
GRANT SELECT, UPDATE ON trust.ratings TO app_admin;
GRANT SELECT, INSERT, UPDATE ON trust.blocks TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON trust.ratings, trust.rating_aggregates, trust.blocks TO app_worker;
