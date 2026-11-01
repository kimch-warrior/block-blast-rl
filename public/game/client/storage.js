const PREFIX = 'bb-web:';

export function createStorage(storageSource) {
  const getStorage = () => typeof storageSource === 'function' ? storageSource() : storageSource;

  return {
    get(key, fallback = null) {
      try {
        return getStorage().getItem(PREFIX + key) ?? fallback;
      } catch {
        return fallback;
      }
    },

    set(key, value) {
      try {
        getStorage().setItem(PREFIX + key, String(value));
      } catch {
        // Browser storage may be unavailable or full; gameplay can continue.
      }
    },

    remove(key) {
      try {
        getStorage().removeItem(PREFIX + key);
      } catch {
        // Storage access is optional for the game client.
      }
    },
  };
}
