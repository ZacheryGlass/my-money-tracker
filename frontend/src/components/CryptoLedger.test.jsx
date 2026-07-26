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
    setActivitySpam: vi.fn(),
    labelAddress: vi.fn(),
    getReconciliation: vi.fn(),
    getUnpricedAssets: vi.fn(),
  },
  exchanges: {
    getAll: vi.fn(),
    resolveRecord: vi.fn(),
    setMatchVerdict: vi.fn(),
    clearMatchVerdict: vi.fn(),
  },
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
  // Base units + scale ride beside the decimal string, so the client renders
  // through the SHARED BigInt formatter rather than a second one of its own.
  legs: [
    { asset: 'ETH', direction: 'out', amount: '0.5', units: '5', decimals: 1 },
    { asset: 'USDC', direction: 'in', amount: '1832.4', units: '18324', decimals: 1 },
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
  exchange_match: null,
  usd_value: '1832.40',
  usd_fee: '2.35',
  usd_basis: 'exact',
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
    { asset: 'USD', direction: 'in', amount: '1832.4', units: '18324', decimals: 1 },
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
  record_needs_review: true,
  external_id: 'TRD-1',
  is_overridden: false,
  exchange_match: null,
  usd_value: '1832.40',
  usd_fee: '2.35',
  usd_basis: 'exact',
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
    apiMocks.eth.getReconciliation.mockResolvedValue({ data: [], summary: {} });
    apiMocks.eth.getUnpricedAssets.mockResolvedValue({ data: [], total: 0 });
    apiMocks.exchanges.getAll.mockResolvedValue({ accounts: [] });
  });

  it('renders a real dust receipt rather than shrugging at it', async () => {
    // 0.00000042 ETH is a row the user has to explain; "<0.000001" throws away
    // the one fact that identifies it.
    setLedger([onchain({
      category: 'receive',
      needs_review: true,
      legs: [{ asset: 'ETH', direction: 'in', amount: '0.00000042', units: '42', decimals: 8 }],
    })]);

    render(<CryptoLedger />);

    expect((await screen.findAllByText('+ 0.00000042 ETH')).length).toBeGreaterThan(0);
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
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      exchange_match: {
        match_id: 3, exchange_record_id: 55, verdict_exchange_record_id: 55,
        verdict_counter_record_id: null, match_method: 'tx_hash', match_confidence: 'high',
        verdict: null, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', needs_review: false, external_id: 'DEP-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '1.25', units: '125', decimals: 2 }],
      },
    })]);

    render(<CryptoLedger />);

    // One row, not two.
    expect(await screen.findByText('Showing 1 of 1')).toBeInTheDocument();
    // The chip carries the EVIDENCE, not just the fact: a confirm/reject is a
    // judgement about how the two were paired, so hiding it would leave
    // nothing to judge.
    expect(screen.getAllByTitle(/Both sides recorded the same transaction hash/).length).toBeGreaterThan(0);
    // Both halves on the one line: the wallet's outflow and the venue's credit.
    // The folded half is NOT merged into the description. #61 only pairs a
    // deposit with a withdrawal, so the other side is the same money seen from
    // the other end -- merging renders it as "1.25 ETH → 1.25 ETH", a swap of
    // an asset for itself.
    expect(screen.getAllByText('− 1.25 ETH').length).toBeGreaterThan(0);
    expect(screen.queryByText('1.25 ETH → 1.25 ETH')).toBeNull();
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

  it('counts the header on the same wallet the feed is narrowed to', async () => {
    // The header sentence sits directly above the rows: a user-wide summary
    // over a one-wallet feed described a ledger that was not on screen.
    render(<CryptoLedger walletId={4} />);

    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedgerSummary).toHaveBeenCalledWith({ walletId: 4 });
    });
  });

  it('asks for the whole-user summary when no wallet is selected', async () => {
    render(<CryptoLedger />);

    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedgerSummary).toHaveBeenCalledWith({});
    });
  });

  it('corrects a flagged on-chain row into eth_activity_overrides', async () => {
    setLedger([onchain({
      id: `onchain:42161:${TX2}:1`,
      category: 'send',
      needs_review: true,
      review_reason: 'Counterparty has no verdict: spending, a gift, or a transfer?',
      legs: [{ asset: 'ETH', direction: 'out', amount: '0.25', units: '25', decimals: 2 }],
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
      legs: [{ asset: 'ETH', direction: 'out', amount: '0.25', units: '25', decimals: 2 }],
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
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      exchange_match: {
        match_id: 4, exchange_record_id: 88, verdict_exchange_record_id: 88,
        verdict_counter_record_id: null, match_method: 'address_amount', match_confidence: 'medium',
        verdict: null, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', needs_review: true, external_id: 'DEP-2',
        legs: [{ asset: 'ETH', direction: 'in', amount: '1.25', units: '125', decimals: 2 }],
      },
    })]);
    apiMocks.exchanges.resolveRecord.mockResolvedValue({ record: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 1.25 ETH'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /mark the record reviewed/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.resolveRecord).toHaveBeenCalledWith(7, 88);
    });
  });

  it('confirms a pairing against the endpoint that owns verdicts', async () => {
    setLedger([onchain({
      id: `onchain:1:${TX}:1`,
      category: 'exchange_deposit',
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      chain_id: 1,
      exchange_match: {
        match_id: 3, exchange_record_id: 55, verdict_exchange_record_id: 55,
        verdict_counter_record_id: null, match_method: 'amount_window', match_confidence: 'low',
        verdict: null, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', needs_review: false, external_id: 'DEP-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '1.25', units: '125', decimals: 2 }],
      },
    })]);
    apiMocks.exchanges.setMatchVerdict.mockResolvedValue({ verdict: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 1.25 ETH'))[0]);
    // The weakest evidence is stated outright, which is what makes the choice
    // a real one.
    expect((await screen.findAllByText(/Same amount, inside the settlement window/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /same movement/i })[0]);

    await vi.waitFor(() => {
      // Keyed on (wallet, chain, tx_hash), NEVER on eth_activity.id: that
      // surrogate churns on every rebuild, which is why 041 keys it this way.
      expect(apiMocks.exchanges.setMatchVerdict).toHaveBeenCalledWith({
        exchangeRecordId: 55, walletId: 1, txHash: TX, chainId: 1, verdict: 'confirmed',
      });
    });
  });

  it('rejects a pairing, which splits it back into two rows', async () => {
    setLedger([onchain({
      category: 'exchange_deposit',
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      exchange_match: {
        match_id: 3, exchange_record_id: 55, verdict_exchange_record_id: 55,
        verdict_counter_record_id: null, match_method: 'amount_window', match_confidence: 'low',
        verdict: null, exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', needs_review: false, external_id: 'DEP-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '1.25', units: '125', decimals: 2 }],
      },
    })]);
    apiMocks.exchanges.setMatchVerdict.mockResolvedValue({ verdict: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 1.25 ETH'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /not the same/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.setMatchVerdict).toHaveBeenCalledWith(
        expect.objectContaining({ exchangeRecordId: 55, verdict: 'rejected' })
      );
    });
  });

  it('addresses a venue-to-venue verdict to the primary, not the record on screen', async () => {
    // The row shows the COUNTER record while 041 keys the verdict on the
    // primary, so the ids come from the server rather than from what is
    // rendered -- inferring them here gets this case backwards.
    setLedger([exchange({
      exchange_match: {
        match_id: 9, exchange_record_id: 71, verdict_exchange_record_id: 55,
        verdict_counter_record_id: 71, match_method: 'address_amount', match_confidence: 'medium',
        verdict: null, exchange_account_id: 8, account_name: 'Coinbase', exchange: 'coinbase',
        record_type: 'deposit', needs_review: false, external_id: 'CB-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '0.5', units: '5', decimals: 1 }],
      },
    })]);
    apiMocks.exchanges.setMatchVerdict.mockResolvedValue({ verdict: {} });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USD'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /same movement/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.setMatchVerdict).toHaveBeenCalledWith({
        exchangeRecordId: 55, counterRecordId: 71, verdict: 'confirmed',
      });
    });
  });

  it('undoes a verdict, handing the decision back to the matcher', async () => {
    setLedger([onchain({
      category: 'exchange_deposit',
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      exchange_match: {
        match_id: 3, exchange_record_id: 55, verdict_exchange_record_id: 55,
        verdict_counter_record_id: null, match_method: 'tx_hash', match_confidence: 'high',
        verdict: 'confirmed', exchange_account_id: 7, account_name: 'Kraken', exchange: 'kraken',
        record_type: 'deposit', needs_review: false, external_id: 'DEP-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '1.25', units: '125', decimals: 2 }],
      },
    })]);
    apiMocks.exchanges.clearMatchVerdict.mockResolvedValue({ message: 'removed' });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 1.25 ETH'))[0]);
    expect((await screen.findAllByText(/You confirmed this/)).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: /undo verdict/i })[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.clearMatchVerdict).toHaveBeenCalledWith(
        expect.objectContaining({ exchangeRecordId: 55 })
      );
    });
  });

  it('keeps a rejected pairing undoable after it splits the rows apart', async () => {
    // Rejecting DELETES the match row, so there is no exchange_match left to
    // hang an undo on. Without the separate rejected_match the rejection is
    // permanent and invisible: the matcher will never propose that pairing
    // again and nothing on screen can take it back.
    setLedger([onchain({
      category: 'exchange_deposit',
      legs: [{ asset: 'ETH', direction: 'out', amount: '1.25', units: '125', decimals: 2 }],
      exchange_match: null,
      rejected_match: { exchange_record_id: 55 },
    })]);
    apiMocks.exchanges.clearMatchVerdict.mockResolvedValue({ message: 'removed' });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('− 1.25 ETH'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /undo rejection/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.clearMatchVerdict).toHaveBeenCalledWith({
        exchangeRecordId: 55, walletId: 1, txHash: TX, chainId: 42161,
      });
    });
  });

  it('keeps a rejected VENUE pair undoable, addressed in the shape it was stored', async () => {
    // The exchange branch used to hardcode rejected_verdict NULL, so rejecting
    // a venue-to-venue pairing was permanent: the pair split into two rows,
    // neither carried rejected_match, the Undo button never rendered, and no
    // other screen reaches the clear endpoint. The verdict is keyed on BOTH
    // record ids here, never on (wallet, chain, tx_hash) -- there is no wallet.
    setLedger([exchange({
      exchange_match: null,
      rejected_match: { exchange_record_id: 55, counter_record_id: 71 },
    })]);
    apiMocks.exchanges.clearMatchVerdict.mockResolvedValue({ message: 'removed' });

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USD'))[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /undo rejection/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.exchanges.clearMatchVerdict).toHaveBeenCalledWith({
        exchangeRecordId: 55, counterRecordId: 71,
      });
    });
  });

  it('mounts the row detail once, not once per breakpoint', async () => {
    // DataTable keeps the desktop table and the mobile list both in the DOM and
    // hides one with CSS. Rendering the panel from both paths fetched the raw
    // legs twice for one expand and gave the correction form two copies of its
    // state, drifting apart under the same aria labels.
    setLedger([onchain()]);
    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USDC'))[0]);

    await vi.waitFor(() => expect(apiMocks.eth.getTransfers).toHaveBeenCalled());
    expect(apiMocks.eth.getTransfers).toHaveBeenCalledTimes(1);
    expect(screen.getAllByLabelText('Set category')).toHaveLength(1);
  });

  it('refetches the window the user has loaded, not just page one', async () => {
    // Reviewing is the core loop of this screen. Refetching offset 0 / limit
    // 100 after every action threw away every Load More page (and closed the
    // open detail row with them), which makes a draining queue look like it is
    // refilling itself.
    const page = (from, count) => Array.from({ length: count }, (unused, i) => onchain({
      id: `onchain:1:0x${from + i}:1`,
      row_id: from + i,
      tx_hash: TX,
    }));
    apiMocks.crypto.getLedger.mockImplementation(async ({ offset }) => (
      offset ? { data: page(100, 50), pagination: { total: 150 } }
        : { data: page(0, 100), pagination: { total: 150 } }
    ));
    apiMocks.eth.setActivityOverride.mockResolvedValue({ override: {} });

    render(<CryptoLedger />);
    fireEvent.click(await screen.findByRole('button', { name: /load more/i }));
    await vi.waitFor(() => expect(screen.getByText('Showing 150 of 150')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('0.5 ETH → 1,832.4 USDC')[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /save correction/i }))[0]);

    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 150, offset: 0 })
      );
    });
  });

  it('does not offer to resolve a record that is already clear', async () => {
    // On a folded pair the row's needs_review can belong to the OTHER half.
    // A button wired to the ORed flag resolves a record that is already clear
    // and leaves the row still flagged -- a button that looks broken.
    setLedger([exchange({
      needs_review: true,
      record_needs_review: false,
      exchange_match: {
        match_id: 9, exchange_record_id: 71, verdict_exchange_record_id: 55,
        verdict_counter_record_id: 71, match_method: 'address_amount', match_confidence: 'medium',
        verdict: null, exchange_account_id: 8, account_name: 'Coinbase', exchange: 'coinbase',
        record_type: 'deposit', needs_review: true, external_id: 'CB-1',
        legs: [{ asset: 'ETH', direction: 'in', amount: '0.5', units: '5', decimals: 1 }],
      },
    })]);

    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USD'))[0]);

    expect(screen.queryByRole('button', { name: /^mark reviewed$/i })).toBeNull();
    // The flag belongs to the folded half, and its own button targets it.
    expect((await screen.findAllByRole('button', { name: /mark the record reviewed/i })).length)
      .toBeGreaterThan(0);
  });

  it('shows the dollars the transaction was worth AT THE TIME', async () => {
    setLedger([onchain({ usd_value: '152.30', usd_basis: 'exact' })]);
    render(<CryptoLedger />);
    // Both bounds at two decimals, so a money column's decimal points line up
    // instead of mixing $1,234.5, $1,234 and $0.5.
    expect((await screen.findAllByText('$152.30')).length).toBeGreaterThan(0);
  });

  it('renders a sub-cent value as "< $0.01", never as $0', async () => {
    // Rounding to whole dollars puts a real 42-cent movement in the same cell
    // as a fabricated zero, which is the confusion the whole USD column exists
    // to avoid.
    setLedger([onchain({ usd_value: '0.004', usd_basis: 'exact' })]);
    render(<CryptoLedger />);
    expect((await screen.findAllByText('< $0.01')).length).toBeGreaterThan(0);
    expect(screen.queryByText('$0')).toBeNull();
  });

  it('says "No USD value" rather than showing an unpriced row as $0', async () => {
    // A 2019 token outside a free key's range is not worth zero; a blank or a
    // 0 in a money column is the one reading that must be impossible.
    setLedger([onchain({ usd_value: null, usd_fee: null, usd_basis: 'unpriced' })]);
    render(<CryptoLedger />);

    // Same wording as the per-leg feed and the triage queue, from the one
    // shared formatter -- two copies of this rule would eventually disagree
    // about which state means "worthless".
    expect((await screen.findAllByText('No USD value')).length).toBeGreaterThan(0);
    expect(screen.queryByText('$0')).toBeNull();
    expect(screen.getAllByTitle(/No price for this asset on this date — not zero/).length).toBeGreaterThan(0);
  });

  it('marks a carried price as approximate rather than passing it off as exact', async () => {
    setLedger([onchain({ usd_value: '1500.00', usd_basis: 'carried' })]);
    render(<CryptoLedger />);
    expect((await screen.findAllByTitle(/nearest earlier close/)).length).toBeGreaterThan(0);
  });

  it('warns when the chain disagrees with the stored ledger', async () => {
    // #62's audit: a native drift means a transfer is missing, so the totals
    // above it are short and saying "everything is explained" would be false.
    apiMocks.eth.getReconciliation.mockResolvedValue({
      data: [
        { wallet_id: 1, chain_id: 1, asset_key: 'ETH', status: 'mismatch' },
        // A token delta is NOT counted: rebasing and fee-on-transfer contracts
        // drift with no transfer to record, and a warning that cannot clear
        // gets ignored -- taking the ETH signal with it.
        { wallet_id: 1, chain_id: 1, asset_key: '0xabc', status: 'mismatch' },
      ],
      summary: {},
    });

    render(<CryptoLedger />);

    expect(await screen.findByText(/does not reproduce the ETH balance/)).toBeInTheDocument();
    expect(screen.getByText(/on 1 wallet\/chain/)).toBeInTheDocument();
  });

  it('names the assets it could not price, so a gap is not read as zero', async () => {
    apiMocks.eth.getUnpricedAssets.mockResolvedValue({
      // asset_symbol is the column GET /api/eth/prices/unpriced actually emits;
      // reading `symbol` here printed the raw erc20:1:0x… key at the user.
      data: [{ asset_key: 'erc20:1:0xabc', asset_symbol: 'OLDTOKEN' }],
      total: 1,
    });

    render(<CryptoLedger />);

    expect(await screen.findByText(/OLDTOKEN/)).toBeInTheDocument();
    expect(screen.getByText(/not the same as \$0/)).toBeInTheDocument();
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

  // --- the spam quarantine (#74) --------------------------------------------

  it('asks for the quarantine only when the Spam view is chosen', async () => {
    render(<CryptoLedger />);
    await vi.waitFor(() => expect(apiMocks.crypto.getLedger).toHaveBeenCalled());

    // The default sends NO spam param at all: the server's own default
    // ('exclude') answers, so the client never restates the contract.
    expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
      expect.not.objectContaining({ spam: expect.anything() })
    );

    fireEvent.click(screen.getAllByRole('tab', { name: 'Quarantined' })[0]);
    await vi.waitFor(() => {
      expect(apiMocks.crypto.getLedger).toHaveBeenCalledWith(
        expect.objectContaining({ spam: 'only', offset: 0 })
      );
    });
    // The view says what it is: kept out of Needs Review, nothing deleted.
    expect(screen.getByText(/Nothing was deleted/)).toBeInTheDocument();
  });

  it('says how many rows the quarantine is hiding', async () => {
    // A quarantine that never states how much it swallowed is
    // indistinguishable from a sync that never fetched anything.
    apiMocks.crypto.getLedgerSummary.mockResolvedValue({
      summary: {
        total: 12, needs_review_count: 0, onchain_count: 8, exchange_count: 4,
        matched_count: 0, spam_count: 37, first_at: null, last_at: null,
      },
    });

    render(<CryptoLedger />);

    expect(await screen.findByText(/37 quarantined/)).toBeInTheDocument();
  });

  it('names the reason a row was quarantined and rescues it in one click', async () => {
    setLedger([onchain({
      category: 'receive',
      spam: true,
      spam_reason: 'address_poisoning',
      needs_review: false,
      legs: [{ asset: 'ETH', direction: 'in', amount: '0', units: '0', decimals: 0 }],
    })]);
    apiMocks.eth.setActivitySpam.mockResolvedValue({ override: {} });

    render(<CryptoLedger />);
    // The reason is on the row, not only in a tooltip somewhere else: a row
    // hidden on grounds nobody can state is what a quarantine must never be.
    expect((await screen.findAllByText('Lookalike address')).length).toBeGreaterThan(0);

    fireEvent.click(screen.getAllByText('+ 0 ETH')[0]);
    fireEvent.click((await screen.findAllByRole('button', { name: /not spam/i }))[0]);

    await vi.waitFor(() => {
      // The SAME endpoint Settings' quarantine section posts to, with an
      // explicit boolean -- a coerced 'false' would quarantine the row being
      // rescued.
      expect(apiMocks.eth.setActivitySpam).toHaveBeenCalledWith(1, TX, false, { chainId: 42161 });
      expect(apiMocks.crypto.getLedger.mock.calls.length).toBeGreaterThan(1);
    });
  });

  it('offers no rescue on a row that was never quarantined', async () => {
    setLedger([onchain()]);
    render(<CryptoLedger />);
    fireEvent.click((await screen.findAllByText('0.5 ETH → 1,832.4 USDC'))[0]);
    expect(screen.queryByRole('button', { name: /not spam/i })).toBeNull();
  });

  // --- the bridge fold (#59) ------------------------------------------------

  it('renders a linked bridge pair as one event, with the far side stated', async () => {
    // Two chains recorded ONE movement of the user's own money. Rendering both
    // legs doubles the dollars and asks for two explanations of one thing.
    setLedger([onchain({
      category: 'bridge_out',
      chain_id: 1,
      legs: [{ asset: 'ETH', direction: 'out', amount: '3', units: '3', decimals: 0 }],
      usd_value: '6000.00',
      bridge_match: {
        link_id: 4, wallet_id: 2, wallet_label: 'Second', chain_id: 42161,
        chain_label: 'Arbitrum One', tx_hash: TX2, category: 'bridge_in',
        needs_review: false, usd_value: '5996.00', usd_basis: 'exact',
        asset: 'ETH', out_amount: '3', in_amount: '2.998', fee_amount: '0.002',
        legs: [{ asset: 'ETH', direction: 'in', amount: '2.998', units: '2998', decimals: 3 }],
      },
    })]);

    render(<CryptoLedger />);

    expect(await screen.findByText('Showing 1 of 1')).toBeInTheDocument();
    expect(screen.getAllByText('Bridged').length).toBeGreaterThan(0);
    // The out side hosts, so the row's own dollars are the mover's -- $6,000,
    // not $11,996.
    expect(screen.getAllByText('$6,000.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('$5,996.00')).toBeNull();

    fireEvent.click(screen.getAllByText('− 3 ETH')[0]);
    // The arrival is stated rather than dropped, with what the bridge took.
    expect((await screen.findAllByText(/Bridged to Arbitrum One/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText('+ 2.998 ETH').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/bridge fee 0.002 ETH/).length).toBeGreaterThan(0);
  });

  it('leaves an unlinked bridge leg as its own flagged row', async () => {
    // Nothing may present a half-finished bridge as a completed transfer.
    setLedger([onchain({
      category: 'bridge_out',
      needs_review: true,
      review_reason: 'unmatched_bridge',
      bridge_match: null,
      legs: [{ asset: 'ETH', direction: 'out', amount: '1', units: '1', decimals: 0 }],
    })]);

    render(<CryptoLedger />);

    expect(await screen.findByText('Showing 1 of 1')).toBeInTheDocument();
    expect(screen.queryByText('Bridged')).toBeNull();
    expect(screen.getAllByText('Review').length).toBeGreaterThan(0);
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
