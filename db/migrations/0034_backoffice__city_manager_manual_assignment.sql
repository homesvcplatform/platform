-- backoffice (Gate 5, ADR-026 #13): CITY_MANAGER gets `dispatch.assign`, city-scoped like the role.
-- The 05 §11 matrix row "Manual assignment" grants DISP S and CM S; the 0027 seed gave `dispatch.assign` to DISPATCH
-- only. ADR-024 #10 (accepted) seeds role definitions from 05 §5.3 plus what the §11 matrix grants explicitly, and 04
-- names `dispatch.assign` as the permission for manual assignment, so the seed is completed here. No new permission or
-- role is introduced. The permission also covers the ops-confirmed customer wait (ADR-026 #8), the same dispatch duty.
SET lock_timeout = '3s';
SET statement_timeout = '60s';

INSERT INTO backoffice.role_permissions (role_code, permission) VALUES ('CITY_MANAGER', 'dispatch.assign');
