import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import PageTabs from './PageTabs';

const OPTIONS = [
  { value: 'overview', label: 'Overview' },
  { value: 'holdings', label: 'Holdings', badge: <span>3</span> },
];

describe('PageTabs', () => {
  it('marks only the active tab selected and reports clicks by value', () => {
    const onChange = vi.fn();
    render(<PageTabs label="Section" options={OPTIONS} value="overview" onChange={onChange} />);

    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /Holdings/ })).toHaveAttribute('aria-selected', 'false');

    fireEvent.click(screen.getByRole('tab', { name: /Holdings/ }));
    expect(onChange).toHaveBeenCalledWith('holdings');
  });

  it('renders one strip, never a mobile select', () => {
    // Unlike FilterTabs this must stay a strip at every width: a dropdown under
    // the page headline reads as a filter and hides the other sections.
    render(<PageTabs label="Section" options={OPTIONS} value="overview" onChange={vi.fn()} />);

    expect(screen.getAllByRole('tab')).toHaveLength(2);
    expect(screen.queryByRole('combobox')).toBeNull();
  });

  it('survives a missing onChange rather than throwing on click', () => {
    render(<PageTabs label="Section" options={OPTIONS} value="overview" />);

    expect(() => fireEvent.click(screen.getByRole('tab', { name: /Holdings/ }))).not.toThrow();
  });
});
