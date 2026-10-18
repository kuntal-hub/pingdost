/** Health DTOs: `/healthz` (liveness) and `/readyz` (dependencies), Phase 5. */
import { z } from 'zod';

export const HEALTH_PATH = '/healthz';
export const READY_PATH = '/readyz';

export const HealthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ReadyResponseSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
  checks: z.record(z.string(), z.enum(['ok', 'fail'])),
});
export type ReadyResponse = z.infer<typeof ReadyResponseSchema>;
