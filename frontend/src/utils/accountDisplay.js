export function getAccountDisplayName(account, fallback = 'Unknown Account') {
  if (!account) return fallback;

  const effectiveName = typeof account.effective_name === 'string' ? account.effective_name.trim() : '';
  if (effectiveName) return effectiveName;

  const displayName = typeof account.display_name === 'string' ? account.display_name.trim() : '';
  if (displayName) return displayName;

  const sourceName = typeof account.name === 'string' ? account.name.trim() : '';
  return sourceName || fallback;
}

export function hasAccountDisplayName(account) {
  return typeof account?.display_name === 'string' && account.display_name.trim().length > 0;
}

function getAccountId(account) {
  return account?.id ?? account?.account_id;
}

function getAccountSourceName(account) {
  const sourceName = typeof account?.account_source_name === 'string' ? account.account_source_name.trim() : '';
  if (sourceName) return sourceName;

  const name = typeof account?.name === 'string' ? account.name.trim() : '';
  return name;
}

export function buildAccountDisplayNameMap(accounts = []) {
  const uniqueAccounts = new Map();

  accounts.forEach((account) => {
    const id = getAccountId(account);
    if (id == null || uniqueAccounts.has(id)) return;
    uniqueAccounts.set(id, account);
  });

  const baseNameCounts = new Map();
  uniqueAccounts.forEach((account) => {
    const baseName = getAccountDisplayName(account);
    const key = baseName.toLocaleLowerCase();
    baseNameCounts.set(key, (baseNameCounts.get(key) || 0) + 1);
  });

  const displayNames = new Map();
  uniqueAccounts.forEach((account, id) => {
    const baseName = getAccountDisplayName(account);
    const count = baseNameCounts.get(baseName.toLocaleLowerCase()) || 0;

    if (count <= 1) {
      displayNames.set(id, baseName);
      return;
    }

    const sourceName = getAccountSourceName(account);
    const suffix = sourceName && sourceName !== baseName ? sourceName : `Account ${id}`;
    displayNames.set(id, `${baseName} (${suffix})`);
  });

  return displayNames;
}
