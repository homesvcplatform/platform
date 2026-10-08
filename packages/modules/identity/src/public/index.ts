// Public facade of module "identity". The ONLY entry other modules and apps may import (B1).
export const moduleName = 'identity' as const;
export const schemaName = 'identity' as const;
export type { OtpSender } from './ports.ts';
