import React, { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Modal, { ConfirmDialog } from './Modal';

function Harness({ onClose = () => {} }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <Modal open={open} onClose={() => { onClose(); setOpen(false); }} title="Edit thing">
        <button type="button">First</button>
        <button type="button">Last</button>
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('is a labelled dialog that takes focus and hands it back on Escape', async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Open' });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Edit thing' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(opener).toHaveFocus();
  });

  it('keeps Tab inside the dialog', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    const last = screen.getByRole('button', { name: 'Last' });
    last.focus();

    fireEvent.keyDown(document, { key: 'Tab' });

    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });
});

describe('ConfirmDialog', () => {
  it('names the action and cannot be dismissed while it is working', () => {
    const onCancel = vi.fn();
    const onConfirm = vi.fn();
    const { rerender } = render(
      <ConfirmDialog open title="Remove label?" confirmLabel="Remove label" onConfirm={onConfirm} onCancel={onCancel}>
        <p>Past transfers are reclassified.</p>
      </ConfirmDialog>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove label' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    rerender(
      <ConfirmDialog open busy title="Remove label?" confirmLabel="Remove label" onConfirm={onConfirm} onCancel={onCancel}>
        <p>Past transfers are reclassified.</p>
      </ConfirmDialog>
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
  });

  it('keeps focus inside while it turns busy, rather than bouncing it to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const props = { title: 'Delete?', confirmLabel: 'Delete', onConfirm: () => {}, onCancel: () => {} };
    const { rerender } = render(<ConfirmDialog open {...props}><p>Gone for good.</p></ConfirmDialog>);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    rerender(<ConfirmDialog open busy {...props}><p>Gone for good.</p></ConfirmDialog>);

    expect(document.activeElement).not.toBe(opener);
    opener.remove();
  });
});
