import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Settings from './Settings';
import { exchanges as exchangesAPI } from '../utils/api';

// Plaid Link injects a remote script; the Settings page only needs it to exist.
vi.mock('react-plaid-link', () => ({
  usePlaidLink: () => ({ open: vi.fn(), ready: false }),
}));

vi.mock('../utils/api', () => ({
  plaid: { getItems: vi.fn().mockResolvedValue({ items: [] }) },
  accounts: { getAll: vi.fn().mockResolvedValue({ accounts: [] }) },
  holdings: { getAll: vi.fn() },
  history: { getPortfolio: vi.fn() },
  exportData: { downloadHoldings: vi.fn(), downloadHistory: vi.fn() },
  keys: { getAll: vi.fn().mockResolvedValue(null) },
  admin: { getOverview: vi.fn() },
  eth: {
    getWallets: vi.fn().mockResolvedValue({ wallets: [] }),
    getIgnoredTokens: vi.fn().mockResolvedValue({ tokens: [] }),
    getAddressLabels: vi.fn().mockResolvedValue({ labels: [] }),
    getUnreviewedCounterparties: vi.fn().mockResolvedValue({ data: [], summary: { count: 0 }, pagination: {} }),
  },
  exchanges: {
    getAll: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    importCsv: vi.fn(),
    getRecords: vi.fn(),
    resolveRecord: vi.fn(),
  },
}));

const ACCOUNT = {
  id: 3,
  name: 'Kraken Spot',
  exchange: 'kraken',
  record_count: 1080,
  needs_review_count: 2,
  last_import_at: new Date().toISOString(),
};

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

const renderSettings = async () => {
  render(
    <MemoryRouter>
      <Settings user={{ id: 1, username: 'tester' }} />
    </MemoryRouter>
  );
  // The tab strip only appears once the initial fetch settles.
  const tab = await screen.findByRole('tab', { name: /Exchanges/ });
  fireEvent.click(tab);
  return tab;
};

beforeEach(() => {
  vi.clearAllMocks();
  exchangesAPI.getAll.mockResolvedValue({ accounts: [ACCOUNT] });
  exchangesAPI.getRecords.mockResolvedValue({ data: FLAGGED, pagination: { total: FLAGGED.length } });
  exchangesAPI.resolveRecord.mockResolvedValue({ record: { id: 11, needs_review: false } });
});

describe('Settings -> Exchanges tab', () => {
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
    exchangesAPI.getAll.mockResolvedValue({
      accounts: [{ ...ACCOUNT, last_import_at: null, record_count: 0, needs_review_count: 0 }],
    });
    await renderSettings();

    expect(await screen.findByText('Never imported')).toBeInTheDocument();
    expect(screen.getByText('0 records')).toBeInTheDocument();
  });

  it('offers an empty state when no exchange account exists yet', async () => {
    exchangesAPI.getAll.mockResolvedValue({ accounts: [] });
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

    exchangesAPI.getAll.mockResolvedValue({ accounts: [ACCOUNT] });
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
    exchangesAPI.getAll.mockResolvedValue({ accounts: [{ ...ACCOUNT, needs_review_count: 0 }] });
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
