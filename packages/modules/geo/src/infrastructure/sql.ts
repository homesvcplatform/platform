// SQL of module "geo" (schema geo only, B2). Serviceable = locality ACTIVE, zone ACTIVE, city PILOT or LIVE (ADR-025 #9).

const SERVICEABLE = "(l.status = 'ACTIVE' AND z.status = 'ACTIVE' AND c.status IN ('PILOT', 'LIVE'))";

export const SQL = {
  city: `SELECT id, code, names, supported_locales, status, version FROM geo.cities WHERE id = $1`,
  lockCity: `SELECT id, supported_locales, status, version FROM geo.cities WHERE id = $1 FOR UPDATE`,
  setCityLocales: `UPDATE geo.cities SET supported_locales = $2, version = version + 1 WHERE id = $1 AND version = $3 RETURNING version`,
  // Names (any language) and aliases; a substring hit scores 1, otherwise trigram similarity. Active localities only.
  searchLocalities: `
    SELECT l.id, l.names, z.names AS zone_names, ${SERVICEABLE} AS serviceable, m.score
      FROM (SELECT s.locality_id, max(s.score) AS score
              FROM (SELECT l.id AS locality_id,
                           CASE WHEN strpos(lower(n.value), $2) > 0 THEN 1.0 ELSE similarity(lower(n.value), $2) END AS score
                      FROM geo.localities l CROSS JOIN LATERAL jsonb_each_text(l.names) AS n
                     WHERE l.city_id = $1
                    UNION ALL
                    SELECT a.locality_id, CASE WHEN strpos(a.normalized, $2) > 0 THEN 1.0 ELSE similarity(a.normalized, $2) END
                      FROM geo.locality_aliases a JOIN geo.localities l ON l.id = a.locality_id
                     WHERE l.city_id = $1) AS s
             GROUP BY s.locality_id) AS m
      JOIN geo.localities l ON l.id = m.locality_id
      JOIN geo.zones z ON z.id = l.zone_id
      JOIN geo.cities c ON c.id = l.city_id
     WHERE m.score >= 0.3 AND l.status = 'ACTIVE'
     ORDER BY m.score DESC, l.code
     LIMIT 20`,
  localityServiceability: `
    SELECT l.id, l.city_id, l.zone_id, ${SERVICEABLE} AS serviceable
      FROM geo.localities l JOIN geo.zones z ON z.id = l.zone_id JOIN geo.cities c ON c.id = l.city_id
     WHERE l.id = $1`,
  // The ACTIVE zone that covers the point, then the nearest ACTIVE locality of that zone.
  pointServiceability: `
    WITH p AS (SELECT ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography AS g)
    SELECT z.id AS zone_id, z.city_id, c.status AS city_status,
           (SELECT l.id FROM geo.localities l WHERE l.zone_id = z.id AND l.status = 'ACTIVE'
             ORDER BY ST_Distance(l.centroid, p.g), l.code LIMIT 1) AS locality_id
      FROM p JOIN geo.zones z ON z.status = 'ACTIVE' AND ST_Covers(z.boundary, p.g)
      JOIN geo.cities c ON c.id = z.city_id
     ORDER BY z.code
     LIMIT 1`,
  zoneOf: `SELECT zone_id FROM geo.localities WHERE id = $1`,
  localityDistance: `SELECT ST_Distance(l.centroid, ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography) AS metres FROM geo.localities l WHERE l.id = $1`,
  cityAdjacency: `
    SELECT a.locality_id, a.neighbor_id, a.travel_minutes_typical
      FROM geo.locality_adjacency a JOIN geo.localities l ON l.id = a.locality_id
     WHERE l.city_id = (SELECT city_id FROM geo.localities WHERE id = $1)`,
} as const;
