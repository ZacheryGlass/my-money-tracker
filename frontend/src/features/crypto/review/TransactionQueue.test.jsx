import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TransactionQueue from './TransactionQueue';

const apiMocks = vi.hoisted(() => ({
  crypto: { getLedger: vi.fn() },
  eth: {
    setActivityOverride: vi.fn(),
    clearActivityOverride: vi.fn(),
    labelAddress: vi.fn(),
    getTransfers: vi.fn(),
  },
  exchanges: { resolveRecord: vi.fn() },
}));

vi.mock('../../../utils/api', () => ({
  crypto: apiMocks.crypto,
  eth: apiMocks.eth,
  exchanges: apiMocks.exchanges,
}));

const TX = (n) => `0x${String(n).repeat(64)}`;
const deposit = (n, overrides = {}) => ({
  id: `onchain:1:${TX(n)}:1`,
  source: 'onchain',
  source_label: 'Ethereum',
  row_id: n,
  occurred_at: `2018-01-0${n}T00:00:00Z`,
  category: 'exchange_deposit',
  needs_review: true,
  review_reason: 'No exchange record matches this transfer',
  legs: [{ asset: 'ETH', direction: 'out', amount: '1', units: '1', decimals: 0 }],
  wallet_id: 1,
  wallet_label: 'Main',
  chain_id: 1,
  tx_hash: TX(n),
  counterparty_address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  counterparty_name: 'Binance',
  is_overridden: false,
  override_note: null,
  usd_value: '100.00',
  usd_basis: 'exact',
  ...overrides,
});

const send = (n, address) => deposit(n, {
  category: 'send',
  review_reason: 'Counterparty has no verdict: spending, a gift, or a transfer?',
  counterparty_name: null,
  counterparty_address: address,
});

const setQueue = (rows) => apiMocks.crypto.getLedger.mockResolvedValue({ data: rows, pagination: { total: rows.length } });

describe('TransactionQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.eth.setActivityOverride.mockResolvedValue({ override: {} });
    apiMocks.eth.clearActivityOverride.mockResolvedValue({});
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });
    apiMocks.eth.getTransfers.mockResolvedValue({ data: [] });
  });

  it('groups identical problems into one decision with what would explain them', async () => {
    setQueue([deposit(1), deposit(2), deposit(3), deposit(4)]);
    render(<TransactionQueue />);

    expect(await screen.findByText(/4 × Exchange deposit/)).toBeInTheDocument();
    expect(screen.getByText(/No record from Binance covers these transfers/)).toBeInTheDocument();
    expect(screen.getByText('$400.00')).toBeInTheDocument();
    expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(expect.objectContaining({ needsReview: 'true' }));
  });

  it('marks a whole group reviewed after a confirm, refreshes once, and can undo', async () => {
    setQueue([deposit(1), deposit(2, { is_overridden: true })]);
    const onDataChanged = vi.fn();
    render(<TransactionQueue onDataChanged={onDataChanged} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Mark all 2 reviewed' }));
    expect(apiMocks.eth.setActivityOverride).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Mark all 2 reviewed?' });
    setQueue([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark reviewed' }));

    await waitFor(() => expect(apiMocks.eth.setActivityOverride).toHaveBeenCalledTimes(2));
    expect(apiMocks.eth.setActivityOverride).toHaveBeenCalledWith(
      expect.objectContaining({ walletId: 1, txHash: TX(1), chainId: 1, category: 'exchange_deposit' })
    );
    await waitFor(() => expect(onDataChanged).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Marked 2 reviewed.')).toBeInTheDocument();

    // Only the row with no prior override is taken back: clearing the other
    // would delete a correction the user made before.
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    await waitFor(() => expect(apiMocks.eth.clearActivityOverride).toHaveBeenCalledTimes(1));
    expect(apiMocks.eth.clearActivityOverride).toHaveBeenCalledWith({ walletId: 1, txHash: TX(1), chainId: 1 });
  });

  it('labels the counterparty of a one-way group, explaining every transfer with it', async () => {
    const address = '0xcccccccccccccccccccccccccccccccccccccccc';
    setQueue([send(1, address), send(2, address)]);
    render(<TransactionQueue />);

    fireEvent.click(await screen.findByRole('button', { name: /label 0xcccc/i }));
    fireEvent.change(screen.getByLabelText('Counterparty verdict'), { target: { value: 'external' } });
    fireEvent.click(screen.getByRole('button', { name: 'Label and explain 2' }));

    await waitFor(() => expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(address, null, { kind: 'external' }));
  });

  it('says so when nothing is left', async () => {
    setQueue([]);
    render(<TransactionQueue />);
    expect(await screen.findByText('Every transaction is explained.')).toBeInTheDocument();
  });
});
