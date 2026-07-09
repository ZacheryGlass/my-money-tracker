export const UNCATEGORIZED_LABEL = 'Uncategorized';

export function formatCategoryLabel(category, fallback = UNCATEGORIZED_LABEL) {
  const label = typeof category === 'string' ? category.trim() : '';
  return label || fallback;
}
