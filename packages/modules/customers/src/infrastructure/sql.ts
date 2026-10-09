// SQL of module "customers" (schema customers only, B2). Gate 5: read-only address lookup for booking.
export const SQL = {
  ownedAddress: `
    SELECT id, customer_user_id, city_id, locality_id, line1_enc, line2_enc, landmark_enc, access_notes_enc
      FROM customers.addresses WHERE id = $1 AND customer_user_id = $2 AND deleted_at IS NULL`,
} as const;
