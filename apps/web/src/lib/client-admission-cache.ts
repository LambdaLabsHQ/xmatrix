/** Page-lifetime, single-identity admission cache; never stores user data. */
export class ClientAdmissionCache<T> {
  private entry?: { key: string; promise: Promise<T> };

  read(key: string, check: () => Promise<T>): Promise<T> {
    if (this.entry?.key === key) return this.entry.promise;
    const entry = { key, promise: Promise.resolve().then(check) };
    this.entry = entry;
    void entry.promise.catch(() => {
      if (this.entry === entry) this.entry = undefined;
    });
    return entry.promise;
  }

  clear(): void { this.entry = undefined; }
}
