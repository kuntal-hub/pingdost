/**
 * The in-memory connection registry, `deviceId → connection` (ARCHITECTURE A2: one API
 * instance until Phase 20). One live socket per device: a newer one replaces the old.
 * Connections that name their user can also be found per user (group notices, ADR 0016).
 */
export interface RegisteredConnection {
  readonly deviceId: string;
  readonly userId?: string;
  /** Called on the old connection when a newer one for the same device registers. */
  replaced(): void;
}

export class ConnectionRegistry<C extends RegisteredConnection = RegisteredConnection> {
  readonly #byDevice = new Map<string, C>();
  readonly #byUser = new Map<string, Set<C>>();

  /** Registers `connection`, replacing (and notifying) an older one for the device. */
  add(connection: C): void {
    const old = this.#byDevice.get(connection.deviceId);
    this.#byDevice.set(connection.deviceId, connection);
    if (old && old !== connection) {
      this.#unindex(old);
      old.replaced();
    }
    if (connection.userId) {
      let set = this.#byUser.get(connection.userId);
      if (!set) {
        set = new Set();
        this.#byUser.set(connection.userId, set);
      }
      set.add(connection);
    }
  }

  /** Removes `connection` if it is still the device's current one. */
  remove(connection: C): void {
    if (this.#byDevice.get(connection.deviceId) === connection) {
      this.#byDevice.delete(connection.deviceId);
      this.#unindex(connection);
    }
  }

  get(deviceId: string): C | undefined {
    return this.#byDevice.get(deviceId);
  }

  /** The user's connected devices. */
  forUser(userId: string): C[] {
    return [...(this.#byUser.get(userId) ?? [])];
  }

  get size(): number {
    return this.#byDevice.size;
  }

  #unindex(connection: C): void {
    if (!connection.userId) return;
    const set = this.#byUser.get(connection.userId);
    set?.delete(connection);
    if (set?.size === 0) this.#byUser.delete(connection.userId);
  }
}
