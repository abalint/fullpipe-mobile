// vitest's happy-dom environment doesn't expose a working localStorage global;
// the app code uses the bare global, so give tests a minimal in-memory one.
function memoryStorage(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store = new Map();
    },
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

if (typeof globalThis.localStorage === "undefined" || globalThis.localStorage === null) {
  Object.defineProperty(globalThis, "localStorage", { value: memoryStorage() });
  Object.defineProperty(globalThis, "sessionStorage", { value: memoryStorage() });
}
