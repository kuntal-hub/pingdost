/**
 * The in-memory connection registry, `deviceId → connection` (ARCHITECTURE A2: one API
 * instance until Phase 20). One live socket per device: a newer one replaces the old.
 */
export interface RegisteredConnection {
  readonly deviceId: string;
  /** Called on the old connection when a newer one for the same device registers. */
  replaced(): void;
}

export class ConnectionRegistry<C extends RegisteredConnection = RegisteredConnection> {
  readonly #byDevice = new Map<string, C>();

  /** Registers `connection`, replacing (and notifying) an older one for the device. */
  add(connection: C): void {
    const old = this.#byDevice.get(connection.deviceId);
    this.#byDevice.set(connection.deviceId, connection);
    if (old && old !== connection) old.replaced();
  }

  /** Removes `connection` if it is still the device's current one. */
  remove(connection: C): void {
    if (this.#byDevice.get(connection.deviceId) === connection) {
      this.#byDevice.delete(connection.deviceId);
    }
  }

  get(deviceId: string): C | undefined {
    return this.#byDevice.get(deviceId);
  }

  get size(): number {
    return this.#byDevice.size;
  }
}
