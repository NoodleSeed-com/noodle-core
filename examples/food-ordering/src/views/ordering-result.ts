export type Store = {
  readonly id: string;
  readonly name: string;
  readonly cuisine: string;
  readonly address: string;
  readonly open: boolean;
  readonly etaMinutes: number;
  readonly rating: number;
};

export type MenuItem = {
  readonly id: string;
  readonly storeId: string;
  readonly category: string;
  readonly name: string;
  readonly price: number;
  readonly description: string;
  readonly modifiers: readonly string[];
};

export type OrderingEntryResult = {
  readonly customer: string;
  readonly stores: readonly Store[];
  readonly featuredItems: readonly MenuItem[];
  readonly status: string;
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isStore(value: unknown): value is Store {
  if (value === null || typeof value !== 'object') return false;
  const store = value as Partial<Store>;
  return (
    nonEmptyString(store.id) &&
    nonEmptyString(store.name) &&
    nonEmptyString(store.cuisine) &&
    nonEmptyString(store.address) &&
    typeof store.open === 'boolean' &&
    typeof store.etaMinutes === 'number' &&
    Number.isFinite(store.etaMinutes) &&
    typeof store.rating === 'number' &&
    Number.isFinite(store.rating)
  );
}

function isMenuItem(value: unknown): value is MenuItem {
  if (value === null || typeof value !== 'object') return false;
  const item = value as Partial<MenuItem>;
  return (
    nonEmptyString(item.id) &&
    nonEmptyString(item.storeId) &&
    nonEmptyString(item.category) &&
    nonEmptyString(item.name) &&
    typeof item.price === 'number' &&
    Number.isFinite(item.price) &&
    nonEmptyString(item.description) &&
    Array.isArray(item.modifiers) &&
    item.modifiers.every(nonEmptyString)
  );
}

export function isOrderingEntryResult(value: unknown): value is OrderingEntryResult {
  if (value === null || typeof value !== 'object') return false;
  const entry = value as Partial<OrderingEntryResult>;
  if (
    !nonEmptyString(entry.customer) ||
    !nonEmptyString(entry.status) ||
    !Array.isArray(entry.stores) ||
    !entry.stores.every(isStore) ||
    !Array.isArray(entry.featuredItems) ||
    !entry.featuredItems.every(isMenuItem)
  ) {
    return false;
  }
  const storeIds = new Set(entry.stores.map((store) => store.id));
  const itemIds = new Set(entry.featuredItems.map((item) => item.id));
  return (
    storeIds.size === entry.stores.length &&
    itemIds.size === entry.featuredItems.length &&
    entry.featuredItems.every((item) => storeIds.has(item.storeId))
  );
}
