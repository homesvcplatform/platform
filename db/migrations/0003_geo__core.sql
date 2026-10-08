-- geo: operating cities, zones, localities (the location unit for basic-phone matching). Phase 1 03 §3.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

CREATE SCHEMA geo;

CREATE TABLE geo.cities (
  id                uuid PRIMARY KEY,
  code              text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3,6}$'),
  names             jsonb NOT NULL,
  state_code        text NOT NULL CHECK (state_code ~ '^IN-[A-Z]{2}$'),
  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  supported_locales text[] NOT NULL CHECK (cardinality(supported_locales) >= 1),
  status            text NOT NULL CHECK (status IN ('PLANNED','PILOT','LIVE','PAUSED')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           int NOT NULL DEFAULT 0
);

CREATE TABLE geo.zones (
  id         uuid PRIMARY KEY,
  city_id    uuid NOT NULL REFERENCES geo.cities(id),
  code       text NOT NULL,
  names      jsonb NOT NULL,
  boundary   geography(MultiPolygon, 4326) NOT NULL,
  status     text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version    int NOT NULL DEFAULT 0,
  UNIQUE (city_id, code)
);
CREATE INDEX zones_boundary_gix ON geo.zones USING gist (boundary);
CREATE INDEX zones_city_ix ON geo.zones (city_id);

CREATE TABLE geo.localities (
  id               uuid PRIMARY KEY,
  city_id          uuid NOT NULL REFERENCES geo.cities(id),
  zone_id          uuid NOT NULL REFERENCES geo.zones(id),
  code             text NOT NULL,
  names            jsonb NOT NULL,
  centroid         geography(Point, 4326) NOT NULL,
  pincode          text CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  prompt_audio_ref text,
  status           text NOT NULL CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          int NOT NULL DEFAULT 0,
  UNIQUE (city_id, code)
);
CREATE INDEX localities_centroid_gix ON geo.localities USING gist (centroid);
CREATE INDEX localities_zone_ix ON geo.localities (zone_id) WHERE status = 'ACTIVE';

CREATE TABLE geo.locality_aliases (
  id          uuid PRIMARY KEY,
  locality_id uuid NOT NULL REFERENCES geo.localities(id),
  alias       text NOT NULL,
  script      text NOT NULL,
  normalized  text NOT NULL,
  UNIQUE (locality_id, normalized)
);
CREATE INDEX locality_aliases_trgm ON geo.locality_aliases USING gin (normalized gin_trgm_ops);

CREATE TABLE geo.locality_adjacency (
  locality_id            uuid NOT NULL REFERENCES geo.localities(id),
  neighbor_id            uuid NOT NULL REFERENCES geo.localities(id),
  travel_minutes_typical smallint NOT NULL CHECK (travel_minutes_typical BETWEEN 1 AND 240),
  source                 text NOT NULL CHECK (source IN ('COMPUTED','OPS_CURATED')),
  PRIMARY KEY (locality_id, neighbor_id),
  CHECK (locality_id <> neighbor_id)
);
CREATE INDEX locality_adjacency_neighbor_ix ON geo.locality_adjacency (neighbor_id);

SELECT platform.track_updates('geo.cities');
SELECT platform.track_updates('geo.zones');
SELECT platform.track_updates('geo.localities');

-- Geography is public/operational reference data: names and areas are P, internal codes and shapes are I.
SELECT platform.classify('geo.cities', 'I', 'names', 'P');
SELECT platform.classify('geo.zones', 'I', 'names', 'P');
SELECT platform.classify('geo.localities', 'I', 'names', 'P', 'pincode', 'P');
SELECT platform.classify('geo.locality_aliases', 'I', 'alias', 'P');
SELECT platform.classify('geo.locality_adjacency', 'I');

GRANT USAGE ON SCHEMA geo TO app_api, app_admin, app_worker;
GRANT SELECT ON geo.cities, geo.zones, geo.localities, geo.locality_aliases, geo.locality_adjacency TO app_api;
GRANT SELECT, INSERT, UPDATE ON geo.cities, geo.zones, geo.localities, geo.locality_aliases, geo.locality_adjacency TO app_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON geo.cities, geo.zones, geo.localities, geo.locality_aliases, geo.locality_adjacency TO app_worker;
