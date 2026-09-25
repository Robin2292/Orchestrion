import { SqliteFoundation } from "../../storage/sqlite/foundation";

/** Sole utility-host foundation lifetime. Consumers borrow get(); they never
 * close it or open a competing writer. Opening is synchronous and lazy. */
export class FoundationOwner {
  #store: SqliteFoundation | undefined;
  #closed = false;
  constructor(private readonly open: () => SqliteFoundation) {}
  get(): SqliteFoundation {
    if (this.#closed) throw new Error("SERVICE_UNAVAILABLE");
    return this.#store ??= this.open();
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#store?.close();
  }
}
