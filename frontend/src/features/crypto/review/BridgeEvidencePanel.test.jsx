import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import BridgeEvidencePanel from './BridgeEvidencePanel';

const apiMocks = vi.hoisted(() => ({
  crypto: {
    getLedger: vi.fn(), getBridgeAudit: vi.fn(), setBridgeVerdict: vi.fn(), clearBridgeVerdict: vi.fn(),
  },
}));

vi.mock('../../../utils/api', () => ({ crypto: apiMocks.crypto }));

const TX = `0x${'1'.repeat(64)}`;
const TX2 = `0x${'2'.repeat(64)}`;

// Moved off the Activity ledger with the Review queues: every actionable row
// here is a decision, and the ledger only shows the folded result.
describe('BridgeEvidencePanel', () => {
  let onChanged;
  let onError;
  beforeEach(() => {
    vi.clearAllMocks();
    onChanged = vi.fn();
    onError = vi.fn();
  });

  it('keeps ambiguous bridge candidates suggested and exposes lifecycle/verdict controls', async () => {
    apiMocks.crypto.getBridgeAudit.mockResolvedValue({
      summary: { protocol_verified: 0, user_confirmed: 0, suggestions: 1, receipt_failures: 1 },
      movements: [{
        id: 20, protocol: 'polygon', family_version: 'pos-plasma', status: 'pending',
        members: [{ chain_id: 1, tx_hash: TX }],
        evidence: { ambiguity: 'awaiting_chain_finality' },
      }],
      suggestions: [{
        id: 30, protocol: 'polygon', out_wallet_id: 1, out_chain_id: 1,
        out_tx_hash: TX, in_wallet_id: 2, in_chain_id: 137, in_tx_hash: TX2,
        ambiguous: true, suggestion_reason: 'asset_amount',
      }],
      verdicts: [{
        id: 40, verdict: 'rejected', out_wallet_id: 1, out_chain_id: 1,
        out_tx_hash: TX, in_wallet_id: 2, in_chain_id: 10, in_tx_hash: TX2,
      }],
      receipt_failures: [{
        id: 50, chain_id: 10, tx_hash: TX, provider: 'json-rpc',
        status: 'failed', error_code: 'BRIDGE_RECEIPT_UNAVAILABLE',
      }],
    });
    apiMocks.crypto.setBridgeVerdict.mockResolvedValue({ verdict: { id: 30 } });
    apiMocks.crypto.clearBridgeVerdict.mockResolvedValue({ removed: 1 });

    render(<BridgeEvidencePanel onChanged={onChanged} onError={onError} />);

    expect(await screen.findByText('Matching amounts alone never pair two transfers.')).toBeInTheDocument();
    expect(screen.getByText(/More than one transfer could be the other side/)).toBeInTheDocument();
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/Both sides found; waiting for the networks to finalize/)).toBeInTheDocument();
    expect(screen.getByText(/Couldn.t look up this transfer/)).toBeInTheDocument();
    expect(screen.getAllByText('Failed').length).toBeGreaterThan(0);
    expect(screen.getByText(/You rejected/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(apiMocks.crypto.setBridgeVerdict).toHaveBeenCalledWith(
      expect.objectContaining({ verdict: 'confirmed', outTxHash: TX, inTxHash: TX2 })
    ));
  });

  it('makes truncated bridge alternatives explicit and loads the next independent page', async () => {
    const secondTx = `0x${'3'.repeat(64)}`;
    apiMocks.crypto.getBridgeAudit
      .mockResolvedValueOnce({
        summary: { suggestions: 2 }, movements: [], verdicts: [], receipt_failures: [],
        suggestions: [{
          id: 1, protocol: 'optimism', out_wallet_id: 1, out_chain_id: 1,
          out_tx_hash: TX, in_wallet_id: 2, in_chain_id: 10, in_tx_hash: TX2,
          ambiguous: true, suggestion_reason: 'asset_amount',
        }],
        pagination: { suggestions: { limit: 1, offset: 0, total: 2, generation: '2:2', has_more: true } },
      })
      .mockResolvedValueOnce({
        summary: { suggestions: 2 }, movements: [], verdicts: [], receipt_failures: [],
        suggestions: [{
          id: 2, protocol: 'arbitrum', out_wallet_id: 1, out_chain_id: 1,
          out_tx_hash: TX, in_wallet_id: 3, in_chain_id: 42161, in_tx_hash: secondTx,
          ambiguous: true, suggestion_reason: 'asset_amount',
        }],
        pagination: { suggestions: { limit: 1, offset: 1, total: 2, generation: '2:2', has_more: false } },
      });

    render(<BridgeEvidencePanel onChanged={onChanged} onError={onError} />);

    expect(await screen.findByText(/Showing 1 of 2 plausible alternatives/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show more alternatives' }));
    await waitFor(() => expect(apiMocks.crypto.getBridgeAudit).toHaveBeenLastCalledWith({
      suggestion_limit: 1, suggestion_offset: 1, suggestion_generation: '2:2', limit: 1,
    }));
    expect(await screen.findByText(/Arbitrum · Ethereum/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Show more alternatives' })).not.toBeInTheDocument());
  });

  it('restarts suggestion review when a rebuild invalidates the page generation', async () => {
    const firstPage = {
      summary: { suggestions: 2 }, movements: [], verdicts: [], receipt_failures: [],
      suggestions: [{
        id: 1, protocol: 'optimism', out_wallet_id: 1, out_chain_id: 1,
        out_tx_hash: TX, in_wallet_id: 2, in_chain_id: 10, in_tx_hash: TX2,
        ambiguous: true, suggestion_reason: 'asset_amount',
      }],
      pagination: { suggestions: { limit: 1, offset: 0, total: 2, generation: '2:2', has_more: true } },
    };
    const restarted = {
      ...firstPage,
      summary: { suggestions: 1 },
      suggestions: [{ ...firstPage.suggestions[0], id: 9, protocol: 'linea', in_chain_id: 59144 }],
      pagination: { suggestions: { limit: 500, offset: 0, total: 1, generation: '9:1', has_more: false } },
    };
    apiMocks.crypto.getBridgeAudit
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce({ response: { status: 409, data: { error: 'stale generation' } } })
      .mockResolvedValueOnce(restarted);

    render(<BridgeEvidencePanel onChanged={onChanged} onError={onError} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show more alternatives' }));

    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringMatching(/changed while you were reviewing/)));
    expect(await screen.findByText(/Linea · Ethereum/)).toBeInTheDocument();
    expect(apiMocks.crypto.getBridgeAudit).toHaveBeenCalledTimes(3);
  });

});
