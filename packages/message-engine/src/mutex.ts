/** Runs async critical sections one at a time, in call order. */
export class Mutex {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(section: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(section);
    // The next section waits for this one whether it succeeds or not.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
