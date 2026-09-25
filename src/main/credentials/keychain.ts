import { createRequire } from "node:module";

/** Synchronous, in-process host port. Neither account nor bytes cross Electron IPC.
 * expected=null is add-only; replacement MUST atomically match the old 32-byte
 * authority tag. There is no enumeration or unconditional delete/upsert operation.
 */
export interface KeychainAdapter {
  read(account: string): Buffer | null;
  compareExchange(account: string, expected: Buffer | null, value: Buffer): void;
  remove(account: string, expected: Buffer): void;
}
export class KeychainUnavailable extends Error {
  constructor() { super("CREDENTIAL_UNAVAILABLE"); }
}

/** Lazy load only a packaged Node-API artifact in the utility host. Unsupported
 * OS, missing binary, locked/denied keychain and native errors all fail closed.
 * Loading the binary alone makes no Security.framework call. No CLI fallback.
 */
export function packagedKeychain(path: string, platform = process.platform): KeychainAdapter {
  const require = createRequire(import.meta.url);
  let native: KeychainAdapter | undefined;
  function load(): KeychainAdapter {
    if (platform !== "darwin") throw new KeychainUnavailable();
    native ??= require(path) as KeychainAdapter;
    return native;
  }
  return {
    read(account) {
      try {
        const result = load().read(account);
        if (result !== null && (!Buffer.isBuffer(result) || result.length < 32 || result.length > 65568))
          throw new KeychainUnavailable();
        return result;
      } catch { throw new KeychainUnavailable(); }
    },
    compareExchange(account, expected, value) {
      try { load().compareExchange(account, expected, value); }
      catch { throw new KeychainUnavailable(); }
    },
    remove(account, expected) {
      try { load().remove(account, expected); }
      catch { throw new KeychainUnavailable(); }
    },
  };
}
