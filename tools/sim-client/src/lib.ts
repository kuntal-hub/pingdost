// @pingdost/sim-client as a library: headless devices for integration tests.
export { echoPlatform, simCalls } from './calls';
export type { SimCallsOptions } from './calls';
export { SimClient } from './client';
export type { Endpoints, SimClientOptions } from './client';
export { capturingSocket, containsMarker } from './frames';
