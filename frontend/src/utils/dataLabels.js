export const UNCATEGORIZED_LABEL = 'Uncategorized';

export function formatCategoryLabel(category, fallback = UNCATEGORIZED_LABEL) {
  const label = typeof category === 'string' ? category.trim() : '';
  return label || fallback;
}

// Title-case a raw transaction category ("FOOD_AND_DRINK" -> "Food And Drink").
export function formatTransactionCategory(category, fallback = UNCATEGORIZED_LABEL) {
  if (!category) return fallback;
  return category
    .toLowerCase()
    .split(/[_\s]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
