import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import EthLedger from './EthLedger';

const getEthLedger = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ crypto: { getEthLedger } }));
const entry = {
  id: 'gas:1', sequence: '1', scope: 'wallet:1:1', name: 'Test wallet', chain_id: 1,
  chain_name: 'Ethereum', occurred_at: '2026-01-01T00:00:00', reference: `0x${'a'.repeat(64)}`,
  kind: 'gas', delta_wei: '-1', balance_wei: '1000000000000000001', account_balance_wei: '1000000000000000001',
};
const result = {
  data: [entry], total: 201, closing_balance_wei: '9007199254740993000000000000000001', unknown_amounts: 0,
  scopes: [{ scope: 'wallet:1:1', name: 'Test wallet', chain_id: 1, chain_name: 'Ethereum',
    coverage: [{ feed: 'internal', status: 'unsupported', from_block: null, through_block: null }],
    audit: { status: 'skipped' }, adjustment_wei: '-1' }],
};

describe('ETH ledger', () => {
  beforeEach(() => { getEthLedger.mockReset(); getEthLedger.mockResolvedValue(result); });

  it('renders exact wei, honest balance labels, fee rows and coverage', async () => {
    render(<EthLedger />);
    await screen.findByText('9,007,199,254,740,993.000000000000000001 ETH');
    const table = within(screen.getByRole('table'));
    expect(table.getByText('-0.000000000000000001')).toBeInTheDocument();
    expect(table.getAllByText('1.000000000000000001')).toHaveLength(2);
    expect(table.getByText('Gas fee')).toBeInTheDocument();
    expect(screen.getByText(/reconstructed balance, not a verified historical balance/)).toBeInTheDocument();
    expect(screen.getByText(/internal: unsupported/)).toBeInTheDocument();
    expect(screen.getByText(/Audit-only adjustment excluded: -0.000000000000000001 ETH/)).toBeInTheDocument();
  });

  it('pages through all history and resets paging when account scope changes', async () => {
    render(<EthLedger walletId={1} />);
    await screen.findByRole('button', { name: 'Last' });
    fireEvent.click(screen.getByRole('button', { name: 'Last' }));
    await waitFor(() => expect(getEthLedger).toHaveBeenLastCalledWith({ walletId: 1, limit: 100, offset: 200 }));
    await screen.findByRole('button', { name: 'First' });
    fireEvent.change(screen.getByLabelText('Ledger account'), { target: { value: 'wallet:1:1' } });
    await waitFor(() => expect(getEthLedger).toHaveBeenLastCalledWith({ walletId: 1, scope: 'wallet:1:1', limit: 100, offset: 0 }));
  });

  it('does not display stale rows while a new scope loads or replace errors with zero', async () => {
    let rejectRequest;
    render(<EthLedger />);
    await screen.findByRole('table');
    getEthLedger.mockImplementationOnce(() => new Promise((_, reject) => { rejectRequest = reject; }));
    fireEvent.change(screen.getByLabelText('Ledger account'), { target: { value: 'wallet:1:1' } });
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    rejectRequest(new Error('offline'));
    await screen.findByRole('alert');
    expect(screen.queryByText(/Closing recorded balance:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table');
  });

  it('shows unknown amounts without fabricating a balance', async () => {
    getEthLedger.mockResolvedValue({ ...result, unknown_amounts: 1, closing_balance_wei: null,
      data: [{ ...entry, delta_wei: null, balance_wei: null, account_balance_wei: null }] });
    render(<EthLedger />);
    await screen.findByText('Unknown ETH');
    expect(within(screen.getByRole('table')).getAllByText('Unknown')).toHaveLength(3);
  });

  it('shows dated, actionable findings and counts for only the selected account across pages', async () => {
    const issues = [
      { kind: 'missing_history', count: 1, from: '2024-01-01T00:00:00Z', through: '2024-03-01T00:00:00Z',
        summary: 'A statement interval is missing.', evidence_needed: 'A complete statement spanning the discontinuity.' },
      { kind: 'unmatched_transfer', count: 3, from: '2024-02-01T00:00:00Z', through: null,
        summary: 'Transfers are recorded without endpoint identity.', evidence_needed: 'Native transfer identifiers.' },
      { kind: 'fee_evidence', count: 2, summary: 'Fee breakdown missing.', evidence_needed: 'Original fee asset and amount.' },
      { kind: 'balance_comparison', count: 1, summary: 'Staking event pending.', evidence_needed: 'Terminal event evidence.' },
    ];
    getEthLedger.mockResolvedValue({ ...result, scopes: [result.scopes[0],
      { scope: 'exchange:42', name: 'Test exchange', chain_id: null,
        history_findings: { observed_at: '2025-01-01T00:00:00Z', issues } },
    ] });
    render(<EthLedger />);
    await screen.findByText(/Dated assessments available for 1 of 2/);
    const counts = within(screen.getByRole('list', { name: 'Documented history issue counts', hidden: true }));
    expect(counts.getByText(/Unmatched recorded transfers:/)).toHaveTextContent('3');
    expect(counts.getByText(/Unavailable fee \/ precision evidence:/)).toHaveTextContent('2');
    expect(screen.getByText(/Jan 1, 2025/)).toBeInTheDocument();
    expect(screen.getByText(/Jan 1, 2024 – Mar 1, 2024/)).toBeInTheDocument();
    expect(screen.getByText('Native transfer identifiers.')).toBeInTheDocument();
    expect(screen.getByText(/Dates span recorded events, not a missing-history interval/)).toBeInTheDocument();
    expect(screen.getAllByText(/Unknown – Unknown/)).toHaveLength(2);
    expect(screen.getByText(/Categories can overlap/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Last' }));
    await screen.findByText(/Dated assessments available for 1 of 2/);
    expect(screen.getByText('Terminal event evidence.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Ledger account'), { target: { value: 'wallet:1:1' } });
    await screen.findByText(/Dated assessments available for 0 of 1/);
    expect(screen.queryByText('Terminal event evidence.')).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Documented history issue counts', hidden: true })).not.toBeInTheDocument();
  });

  it('never calls absent or empty findings a verified period', async () => {
    getEthLedger.mockResolvedValue({ ...result, scopes: [{ ...result.scopes[0],
      history_findings: { observed_at: '2025-01-01T00:00:00Z', issues: [] } }] });
    render(<EthLedger />);
    await screen.findByText(/No issues documented in this assessment/);
    expect(screen.getByText(/Dates outside documented gaps are not automatically verified/)).toBeInTheDocument();
    expect(screen.queryByText(/^Verified period/)).not.toBeInTheDocument();
  });
});
