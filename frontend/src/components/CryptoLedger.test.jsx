import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import CryptoLedger from './CryptoLedger';
import { LEDGER_CATEGORIES } from '../utils/dataLabels';

const apiMocks = vi.hoisted(() => ({
  crypto: { getLedger: vi.fn(), getLedgerSummary: vi.fn(), ledgerExportUrl: vi.fn() },
  eth: {
    getTransfers: vi.fn(),
    setActivityOverride: vi.fn(),
    clearActivityOverride: vi.fn(),
    labelAddress: vi.fn(),
  },
  exchanges: { getAll: vi.fn(), resolveRecord: vi.fn() },
}));

vi.mock('../utils/api', () => ({
  crypto: apiMocks.crypto,
  eth: apiMocks.eth,
  exchanges: apiMocks.exchanges,
}));

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const COUNTERPARTY = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;

// The server keys an on-chain row on (chain, hash, wallet), not on
// eth_activity.id, so the key survives the wholesale rebuild every sync and
// every label write performs.
const onchain = (overrides = {}) => ({
  id: `onchain:42161:${TX}:1`,
  source: 'onchain',
  source_label: 'Arbitrum One',
  row_id: 10,
  occurred_at: '2026-03-02T00:00:00Z',
  category: 'swap',
  needs_review: false,
  review_reason: null,
  legs: [
    { asset: 'ETH', direction: 'out', amount: '0.5' },
    { asset: 'USDC', direction: 'in', amount: '1832.4' },
  ],
  fee_amount: '0.00084',
  fee_asset: 'ETH',
  wallet_id: 1,
  wallet_address: WALLET,
  wallet_label: 'Main',
  chain_id: 42161,
  tx_hash: TX,
  counterparty_address: COUNTERPARTY,
  counterparty_name: null,
  method_name: 'swapExactTokensForTokens(uint256,uint256,address[],address,uint256)',
  is_overridden: false,
  derived_category: 'swap',
  exchange_matches: [],
  ...overrides,
});

const exchange = (overrides = {}) => ({
  id: 'exchange:55',
  source: 'exchange',
  source_label: 'Kraken',
  row_id: 55,
  occurred_at: '2026-03-01T00:00:00Z',
  category: 'exchange_trade',
  needs_review: true,
  review_reason: null,
  legs: [
    { asset: 'ETH', direction: 'out', amount: '0.5' },
    { asset: 'USD', direction: 'in', amount: '1832.4' },
  ],
  fee_amount: '4.76',
  fee_asset: 'USD',
  wallet_id: null,
  chain_id: null,
  tx_hash: null,
  counterparty_address: null,
  counterparty_name: null,
  exchange_account_id: 7,
  account_name: 'Kraken',
  record_type: 'trade',
  external_id: 'TRD-1',
  is_overridden: false,
  exchange_matches: [],
  ...overrides,
});

const setLedger = (rows, total = rows.length) => {
  apiMocks.crypto.getLedger.mockResolvedValue({ data: rows, pagination: { total } });
};

describe('CryptoLedger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLedger([]);
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: {
        total: 0, needs_review_count: 0, onchain_count: 0, exchange_count: 0, matched_count: 0,
        first_at: null, last_at: null,
      },
    });
    apiMocks.crypto.ledgerExportUrl.mockReturnValue('/api/crypto/ledger/export');
    apiMocks.eth.getTransfers.mockResolvedValue({ data: [], pagination: { total: 0 } });
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
  });

  it('interleaves both sources in one stream, newest first', async () => {
    setLedger([onchain(), exchange()]);

    render(<CryptoLedger />);

    // Both sources render as ordinary rows: the point of the merge is that a
    // trade that never touched the chain sits in the same table as a swap.
    expect((await screen.findAllByText('Arbitrum One')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Kraken').length).toBeGreaterThan(0);
    // Description built from netted legs, identically for both sources.
    expect(screen.getAllByText('0.5 ETH → 1,832.4 USDC').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.5 ETH → 1,832.4 USD').length).toBeGreaterThan(0);
  });

  it('renders a matched pair once, carrying both halves', async () => {
    // A wallet -> exchange deposit is ONE event the two sides each recorded.
    // Rendering both would double-count it and double the review burden.
    setLedger([onchain({
      id: `onchain:42161:${TX}:1`,
      category: 'exchange_deposit',
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25' }],
      exchange_matches: [{
        id: 55, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', base_asset: 'ETH', base_amount: '1.250000000000000000',
        quote_asset: null, quote_amount: null, needs_review: false, external_id: 'DEP-1',
      }],
    })]);

    render(<CryptoLedger />);

    // One row, not two.
    expect(await screen.findByText('Showing 1 of 1')).toBeInTheDocument();
    expect(screen.getAllByTitle('One event recorded on both sides; shown once').length).toBeGreaterThan(0);
    // Both halves on the one line: the wallet's outflow and the venue's credit.
    expect(screen.getAllByText('1.25 ETH → 1.25 ETH').length).toBeGreaterThan(0);
    // The matched venue names the counterparty where the chain side has none.
    expect(screen.getAllByText('Kraken').length).toBeGreaterThan(0);
  });

  it('flags what needs review and badges the total honestly', async () => {
    setLedger([exchange()]);
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: {
        total: 12, needs_review_count: 3, onchain_count: 8, exchange_count: 4, matched_count: 1,
        first_at: '2021-05-01T00:00:00Z', last_at: '2026-03-02T00:00:00Z',
      },
    });

    render(<CryptoLedger />);

    expect(await screen.findByText('3 need review')).toBeInTheDocument();
    // First transaction to today, which is the ledger's whole claim.
    expect(screen.getByText(/May 1, 2021 — Mar 2, 2026/)).toBeInTheDocument();
  });

  it('says so plainly when nothing is unexplained', async () => {
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: {
        total: 12, needs_review_count: 0, onchain_count: 8, exchange_count: 4, matched_count: 1,
        first_at: null, last_at: null,
      },
    });

    render(<CryptoLedger />);

    expect(await screen.findByText('Nothing unexplained')).toBeInTheDocument();
  });

  it('offers only categories the server will accept', async () => {
    render(<CryptoLedger />);

    // An unknown ?category= is a 400 server-side, so a picker holding a value
    // the server does not know is a dead option that breaks the whole feed.
    const select = await screen.findByLabelText('Ledger category');
    const options = within(select).getAllByRole('option').map((option) => option.textContent);
    for (const [, label] of LEDGER_CATEGORIES) {
      expect(options).toContain(label);
    }
    expect(options).toContain('All categories');
    expect(options).toHaveLength(LEDGER_CATEGORIES.length + 1);
  });

  it('sends each filter to the API rather than filtering what it already has', async () => {
    setLedger([onchain(), exchange()]);
    render(<CryptoLedger />);
    await screen.findAllByText('Arbitrum One');

    // Desktop tab strip and mobile select render together, CSS-hidden.
    fireEvent.click(screen.getAllByRole('tab', { name: 'Exchange' })[0]);
    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'exchange', offset: 0 })
      );
    });

    fireEvent.click(screen.getAllByRole('tab', { name: 'Needs Review' })[0]);
    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ needsReview: 'true' })
      );
    });

    fireEvent.change(screen.getByLabelText('Ledger category'), { target: { value: 'staking_reward' } });
    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'staking_reward' })
      );
    });
  });

  it('narrows to one wallet without silently widening back', async () => {
    render(<CryptoLedger walletId={4} />);

    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 4 })
      );
    });
  });

  it('corrects a flagged on-chain row into eth_activity_overrides', async () => {
    setLedger([onchain({
      id: `onchain:42161:${TX2}:1`,
      category: 'send',
      needs_review: true,
      review_reason: 'Counterparty has no verdict: spending, a gift, or a transfer?',
      legs: [{ asset: 'ETH', direction: 'out', amount: '0.25' }],
      tx_hash: TX2,
    })]);
    apiMocks.eth.setActivityOverride.mockResolvedValue({ override: {} });

    render(<CryptoLedger />);
    // Expand, then correct: two interactions to resolve a flagged row.
    fireEvent.click((await screen.findAllByText('− 0.25 ETH'))[0]);

    const picker = (await screen.findAllByLabelText('Set category'))[0];
    fireEvent.change(picker, { target: { value: 'spend' } });
    fireEvent.click(screen.getAllByRole('button', { name: /save correction/i })[0]);

    await vi.waitFor(() => {
      expect(apiMocks.eth.setActivityOverride).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 1, txHash: TX2, chainId: 42161, category: 'spend' })
      );
      // A correction changes what the feed and the badge say, so both refetch;
      // leaving the row showing its old verdict is how a review queue stops
      // feeling like it is draining.
      expect(apiMocks.crypto.getLedger.mock.calls.length).toBeGreaterThan(1);
      expect(apiMocks.crypto.getLedgerSummary.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('never offers an override category the activity table would reject', async () => {
    setLedger([onchain()]);
    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USDC'))[0]);

    const picker = (await screen.findAllByLabelText('Set category'))[0];
    const options = within(picker).getAllByRole('option').map((option) => option.textContent);
    // 'Fee' and 'Exchange transfer' exist only for exchange rows; eth_activity's
    // CHECK constraint has neither, so saving one would 400.
    expect(options).not.toContain('Fee');
    expect(options).not.toContain('Exchange transfer');
    expect(options).toContain('Swap');
  });

  it('reverts a correction, uncovering the derived verdict again', async () => {
    setLedger([onchain({
      category: 'spend',
      derived_category: 'send',
      is_overridden: true,
      override_note: 'Bought a domain',
      legs: [{ asset: 'ETH', direction: 'out', amount: '0.25' }],
    })]);
    apiMocks.eth.clearActivityOverride.mockResolvedValue({ message: 'Override removed' });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 0.25 ETH'))[0]);

    // The derived verdict stays visible beside the correction, so the user can
    // see what they overrode.
    expect((await screen.findAllByText(/\(was Send\)/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /revert/i })[0]);

    await vi.waitFor(() => {
      expect(apiMocks.eth.clearActivityOverride).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 1, txHash: TX, chainId: 42161 })
      );
    });
  });

  it('labels a counterparty with a chosen verdict, not a silent "exchange" vote', async () => {
    setLedger([onchain({ needs_review: true, category: 'send' })]);
    apiMocks.eth.labelAddress.mockResolvedValue({ label: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USDC'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /label counterparty/i }))[0]);

    const verdict = screen.getAllByLabelText('Counterparty verdict')[0];
    // Defaults to Keep: the server resolves it against any hidden builtin, so a
    // rename can never re-vote a pack verdict.
    expect(verdict).toHaveValue('keep');
    fireEvent.change(verdict, { target: { value: 'external' } });
    fireEvent.click(screen.getAllByRole('button', { name: /save label/i })[0]);

    await vi.waitFor(() => {
      // No name needed for this verdict; the server fills in a short address.
      expect(apiMocks.eth.labelAddress).toHaveBeenCalledWith(COUNTERPARTY, null, { kind: 'external' });
    });
  });

  it('resolves a flagged exchange record through the exchanges API', async () => {
    setLedger([exchange()]);
    apiMocks.exchanges.resolveRecord.mockResolvedValue({ record: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USD'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /mark reviewed/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.resolveRecord).toHaveBeenCalledWith(7, 55);
    });
  });

  it('resolves a flagged half folded into an on-chain row', async () => {
    // The fold must not hide a flag: the parent row carries it, and the action
    // that clears it has to be reachable from the same place.
    setLedger([onchain({
      id: `onchain:1:${TX2}:1`,
      category: 'exchange_deposit',
      needs_review: true,
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25' }],
      exchange_matches: [{
        id: 88, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', base_asset: 'ETH', base_amount: '1.250000000000000000',
        quote_asset: null, quote_amount: null, needs_review: true, external_id: 'DEP-2',
      }],
    })]);
    apiMocks.exchanges.resolveRecord.mockResolvedValue({ record: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('1.25 ETH → 1.25 ETH'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /mark reviewed/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.resolveRecord).toHaveBeenCalledWith(7, 88);
    });
  });

  it('links an on-chain row to its own chain’s explorer', async () => {
    setLedger([onchain()]);
    render(<CryptoLedger />);

    const link = (await screen.findAllByTitle(TX))[0].closest('a');
    expect(link).toHaveAttribute('href', `https://arbiscan.io/tx/${TX}`);
  });

  it('fetches the raw legs behind a transaction only when the row is opened', async () => {
    setLedger([onchain()]);
    render(<CryptoLedger />);
    await screen.findAllByText('0.5 ETH → 1,832.4 USDC');

    // Netted legs answer "what changed"; the raw ones answer "how". Riding
    // them along on every feed row would be a query per transaction.
    expect(apiMocks.eth.getTransfers).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByText('0.5 ETH → 1,832.4 USDC')[0]);
    await vi.waitFor(() => {
      expect(apiMocks.eth.getTransfers).toHaveBeenCalledWith(
        expect.objectContaining({ walletId: 1, tx_hash: TX, chain_id: 42161 })
      );
    });
  });

  it('warns when a source is behind, so "everything explained" is not overclaimed', async () => {
    apiMocks.exchanges.getAll.mockResolvedValue({
      accounts: [
        { id: 7, name: 'Kraken', last_sync_status: 'balance_mismatch' },
        { id: 8, name: 'Coinbase', last_sync_status: 'ok', balance_report: { backfill_pending: true } },
        { id: 9, name: 'Other', last_sync_status: 'ok' },
      ],
    });

    render(<CryptoLedger />);

    // The healthy account is not counted; a warning that never clears gets
    // ignored, exactly like a badge that cannot reach zero.
    expect(await screen.findByText(/2 exchange accounts have not finished syncing/)).toBeInTheDocument();
  });

  it('exports the ledger under the filters currently on screen', async () => {
    setLedger([onchain()]);
    render(<CryptoLedger walletId={4} />);
    await screen.findAllByText('Arbitrum One');

    fireEvent.click(screen.getAllByRole('tab', { name: 'Exchange' })[0]);

    await vi.waitFor(() => {
      expect(apiMocks.crypto.ledgerExportUrl).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'exchange', wallet_id: 4 })
      );
    });
  });
});
