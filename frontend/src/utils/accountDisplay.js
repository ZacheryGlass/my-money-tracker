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
