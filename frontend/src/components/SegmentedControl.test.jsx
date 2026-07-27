import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import SegmentedControl from './SegmentedControl';

const OPTIONS = [
  { value: '', label: 'All' },
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', selectLabel: 'Beta (2)' },
];

describe('SegmentedControl', () => {
  it('marks the selected segment and reports the picked value', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Type" options={OPTIONS} value="a" onChange={onChange} />);

    expect(screen.getByRole('group', { name: 'Type' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Alpha' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Beta' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('passes non-string option values through untouched from the segments', () => {
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Period"
        options={[{ value: 30, label: '30 Days' }, { value: 60, label: '60 Days' }]}
        value={30}
        onChange={onChange}
      />
    );

    expect(screen.getByRole('button', { name: '30 Days' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: '60 Days' }));
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it("mobile='select' mounts a labeled dropdown beside the segments, with selectLabel fallbacks", () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Account" mobile="select" options={OPTIONS} value="" onChange={onChange} />);

    // Both renderings mount and CSS picks one, so the segments are still there.
    expect(screen.getByRole('group', { name: 'Account' })).toBeInTheDocument();

    const select = screen.getByRole('combobox');
    expect(screen.getByRole('option', { name: 'Beta (2)' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('applies an activeClassName override only to the selected option', () => {
    render(
      <SegmentedControl
        label="Show"
        options={[
          { value: 'all', label: 'Everything' },
          { value: 'review', label: 'Needs review', activeClassName: 'text-orange-300' },
        ]}
        value="review"
        onChange={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: 'Needs review' }).className).toContain('text-orange-300');
    expect(screen.getByRole('button', { name: 'Everything' }).className).not.toContain('text-orange-300');
  });
});
