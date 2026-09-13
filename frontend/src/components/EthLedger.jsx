import React, { useEffect, useMemo, useState } from 'react';
import { getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { crypto as cryptoAPI } from '../utils/api';
import { formatExactUnits } from '../utils/format';
import { explorerTxUrl } from '../utils/chains';
import DataTable from './DataTable';
import LoadingState from './LoadingState';

const PAGE_SIZE = 100;
const amount = (wei) => formatExactUnits(wei, 18) ?? 'Unknown';
const kindLabel = (row) => ({
  gas: 'Gas fee', internal: 'Internal ETH transfer',
  native: 'ETH transfer', exchange_fee: 'Exchange fee',
}[row.kind] || `Exchange ${row.kind}`);

export default function EthLedger({ walletId = null }) {
  const [scope, setScope] = useState('');
  const [offset, setOffset] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    cryptoAPI.getEthLedger({ walletId, ...(scope ? { scope } : {}), limit: PAGE_SIZE, offset })
      .then((data) => { if (!cancelled) setResult(data); })
      .catch(() => { if (!cancelled) setError('Could not load the ETH ledger.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [walletId, scope, offset, retry]);

  const columns = useMemo(() => [
    { accessorKey: 'sequence', header: '#', meta: { width: '5%' } },
    { accessorKey: 'occurred_at', header: 'Time (UTC)', cell: ({ getValue }) =>
      <span className="break-words">{getValue()?.replace('T', ' ').replace(/Z$/, '')}</span>,
    },
    { accessorKey: 'name', header: 'Account / network', cell: ({ row }) => <>
      <span>{row.original.name}</span>
      <span className="block text-tertiary">{row.original.chain_name || 'Exchange'}</span>
    </> },
    { id: 'entry', header: 'Entry', cell: ({ row }) => <>
      <span>{kindLabel(row.original)}</span>
      {row.original.failed && <span className="block text-tertiary">Failed transaction; gas still charged</span>}
      {row.original.needs_review && <span className="block text-accent">Source needs review</span>}
      {row.original.chain_id && <a className="block underline text-accent" target="_blank" rel="noreferrer"
        href={explorerTxUrl(row.original.reference, row.original.chain_id)}>Transaction</a>}
      <details className="text-caption text-tertiary">
        <summary className="cursor-pointer">Details</summary>
        <p className="break-all">{row.original.reference}</p>
        {row.original.description && <p className="break-all">{row.original.description}</p>}
        {row.original.from_address && <p className="break-all">From: {row.original.from_address}</p>}
        {row.original.to_address && <p className="break-all">To: {row.original.to_address}</p>}
      </details>
    </> },
    ...[
      ['delta_wei', 'Change (ETH)'], ['balance_wei', 'Running ETH'],
      ['account_balance_wei', 'Account ETH'],
    ].map(([key, header]) => ({ accessorKey: key, header,
      meta: { align: 'right', cellClassName: 'font-money text-right break-all' },
      cell: ({ getValue }) => amount(getValue()),
    })),
  ], []);
  const table = useReactTable({ data: loading || error ? [] : result?.data || [], columns,
    getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id, enableSorting: false });
  const selectedScopes = (result?.scopes || []).filter((s) => !scope || s.scope === scope);
  const total = result?.total || 0;

  return <div className="space-y-4">
    <div>
      <h2 className="text-heading-sm font-semibold text-primary">ETH ledger</h2>
      <p className="text-body-sm text-secondary">
        Every recorded native ETH movement and gas charge, plus exchange ETH trades, transfers and fees.
        Oldest first. Wrapped ETH and gas paid in POL, XDAI or other tokens are separate assets.
      </p>
      <p className="mt-2 text-body-sm text-secondary">
        Running ETH starts at zero and sums recorded entries in the selected accounts across all pages.
        It is a reconstructed balance, not a verified historical balance. Both sides of transfers between
        your accounts are shown; different booking times can temporarily change the combined total.
        Entries sharing a timestamp use a stable order, which may differ from transaction execution order.
      </p>
    </div>
    <label className="flex flex-wrap items-center gap-2 text-body-sm text-secondary">
      Ledger account
      <select value={scope} onChange={(event) => { setScope(event.target.value); setOffset(0); }}
        className="max-w-full rounded border border-border bg-surface px-2 py-1">
        <option value="">{walletId ? 'Selected wallet · all ETH networks' : 'All wallets and exchanges'}</option>
        {(result?.scopes || []).map((s) => <option key={s.scope} value={s.scope}>
          {s.name} · {s.chain_name || 'Exchange'}
        </option>)}
      </select>
    </label>
    {loading ? <LoadingState /> : error ? <div role="alert">
      {error} <button className="underline" onClick={() => setRetry((n) => n + 1)}>Retry</button>
    </div> : <>
      <p className="text-body-sm text-secondary">
        {total.toLocaleString()} entries · Closing recorded balance: <strong className="font-money">{amount(result?.closing_balance_wei)} ETH</strong>
        {result?.unknown_amounts > 0 && ` · ${result.unknown_amounts} unknown amounts prevent a complete balance.`}
      </p>
      <details className="border border-border p-3 text-body-sm text-secondary">
        <summary className="cursor-pointer">Coverage and balance limitations — {selectedScopes.length} accounts / networks</summary>
        <p className="my-2">Coverage and audit results below are the last stored checks, not proof of lifetime completeness.
          Missing feeds, missing exchange exports and unknown opening balances affect this ledger.
          Audit-only adjustments are listed here and are not invented as transactions.</p>
        <ul className="space-y-2">
          {selectedScopes.map((s) => <li key={s.scope}>
            <strong>{s.name} · {s.chain_name || 'Exchange'}</strong>
            {s.chain_id ? <>
              <p>Last native audit: {s.audit?.status || 'Not checked'}{s.audit?.checked_at ? ` (${s.audit.checked_at})` : ''}.
                {s.audit?.reason && ` ${s.audit.reason}`}
                {s.adjustment_wei !== '0' && ` Audit-only adjustment excluded: ${amount(s.adjustment_wei)} ETH.`}</p>
              {s.coverage.length ? s.coverage.map((f) => <p key={f.feed} className="text-caption">
                {f.feed}: {f.status} · blocks {f.from_block ?? '?'}–{f.through_block ?? '?'}{f.error ? ` · ${f.error}` : ''}
              </p>) : <p>History coverage has not been recorded.</p>}
            </> : <p>Imported records only. Check Crypto → Exchanges for export coverage and balance exceptions.</p>}
          </li>)}
        </ul>
      </details>
      <DataTable table={table} emptyMessage="No recorded ETH entries in this scope."
        renderMobileRow={({ original: row }) => <div key={row.id} className="space-y-1 p-3 text-body-sm">
          <p>#{row.sequence} · {row.occurred_at?.replace('T', ' ').replace(/Z$/, '')} UTC</p>
          <p>{row.name} · {row.chain_name || 'Exchange'} · {kindLabel(row)}</p>
          {row.failed && <p>Failed transaction; gas still charged</p>}
          {row.needs_review && <p>Source needs review</p>}
          <p className="font-money break-all">Change: {amount(row.delta_wei)} ETH</p>
          <p className="font-money break-all">Running: {amount(row.balance_wei)} ETH</p>
          <p className="font-money break-all">Account: {amount(row.account_balance_wei)} ETH</p>
          <details><summary className="cursor-pointer">Details</summary>
            <p className="break-all">{row.reference}</p>
            {row.description && <p className="break-all">{row.description}</p>}
            {row.from_address && <p className="break-all">From: {row.from_address}</p>}
            {row.to_address && <p className="break-all">To: {row.to_address}</p>}
            {row.chain_id && <a className="underline text-accent" target="_blank" rel="noreferrer"
              href={explorerTxUrl(row.reference, row.chain_id)}>Transaction</a>}
          </details>
        </div>} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-body-sm text-secondary">
        <span>{total ? `${offset + 1}–${Math.min(offset + PAGE_SIZE, total)} of ${total}` : '0 entries'}</span>
        <div className="flex gap-3">
          <button disabled={offset === 0} onClick={() => setOffset(0)} className="disabled:opacity-30">First</button>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} className="disabled:opacity-30">Previous</button>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(offset + PAGE_SIZE)} className="disabled:opacity-30">Next</button>
          <button disabled={offset + PAGE_SIZE >= total} onClick={() => setOffset(Math.floor((total - 1) / PAGE_SIZE) * PAGE_SIZE)} className="disabled:opacity-30">Last</button>
        </div>
      </div>
    </>}
  </div>;
}
