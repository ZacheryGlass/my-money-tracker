import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RowMenu from './RowMenu';

describe('RowMenu', () => {
  const items = (onSelect) => [
    { key: 'a', label: 'First', onSelect },
    { key: 'b', label: 'Blocked', disabled: true, onSelect },
  ];

  it('opens on click, runs an item, and closes', () => {
    const onSelect = vi.fn();
    render(<RowMenu label="More actions for Main" items={items(onSelect)} />);

    fireEvent.click(screen.getByRole('button', { name: 'More actions for Main' }));
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus();
    fireEvent.click(screen.getByRole('menuitem', { name: 'First' }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ignores a disabled item and closes on Escape, returning focus', () => {
    const onSelect = vi.fn();
    render(<RowMenu label="More" items={items(onSelect)} />);
    const button = screen.getByRole('button', { name: 'More' });

    fireEvent.click(button);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Blocked' }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByRole('menu')).toBeNull();
    expect(button).toHaveFocus();
  });

  it('keeps the click from reaching the row it sits in', () => {
    const onRow = vi.fn();
    render(<div onClick={onRow}><RowMenu label="More" items={items(vi.fn())} /></div>);

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(onRow).not.toHaveBeenCalled();
  });
});
