/** A current value plus change notifications (`status$`), without an RxJS dependency. */
export interface ReadonlyValueStream<T> {
  readonly value: T;
  /** Calls `listener` on every change (and once now, with `emitCurrent`). */
  subscribe(listener: (value: T) => void, options?: { emitCurrent?: boolean }): () => void;
}

export class ValueStream<T> implements ReadonlyValueStream<T> {
  #value: T;
  readonly #listeners = new Set<(value: T) => void>();

  constructor(initial: T) {
    this.#value = initial;
  }

  get value(): T {
    return this.#value;
  }

  set(value: T): void {
    if (Object.is(value, this.#value)) return;
    this.#value = value;
    for (const listener of [...this.#listeners]) listener(value);
  }

  subscribe(listener: (value: T) => void, options: { emitCurrent?: boolean } = {}): () => void {
    this.#listeners.add(listener);
    if (options.emitCurrent) listener(this.#value);
    return () => this.#listeners.delete(listener);
  }
}

/** A set of listeners for one kind of event. */
export class Listeners<A extends unknown[]> {
  readonly #listeners = new Set<(...args: A) => void>();

  add(listener: (...args: A) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(...args: A): void {
    for (const listener of [...this.#listeners]) listener(...args);
  }

  get size(): number {
    return this.#listeners.size;
  }
}
