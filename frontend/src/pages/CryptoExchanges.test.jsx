import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import CryptoPage from './CryptoPage';
import { exchanges as exchangesAPI } from '../utils/api';

vi.mock('../utils/api', () => ({
  accounts: { getAll: vi.fn().mockResolvedValue({ accounts: [] }) },
  holdings: { getAll: vi.fn().mockResolvedValue({ holdings: [] }) },
  history: { getAccounts: vi.fn().mockResolvedValue({ data: [] }) },
  crypto: {
    getLedger: vi.fn().mockResolvedValue({ data: [], pagination: { total: 0 } }),
    getLedgerSummary: vi.fn().mockResolvedValue({ summary: { total: 0, needs_review_count: 0 } }),
    ledgerExportUrl: vi.fn(),
  },
  eth: {
    getWallets: vi.fn().mockResolvedValue({ wallets: [] }),
    getIgnoredTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    getAddressLabels: vi.fn().mockResolvedValue({ labels: [] }),
    getUnreviewedCounterparties: vi.fn().mockResolvedValue({ data: [], summary: { count: 0 }, pagination: {} }),
    getActivity: vi.fn().mockResolvedValue({ data: [], summary: { spam_count: 0 }, pagination: { total: 0 } }),
  },
  exchanges: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    importCsv: vi.fn(),
    getRecords: vi.fn(),
    getMatches: vi.fn(),
    matchesExportUrl: vi.fn(() => '/api/exchanges/matches/export'),
    resolveRecord: vi.fn(),
    setCredentials: vi.fn(),
    clearCredentials: vi.fn(),
    testConnection: vi.fn(),
    sync: vi.fn(),
    startSync: vi.fn(),
    getSyncStatus: vi.fn(),
  },
}));

const ACCOUNT = {
  id: 3,
  name: 'Kraken Spot',
  exchange: 'kraken',
  record_count: 1080,
  needs_review_count: 2,
  last_import_at: new Date().toISOString(),
  // Only ever a masked status: the server never returns a stored key.
  credentials: { configured: false, key_masked: null, secret_masked: null },
  last_sync_at: null,
  last_sync_status: null,
  last_sync_error: null,
  balance_report: null,
};

const CONNECTED = {
  ...ACCOUNT,
  credentials: { configured: true, key_masked: '••••WXYZ', secret_masked: '••••MzQ=' },
  last_sync_at: new Date().toISOString(),
};

// Served by the API alongside the connector that consumes it, so the UI's
// permission guidance cannot drift from the endpoints the code actually calls.
const CREDENTIAL_FIELDS = {
  kraken: {
    keyLabel: 'API key',
    secretLabel: 'Private key',
    permissions: ['Query Funds', 'Query Ledger Entries', 'Query Closed Orders & Trades'],
    help: 'Create the key with ONLY Query Funds, Query Ledger Entries and Query Closed Orders & Trades. '
      + 'Do not grant Withdraw Funds — withdrawal destinations are readable with Query Ledger Entries alone.',
  },
};

const listResponse = (accounts, overrides = {}) => ({
  accounts,
  credential_fields: CREDENTIAL_FIELDS,
  encryption_configured: true,
  ...overrides,
});

const FLAGGED = [
  {
    id: 11,
    occurred_at: '2024-03-10T18:00:00.000Z',
    record_type: 'trade',
    base_asset: 'SOL',
    base_amount: '-2.0000000000',
    quote_asset: null,
    needs_review: true,
    raw: { type: 'trade' },
  },
  {
    id: 12,
    occurred_at: '2024-03-09T17:00:00.000Z',
    record_type: 'transfer',
    base_asset: 'DOGE',
    base_amount: '25.0000000000',
    quote_asset: null,
    needs_review: true,
    raw: { type: 'quantumsettlement' },
  },
];

// Exchange accounts live on the Crypto page's Exchanges tab (#75); App routes
// /crypto/exchanges to it, which is what the `tab` prop stands in for here.
const renderSettings = async () => {
  render(<CryptoPage tab="crypto-exchanges" onTabChange={vi.fn()} />);
  return screen.findByRole('tab', { name: /Exchanges/ });
};

beforeEach(() => {
  vi.clearAllMocks();
  exchangesAPI.getAll.mockResolvedValue(listResponse([ACCOUNT]));
  exchangesAPI.getRecords.mockResolvedValue({ data: FLAGGED, pagination: { total: FLAGGED.length } });
  exchangesAPI.resolveRecord.mockResolvedValue({ record: { id: 11, needs_review: false } });
  // Existing receipt tests exercise the compatibility path; the dedicated
  // background test below swaps this implementation for a job receipt.
  exchangesAPI.startSync.mockImplementation((id) => exchangesAPI.sync(id));
  exchangesAPI.getSyncStatus.mockResolvedValue({ job: null });
});

describe('Crypto -> Exchanges tab', () => {
  it('lists each account with its record count and last import', async () => {
    await renderSettings();

    const card = (await screen.findByText('Kraken Spot')).closest('.card');
    expect(within(card).getByText('1,080 records')).toBeInTheDocument();
    // Flagged rows are surfaced, not buried: they are the only ones a person
    // has to look at.
    expect(within(card).getByText('2 need review')).toBeInTheDocument();
    expect(within(card).getByText('Kraken')).toBeInTheDocument();
  });

  it('says an account has never been imported rather than showing nothing', async () => {
    exchangesAPI.getAll.mockResolvedValue(
      listResponse([{ ...ACCOUNT, last_import_at: null, record_count: 0, needs_review_count: 0 }])
    );
    await renderSettings();

    expect(await screen.findByText('Never imported')).toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeInTheDocument();
  });

  it('offers an empty state when no exchange account exists yet', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([]));
    await renderSettings();

    expect(await screen.findByText('No Exchange Accounts')).toBeInTheDocument();
  });

  it('says the list failed to load rather than claiming there are no accounts', async () => {
    exchangesAPI.getAll.mockRejectedValue(new Error('network'));
    await renderSettings();

    // "No Exchange Accounts" after a failed request invites adding a duplicate
    // of an account that already exists, and hides everything imported into it.
    expect(await screen.findByText(/Couldn't load your exchange accounts/)).toBeInTheDocument();
    expect(screen.queryByText('No Exchange Accounts')).not.toBeInTheDocument();

    exchangesAPI.getAll.mockResolvedValue(listResponse([ACCOUNT]));
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(await screen.findByText('Kraken Spot')).toBeInTheDocument();
  });

  it('renames an account through the PATCH vertical', async () => {
    exchangesAPI.update.mockResolvedValue({ account: { ...ACCOUNT, name: 'Kraken Main' } });
    await renderSettings();
    await screen.findByText('Kraken Spot');

    fireEvent.click(screen.getByTitle('Rename exchange account'));
    const input = screen.getByLabelText('New name for Kraken Spot');
    fireEvent.change(input, { target: { value: 'Kraken Main' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => {
      expect(exchangesAPI.update).toHaveBeenCalledWith(3, { name: 'Kraken Main' });
    });
  });

  it('adds an account with the chosen venue', async () => {
    exchangesAPI.create.mockResolvedValue({ account: { id: 9 } });
    await renderSettings();

    fireEvent.change(await screen.findByLabelText('Account name'), { target: { value: '  Coinbase Retail  ' } });
    fireEvent.change(screen.getByLabelText('Exchange'), { target: { value: 'coinbase' } });
    fireEvent.click(screen.getByRole('button', { name: /Add Account/i }));

    await waitFor(() => expect(exchangesAPI.create).toHaveBeenCalledWith('Coinbase Retail', 'coinbase'));
    // A successful add re-reads the list so the new account appears.
    await waitFor(() => expect(exchangesAPI.getAll).toHaveBeenCalledTimes(2));
  });

  it('refuses to create a nameless account without calling the API', async () => {
    await renderSettings();

    fireEvent.click(await screen.findByRole('button', { name: /Add Account/i }));

    expect(await screen.findByText(/Enter a name for this exchange account/)).toBeInTheDocument();
    expect(exchangesAPI.create).not.toHaveBeenCalled();
  });

  it('uploads a CSV and reports what landed', async () => {
    exchangesAPI.importCsv.mockResolvedValue({
      format: 'kraken',
      parsed: 10,
      imported: 7,
      duplicates: 3,
      needs_review: 1,
      skipped_header_rows: 0,
      skipped_noise_rows: 0,
    });
    await renderSettings();

    const csv = 'txid,refid,time,type\n';
    const file = new File([csv], 'kraken-ledgers.csv', { type: 'text/csv' });
    // jsdom's File does not always implement Blob.text().
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });

    const input = await screen.findByLabelText('Import CSV for Kraken Spot');
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(exchangesAPI.importCsv).toHaveBeenCalledWith(3, csv));
    expect(await screen.findByText(/7 new/)).toBeInTheDocument();
    expect(screen.getByText(/3 already imported/)).toBeInTheDocument();
    expect(screen.getByText(/1 flagged for review/)).toBeInTheDocument();
    expect(screen.getByText(/Kraken ledgers export/)).toBeInTheDocument();
  });

  it('reports records an earlier partial export could only half describe', async () => {
    exchangesAPI.importCsv.mockResolvedValue({
      format: 'kraken',
      parsed: 11,
      imported: 0,
      upgraded: 2,
      duplicates: 9,
      needs_review: 0,
      skipped_header_rows: 0,
      skipped_noise_rows: 0,
    });
    await renderSettings();

    const csv = 'txid,refid,time,type\n';
    const file = new File([csv], 'kraken-full.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve(csv) });
    fireEvent.change(await screen.findByLabelText('Import CSV for Kraken Spot'), { target: { files: [file] } });

    // Nothing new arrived and nothing was a plain duplicate: without this line
    // a re-upload that repaired two trades reads as having done nothing.
    expect(await screen.findByText(/2 completed from an earlier partial export/)).toBeInTheDocument();
  });

  it('lists the flagged records and lets one be marked reviewed', async () => {
    await renderSettings();

    const card = (await screen.findByText('Kraken Spot')).closest('.card');
    fireEvent.click(within(card).getByRole('button', { name: /Needs review \(2\)/ }));

    await waitFor(() => expect(exchangesAPI.getRecords)
      .toHaveBeenCalledWith(3, { needs_review: true, limit: 100 }));

    // Each row has to say why it is here; a queue of unexplained rows is one
    // nobody works through.
    expect(await screen.findByText(/only one side of this trade is in the file/)).toBeInTheDocument();
    expect(screen.getByText(/unrecognized row type "quantumsettlement"/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Mark record 11 reviewed'));

    await waitFor(() => expect(exchangesAPI.resolveRecord).toHaveBeenCalledWith(3, 11));
    // Resolved rows leave the queue, which is the only way it reaches zero.
    await waitFor(() => expect(screen.queryByLabelText('Mark record 11 reviewed')).not.toBeInTheDocument());
    expect(screen.getByLabelText('Mark record 12 reviewed')).toBeInTheDocument();
  });

  it('does not offer a review queue for an account with nothing flagged', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([{ ...ACCOUNT, needs_review_count: 0 }]));
    await renderSettings();

    await screen.findByText('Kraken Spot');
    expect(screen.queryByRole('button', { name: /Needs review/ })).not.toBeInTheDocument();
    expect(exchangesAPI.getRecords).not.toHaveBeenCalled();
  });

  it('shows the server\'s reason when a file cannot be read', async () => {
    exchangesAPI.importCsv.mockRejectedValue({
      response: { data: { error: 'Unrecognized CSV layout: no occurred_at column found.' } },
    });
    await renderSettings();

    const file = new File(['nope'], 'budget.csv', { type: 'text/csv' });
    Object.defineProperty(file, 'text', { value: () => Promise.resolve('nope') });
    fireEvent.change(await screen.findByLabelText('Import CSV for Kraken Spot'), { target: { files: [file] } });

    // The message is the only thing that tells the user which export to try
    // instead, so it has to survive to the screen verbatim.
    expect(await screen.findByText(/Unrecognized CSV layout/)).toBeInTheDocument();
  });

  it('tells the user to create a read-only key, naming the exact permissions', async () => {
    await renderSettings();
    await screen.findByText('Kraken Spot');

    fireEvent.click(screen.getByLabelText('Connect Kraken Spot with an API key'));

    // The permission list is the difference between a key that can read the
    // ledger and a key that can move money.
    expect(await screen.findByText(/Query Funds, Query Ledger Entries, Query Closed Orders & Trades/))
      .toBeInTheDocument();
    expect(screen.getByText(/Do not grant Withdraw Funds/)).toBeInTheDocument();
    expect(screen.getByText(/cannot place an order or move funds/)).toBeInTheDocument();
  });

  it('saves a key and never shows more than its last four characters', async () => {
    exchangesAPI.setCredentials.mockResolvedValue({
      credentials: { configured: true, key_masked: '••••WXYZ' },
    });
    await renderSettings();
    await screen.findByText('Kraken Spot');
    fireEvent.click(screen.getByLabelText('Connect Kraken Spot with an API key'));

    fireEvent.change(await screen.findByLabelText('API key for Kraken Spot'), {
      target: { value: '  KRAKEN-PUBLIC-KEY-WXYZ  ' },
    });
    fireEvent.change(screen.getByLabelText('Private key for Kraken Spot'), {
      target: { value: 'c2VjcmV0LXByaXZhdGUta2V5LTEyMzQ=' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save Key/i }));

    await waitFor(() => expect(exchangesAPI.setCredentials)
      .toHaveBeenCalledWith(3, 'KRAKEN-PUBLIC-KEY-WXYZ', 'c2VjcmV0LXByaXZhdGUta2V5LTEyMzQ='));
    // The form closes and the plaintext key leaves component state; a stored
    // key never comes back from the server, so there is nothing to re-show.
    await waitFor(() => expect(screen.queryByLabelText('API key for Kraken Spot')).not.toBeInTheDocument());
  });

  it('says up front when the server cannot store keys, instead of failing on save', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([ACCOUNT], { encryption_configured: false }));
    await renderSettings();
    await screen.findByText('Kraken Spot');
    fireEvent.click(screen.getByLabelText('Connect Kraken Spot with an API key'));

    expect(await screen.findByText(/missing SECRETS_ENCRYPTION_KEY/)).toBeInTheDocument();
    // Learning this from a failed request after pasting a secret is worse than
    // being told before.
    expect(screen.getByRole('button', { name: /Save Key/i })).toBeDisabled();
  });

  it('shows the masked key and offers Sync Now once connected', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.sync.mockResolvedValue({
      fetched: 13, imported: 11, upgraded: 0, duplicates: 0,
      chain_details_filled: 2, needs_review: 2, backfill_pending: false, status: 'ok',
      balance_report: { mismatch_count: 0, mismatches: [] },
    });
    await renderSettings();

    expect(await screen.findByText('Key ••••WXYZ')).toBeInTheDocument();
    // A connected account is not offered a second Connect button.
    expect(screen.queryByLabelText('Connect Kraken Spot with an API key')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Sync Kraken Spot now'));

    await waitFor(() => expect(exchangesAPI.sync).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/11 new/)).toBeInTheDocument();
    expect(screen.getByText(/2 gained an on-chain address/)).toBeInTheDocument();
    expect(screen.getByText(/2 flagged for review/)).toBeInTheDocument();
  });

  it('says a backfill is unfinished rather than letting it read as the whole history', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.sync.mockResolvedValue({
      fetched: 1250, imported: 1250, upgraded: 0, duplicates: 0,
      chain_details_filled: 0, needs_review: 0, backfill_pending: true, status: 'ok',
      balance_report: { mismatch_count: 0, mismatches: [] },
    });
    await renderSettings();
    fireEvent.click(await screen.findByLabelText('Sync Kraken Spot now'));

    // A truncated walk looks exactly like a complete one from the outside.
    expect(await screen.findByText(/More history is still to come/)).toBeInTheDocument();
  });

  it('queues a durable backfill and tells the user it is still running', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.startSync.mockResolvedValue({
      account_id: 3,
      job: {
        id: 44,
        account_id: 3,
        status: 'queued',
        batches: 0,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        flagged: 0,
      },
    });
    // The initial status read is empty; the start response itself is the first
    // visible receipt. A real running snapshot will arrive through polling.
    exchangesAPI.getSyncStatus.mockResolvedValue({ job: null });
    await renderSettings();
    fireEvent.click(await screen.findByLabelText('Sync Kraken Spot now'));

    await waitFor(() => expect(exchangesAPI.startSync).toHaveBeenCalledWith(3));
    expect(await screen.findByText(/Sync in progress/)).toBeInTheDocument();
    expect(screen.getByText(/continues automatically in the background/)).toBeInTheDocument();
  });

  it('replaces the queue receipt with the durable completed snapshot', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.startSync.mockResolvedValue({
      account_id: 3,
      job: {
        id: 45,
        account_id: 3,
        status: 'queued',
        requested_at: '2026-07-31T12:01:00.000Z',
        batches: 0,
        fetched: 0,
        imported: 0,
        duplicates: 0,
        flagged: 0,
      },
    });
    // Let the initial restore poll finish before the click, then make the
    // status read for this run return the worker's terminal receipt.
    exchangesAPI.getSyncStatus.mockResolvedValue({ job: null });
    await renderSettings();
    await waitFor(() => expect(exchangesAPI.getSyncStatus).toHaveBeenCalledWith(3));
    exchangesAPI.getSyncStatus.mockResolvedValue({
      job: {
        id: 45,
        account_id: 3,
        status: 'completed',
        requested_at: '2026-07-31T12:01:00.000Z',
        completed_at: '2026-07-31T12:01:02.000Z',
        batches: 1,
        fetched: 17,
        imported: 12,
        duplicates: 5,
        flagged: 1,
        last_batch: { coverage_limitations: [] },
      },
    });
    fireEvent.click(await screen.findByLabelText('Sync Kraken Spot now'));

    expect(await screen.findByText(/Sync complete — read 17 ledger rows/)).toBeInTheDocument();
    expect(screen.queryByText(/Sync in progress/)).not.toBeInTheDocument();
  });

  it('surfaces a balance mismatch instead of silently trusting the import', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.sync.mockResolvedValue({
      fetched: 13, imported: 0, upgraded: 0, duplicates: 13,
      chain_details_filled: 0, needs_review: 0, backfill_pending: false,
      status: 'balance_mismatch',
      balance_report: { mismatch_count: 1, mismatches: [{ asset: 'BTC', derived: '0', live: '0.5' }] },
    });
    await renderSettings();
    fireEvent.click(await screen.findByLabelText('Sync Kraken Spot now'));

    expect(await screen.findByText(/do not match the balance the exchange reports/)).toBeInTheDocument();
    expect(screen.getByText(/BTC/)).toBeInTheDocument();
  });

  it('shows a mismatch found by the nightly job without anything being pressed', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([{
      ...CONNECTED,
      last_sync_status: 'balance_mismatch',
      balance_report: { mismatch_count: 1, mismatches: [{ asset: 'ETH', derived: '1', live: '2' }] },
    }]));
    await renderSettings();

    expect(await screen.findByText(/derived balances disagree with the exchange for ETH/)).toBeInTheDocument();
  });

  it('passes the provider\'s own refusal through when a key is rejected', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.testConnection.mockRejectedValue({
      response: { data: { error: 'Kraken error: EGeneral:Permission denied' } },
    });
    await renderSettings();

    fireEvent.click(await screen.findByLabelText('Test connection for Kraken Spot'));

    // "Connection failed" would not tell the user which permission they forgot.
    expect(await screen.findByText(/EGeneral:Permission denied/)).toBeInTheDocument();
  });

  it('confirms a disconnect by naming what survives it', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([CONNECTED]));
    exchangesAPI.clearCredentials.mockResolvedValue({});
    await renderSettings();

    fireEvent.click(await screen.findByTitle('Disconnect API key'));
    expect(exchangesAPI.clearCredentials).not.toHaveBeenCalled();

    // The records are exactly the part no live connection can recover.
    fireEvent.click(screen.getByRole('button', { name: /Remove key, keep records/i }));
    await waitFor(() => expect(exchangesAPI.clearCredentials).toHaveBeenCalledWith(3));
  });

  it('does not offer an API connection for a venue with no connector', async () => {
    exchangesAPI.getAll.mockResolvedValue(listResponse([{ ...ACCOUNT, exchange: 'other' }]));
    await renderSettings();
    await screen.findByText('Kraken Spot');

    // There is no endpoint to call, so promising a sync would be a lie.
    expect(screen.queryByLabelText('Connect Kraken Spot with an API key')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Import CSV for Kraken Spot')).toBeInTheDocument();
  });

  it('asks before deleting an account and its records', async () => {
    exchangesAPI.remove.mockResolvedValue({});
    await renderSettings();

    fireEvent.click(await screen.findByTitle('Delete exchange account'));
    expect(exchangesAPI.remove).not.toHaveBeenCalled();

    // The confirm names the cost of the click.
    fireEvent.click(screen.getByRole('button', { name: /Delete 1,080 records/ }));
    await waitFor(() => expect(exchangesAPI.remove).toHaveBeenCalledWith(3));
  });
});
