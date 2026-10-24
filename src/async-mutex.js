export class Mutex {
  #tail = Promise.resolve();

  runExclusive(fn) {
    const run = this.#tail.then(fn);
    this.#tail = run.then(() => {}, () => {});
    return run;
  }
}
