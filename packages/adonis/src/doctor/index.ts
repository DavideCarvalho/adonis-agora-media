import type { AgoraDoctorCheck } from './agora_doctor.js';
import { mediaDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';
export {
  checkAccountConsole,
  checkConsoleGate,
  checkDbSchema,
  checkDisks,
  checkStoreSchema,
  checkTenancySchema,
  type DriveDisks,
  dbSchemaDoctorCheck,
  hasConfiguredSchema,
  resolveDriveDisks,
} from './checks.js';

/** Every media check, for `node ace agora:doctor --no-boot` (which imports this entry). */
export const agoraDoctorChecks: AgoraDoctorCheck[] = mediaDoctorChecks;
