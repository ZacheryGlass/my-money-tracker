import React, { useState } from 'react';
import { motion as Motion, AnimatePresence } from 'framer-motion';
import { AlertTriangle, Clock, Plus, RefreshCw, Unlink, Wallet } from 'lucide-react';
import { eth as ethAPI } from '../../utils/api';
import { formatExactUnits, formatRelativeTime, shortEthAddress as shortEthAddressOrUnknown } from '../../utils/format';
import { getAccountDisplayName } from '../../utils/accountDisplay';
import { explorerAddressUrl } from '../../utils/chains';

const ETH_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// Addresses render inside fallback chains and sentences composed here, so a
// missing value must contribute nothing rather than 'unknown'.
const shortEthAddress = (address) => shortEthAddressOrUnknown(address, '');

const RECONCILIATION_SKIP_TEXT = {
  feed_gap: 'a data feed this chain could not serve',
  chain_unavailable: 'this chain is not readable with your Etherscan key',
  chain_error: 'this chain failed to sync',
  never_synced: 'this chain has not synced yet',
  lookup_budget: 'checked on a later sync',
  // Distinct from lookup_budget: without a key no later sync can check it.
  no_api_key: 'no Etherscan key is configured',
  live_fetch_failed: 'the balance lookup failed',
};

// The balance audit for one wallet: does the stored transfer ledger reproduce
// the balance the chain itself reports?
//
// Silence is the failure mode this exists to break, so the three outcomes look
// deliberately different: a clean audit says so in one muted line, an ETH delta
// is a loud alert (sync starts at block 0, so it can only mean a movement was
// never recorded), and a token delta is stated plainly with the offending
// contract named -- rebasing and fee-on-transfer tokens do this legitimately, so
// alarming about them would train the user to ignore the ETH case too.
export function WalletReconciliation({ report, chainNames }) {
  if (!report) return null;
  const chainName = (chainId) => chainNames?.get(Number(chainId)) || `Chain ${chainId}`;
  const nativeDrift = report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'native');
  const tokenDrift = report.issues.filter((row) => row.status === 'mismatch' && row.asset_type === 'token');
  const unchecked = report.issues.filter((row) => row.status === 'skipped' || row.status === 'unavailable');
  const clean = !nativeDrift.length && !tokenDrift.length;

  // Every digit, never six. A drift under 1e-6 rendered at the default
  // precision prints as '0' (or '-0'), so the row would claim the ledger is
  // "0 ETH off" and then print the derived and chain figures identically --
  // three numbers that all say nothing is wrong, on a row that exists only
  // because something is.
  const amount = (row) => formatExactUnits(row.delta_units, row.token_decimals ?? 18) ?? '?';
  const symbolOf = (row) => row.token_symbol || 'tokens';

  return (
    <div className="mt-5 space-y-3">
      {nativeDrift.length > 0 && (
        <div className="rounded border border-loss/20 bg-loss/5 p-4 text-xs leading-relaxed text-loss">
          <div className="flex items-start gap-3">
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="font-bold uppercase tracking-wide">Balance audit: ETH unaccounted for</p>
              <p className="mt-1">
                Transfer history is synced from the first block, so the ETH it adds up to should match the
                chain exactly. It does not, which means a movement is missing from the ledger.
              </p>
              <ul className="mt-2 space-y-1 font-mono text-[11px]">
                {nativeDrift.map((row) => (
                  <li key={`${row.chain_id}-${row.asset_key}`}>
                    {chainName(row.chain_id)}: ledger is {amount(row)} ETH off
                    {' '}(derived {formatExactUnits(row.derived_units, 18)}, chain {formatExactUnits(row.live_units, 18)})
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {tokenDrift.length > 0 && (
        <div className="rounded border border-border bg-surface-3 p-4 text-xs leading-relaxed text-secondary">
          <p className="font-bold uppercase tracking-wide text-primary">Token balances that do not add up</p>
          <p className="mt-1">
            Rebasing and fee-on-transfer tokens change a balance without a transfer to record, so this is
            often harmless. If one of these is spam, ignore it on the Labels tab and it drops out of the audit.
          </p>
          <ul className="mt-2 space-y-1">
            {tokenDrift.map((row) => (
              <li key={`${row.chain_id}-${row.asset_key}`} className="font-mono text-[11px]">
                <span className="text-primary">{symbolOf(row)}</span>{' '}
                {/* The contract, not just a number: "your DAI is off by 3" is
                    unactionable when four contracts call themselves DAI. */}
                <span title={row.asset_key}>{shortEthAddress(row.asset_key)}</span>{' '}
                on {chainName(row.chain_id)} is {amount(row)} off
              </li>
            ))}
          </ul>
        </div>
      )}

      {clean && report.assets_checked > 0 && (
        <p className="text-[10px] font-bold uppercase tracking-wide text-tertiary">
          Balance audit: ledger matches the chain across {report.matched + report.dust} of{' '}
          {report.assets_checked} assets &middot; {formatRelativeTime(report.checked_at)}
        </p>
      )}

      {unchecked.length > 0 && (
        // Stated rather than hidden. An audit that quietly omits what it could
        // not check reads as "everything is fine", which is the one thing it
        // must never say by accident.
        <p className="text-[10px] text-tertiary">
          Not checked this run:{' '}
          {unchecked.slice(0, 4).map((row) => (
            `${row.asset_type === 'native' ? 'ETH' : symbolOf(row)} on ${chainName(row.chain_id)} (${RECONCILIATION_SKIP_TEXT[row.skip_reason] || 'not compared'})`
          )).join('; ')}
          {unchecked.length > 4 ? ` and ${unchecked.length - 4} more` : ''}
          {report.truncated ? '. More assets are listed in the audit API.' : ''}
        </p>
      )}
    </div>
  );
}

// The tracked-wallet list and everything that changes it: add, sync, disconnect.
// Moved off Settings with #75 -- a wallet is crypto data, not an app preference,
// and the add form was three clicks from the feed it fills.
function WalletsPanel({ wallets, onChanged, onError, showSuccess }) {
  const [addOpen, setAddOpen] = useState(false);
  const [walletAddress, setWalletAddress] = useState('');
  const [walletLabel, setWalletLabel] = useState('');
  const [formError, setFormError] = useState(null);
  const [bulkResults, setBulkResults] = useState(null);
  const [adding, setAdding] = useState(false);
  const [syncingId, setSyncingId] = useState(null);
  const [disconnecting, setDisconnecting] = useState(null);
  const [removeData, setRemoveData] = useState(true);

  // Same split the submit handler uses, so the count in the label and the
  // number of wallets actually created can never disagree.
  const addressCount = walletAddress.split(/[\s,;]+/).filter(Boolean).length;

  const openAddModal = () => {
    setWalletAddress('');
    setWalletLabel('');
    setFormError(null);
    setBulkResults(null);
    setAddOpen(true);
  };

  const handleAdd = async (event) => {
    event.preventDefault();
    if (adding) return;
    // One address per line is the documented format, but a pasted list often
    // arrives comma- or space-separated; an address contains neither, so
    // splitting on any of them cannot merge or truncate one.
    const entries = walletAddress.split(/[\s,;]+/).map((line) => line.trim()).filter(Boolean);
    if (entries.length === 0) {
      setFormError('Enter at least one Ethereum address');
      return;
    }
    const invalid = entries.filter((entry) => !ETH_ADDRESS_RE.test(entry));
    if (invalid.length) {
      setFormError(entries.length === 1
        ? 'Enter a valid Ethereum address (0x followed by 40 hex characters)'
        : `Not a valid Ethereum address: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? ` (+${invalid.length - 3} more)` : ''}`);
      return;
    }
    setAdding(true);
    setFormError(null);
    setBulkResults(null);
    try {
      if (entries.length === 1) {
        await ethAPI.addWallet(entries[0], walletLabel.trim() || undefined);
        // The first sync runs in the background; its result surfaces on the
        // wallet card (balance, last-synced, or an error badge).
        showSuccess('Wallet added. Syncing on-chain history in the background.');
        setAddOpen(false);
        setWalletAddress('');
        setWalletLabel('');
      } else {
        const { summary, results } = await ethAPI.addWallets(entries);
        if (summary.added) {
          showSuccess(`${summary.added} wallet${summary.added === 1 ? '' : 's'} added. Syncing on-chain history in the background.`);
        }
        if (summary.duplicate || summary.failed) {
          // Keep the modal open on a partial result: the per-address verdicts
          // are the only place the skipped lines are named.
          setBulkResults(results.filter((r) => r.status !== 'added'));
        } else {
          setAddOpen(false);
          setWalletAddress('');
          setWalletLabel('');
        }
      }
      await onChanged();
    } catch (err) {
      setFormError(err.response?.data?.error || 'Failed to add wallet');
      // A retried POST can land on DUPLICATE_WALLET after the first attempt
      // actually succeeded; refresh so the list reflects the existing wallet.
      if (err.response?.status === 409) await onChanged();
    } finally {
      setAdding(false);
    }
  };

  const handleSync = async (id) => {
    setSyncingId(id);
    onError(null);
    try {
      await ethAPI.syncWallet(id);
      showSuccess('Wallet synced successfully');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to sync wallet');
    } finally {
      setSyncingId(null);
    }
  };

  const handleDisconnectConfirm = async () => {
    const id = disconnecting.id;
    const purge = removeData;
    setDisconnecting(null);
    try {
      await ethAPI.removeWallet(id, { removeData: purge });
      showSuccess(purge
        ? 'Wallet disconnected and data removed.'
        : 'Wallet disconnected. The account and its holdings were kept.');
      await onChanged();
    } catch (err) {
      onError(err.response?.data?.error || 'Failed to disconnect wallet');
    }
  };

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-end justify-between gap-3 px-2">
        <div>
          <h2 className="text-lg font-bold uppercase tracking-tight text-primary">Ethereum Wallets</h2>
          <p className="mt-1 text-xs text-secondary">Track any Ethereum address via Etherscan: ETH and token balances, transfers between your own wallets, external transfers, and gas fees.</p>
        </div>
        {wallets.length > 0 && (
          <button
            onClick={openAddModal}
            className="inline-flex items-center justify-center gap-2 rounded border border-crypto-border bg-crypto-bg px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-crypto transition-all hover:bg-crypto-bg-hover hover:text-crypto-hover"
          >
            <Plus size={14} />
            Add Wallet
          </button>
        )}
      </div>

      {wallets.length === 0 ? (
        <div className="card p-12 text-center border-dashed border-2 border-border bg-transparent">
          <Wallet size={40} className="mx-auto text-tertiary mb-4 opacity-20" />
          <h3 className="text-lg font-bold text-primary mb-2 uppercase tracking-tight">No Wallets Tracked</h3>
          <p className="text-sm text-secondary max-w-md mx-auto leading-relaxed mb-5">
            Add an Ethereum address to pull its balance and full transfer history. Transfers between your
            own tracked wallets are recognized automatically.
          </p>
          <button
            onClick={openAddModal}
            className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-crypto bg-crypto-bg border border-crypto-border hover:bg-crypto-bg-hover hover:text-crypto-hover transition-all"
          >
            <Wallet size={14} />
            Connect Crypto
          </button>
        </div>
      ) : (
        <div className="space-y-4">
          {wallets.map((wallet) => (
            <Motion.div layout key={wallet.id} className="card overflow-hidden border-border">
              <div className="p-5 md:p-6">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                  <div className="flex items-center gap-4 min-w-0">
                    <div className="w-12 h-12 rounded bg-surface-3 border border-border flex items-center justify-center flex-shrink-0 shadow-sm">
                      <Wallet size={24} className="text-accent" />
                    </div>
                    <div className="min-w-0">
                      <h3 className="text-base font-bold text-primary truncate leading-tight">
                        {wallet.label || (wallet.account ? getAccountDisplayName(wallet.account) : shortEthAddress(wallet.address))}
                      </h3>
                      <div className="flex flex-wrap items-center gap-4 mt-1">
                        <span className="font-mono text-[10px] text-tertiary" title={wallet.address}>
                          {shortEthAddress(wallet.address)}
                        </span>
                        {wallet.eth_quantity != null && (
                          <span className="font-mono text-[10px] font-bold text-secondary">
                            {parseFloat(wallet.eth_quantity).toLocaleString(undefined, { maximumFractionDigits: 4 })} ETH
                          </span>
                        )}
                        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wide text-tertiary">
                          <Clock size={12} />
                          {formatRelativeTime(wallet.last_synced_at)}
                        </span>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {/* One address, several chains: the wallet has no single
                        chain to link against, and an address page exists on
                        every explorer anyway. */}
                    <a
                      href={explorerAddressUrl(wallet.address)}
                      target="_blank"
                      rel="noreferrer"
                      className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all"
                    >
                      Etherscan
                    </a>
                    <button
                      onClick={() => handleSync(wallet.id)}
                      disabled={syncingId === wallet.id}
                      className="flex items-center justify-center gap-2 px-4 py-2.5 rounded text-xs font-bold uppercase tracking-wider text-secondary bg-surface-3 border border-border hover:border-accent hover:text-accent transition-all disabled:opacity-50"
                    >
                      <RefreshCw size={14} className={syncingId === wallet.id ? 'animate-spin' : ''} />
                      Sync
                    </button>
                    <button
                      onClick={() => { setRemoveData(true); setDisconnecting(wallet); }}
                      className="p-2.5 rounded text-tertiary hover:text-loss hover:bg-loss/10 border border-transparent transition-all"
                      title="Disconnect Wallet"
                    >
                      <Unlink size={18} />
                    </button>
                  </div>
                </div>

                {/* Per-chain sync state. The wallet badge above deliberately
                    carries only transient failures, so a chain (or a feed on
                    one) that this Etherscan key simply cannot serve would be
                    invisible without this -- and an unfetched feed means the
                    figures derived from it are incomplete, not just stale.

                    Shown for a multi-chain wallet, and ALWAYS when any chain
                    row carries a gap: a mainnet-only wallet (ETH_CHAINS=1)
                    whose one chain is degraded still has to say so, and
                    gating purely on chain count hid exactly that case. */}
                {(wallet.chains?.length > 1
                  || wallet.chains?.some((chain) => chain.error_code || chain.unsupported_feeds?.length > 0)) && (
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    {wallet.chains.map((chain) => (
                      <span
                        key={chain.chain_id}
                        title={chain.error_message
                          || (chain.enabled ? `Last synced ${formatRelativeTime(chain.last_synced_at)}` : 'Chain turned off; stored history kept')}
                        className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-[10px] font-bold uppercase tracking-wide ${
                          !chain.enabled ? 'bg-surface-3 border-border text-tertiary'
                            : chain.error_code ? 'bg-loss/5 border-loss/20 text-loss'
                            : 'bg-surface-3 border-border text-secondary'
                        }`}
                      >
                        {chain.enabled && chain.error_code && <AlertTriangle size={10} />}
                        {chain.name}
                        {!chain.enabled && <span className="font-normal normal-case">off</span>}
                        {chain.unsupported_feeds?.length > 0 && (
                          <span className="font-normal normal-case">
                            no {chain.unsupported_feeds.join(', ')}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                )}

                {wallet.error_code && (
                  <div className="mt-5 p-4 rounded border text-xs leading-relaxed bg-loss/5 border-loss/20 text-loss">
                    <div className="flex items-start gap-3">
                      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                      <p>{wallet.error_message || `Wallet sync reported an error: ${wallet.error_code}`}</p>
                    </div>
                  </div>
                )}

                {/* The audit rides along on the wallets response, so this
                    needs no second request and cannot disagree with the badge
                    above it. Chain names come from the wallet's own chain
                    rows, which the server already labelled from the registry. */}
                <WalletReconciliation
                  report={wallet.reconciliation}
                  chainNames={new Map((wallet.chains || []).map((chain) => [Number(chain.chain_id), chain.name]))}
                />
              </div>
            </Motion.div>
          ))}
        </div>
      )}

      {/* Connect Crypto Modal */}
      <AnimatePresence>
        {addOpen && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setAddOpen(false)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} role="dialog" aria-modal="true" aria-labelledby="crypto-modal-title" className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <form onSubmit={handleAdd}>
                <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                  <div className="w-16 h-16 bg-crypto-bg text-crypto rounded-full flex items-center justify-center mx-auto mb-6">
                    <Wallet size={28} />
                  </div>
                  <h2 id="crypto-modal-title" className="text-2xl font-bold text-primary mb-2 tracking-tight">Connect Crypto Wallet</h2>
                  <p className="text-sm text-secondary leading-relaxed">
                    Paste an Ethereum address to track its balance and full transfer history via Etherscan. Paste several, one per line, to add them all at once.
                  </p>
                </div>

                <div className="space-y-4 p-5 sm:p-8 sm:pt-2">
                  {/* A 42-character address on one line is what makes a pasted
                      list scannable, so the type steps down from the form
                      default and wrapping is off outright: at a larger text
                      scale it would wrap again, and half an address on the
                      next line reads as another entry. */}
                  <label className="block text-caption text-tertiary">
                    {addressCount > 1 ? `Addresses (${addressCount})` : 'Address'}
                    <textarea
                      value={walletAddress}
                      onChange={(event) => setWalletAddress(event.target.value)}
                      placeholder="0x…&#10;0x… (one per line)"
                      spellCheck={false}
                      autoComplete="off"
                      autoFocus
                      rows={addressCount > 1 ? 6 : 3}
                      wrap="off"
                      className="mt-1 block w-full min-w-0 resize-y overflow-x-auto rounded border border-input-border bg-surface-2 px-3 py-2 font-mono text-caption text-primary outline-none focus:ring-1 focus:ring-accent"
                      disabled={adding}
                    />
                  </label>
                  {/* A label names ONE wallet, so it is disabled for a pasted
                      batch rather than applied to every address in it. */}
                  <label className="block text-caption text-tertiary">
                    Label (optional)
                    <input
                      type="text"
                      value={walletLabel}
                      onChange={(event) => setWalletLabel(event.target.value)}
                      maxLength={100}
                      placeholder={addressCount > 1 ? 'Not used when adding several addresses' : 'Cold storage'}
                      className="mt-1 block h-11 w-full min-w-0 rounded border border-input-border bg-surface-2 px-3 text-body-sm text-primary outline-none focus:ring-1 focus:ring-accent disabled:opacity-40"
                      disabled={adding || addressCount > 1}
                    />
                  </label>

                  {formError && (
                    <div role="alert" className="flex items-start gap-2 rounded border border-loss/20 bg-loss/5 p-3 text-caption text-loss">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{formError}</span>
                    </div>
                  )}

                  {bulkResults?.length > 0 && (
                    <div role="alert" className="space-y-1 rounded border border-border bg-surface-2 p-3 text-caption text-tertiary">
                      <p className="text-secondary">These addresses were not added:</p>
                      {bulkResults.map((result) => (
                        <p key={result.address} className="flex flex-wrap items-baseline gap-2">
                          <span className="font-mono text-primary">{result.address}</span>
                          <span>{result.error}</span>
                        </p>
                      ))}
                    </div>
                  )}

                  <p className="text-caption text-tertiary">
                    The first sync runs in the background; a busy wallet can take a few minutes to appear complete. Use Sync on the wallet card to refresh.
                  </p>
                </div>

                <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                  <button
                    type="button"
                    onClick={() => setAddOpen(false)}
                    className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={adding}
                    className="flex-1 inline-flex items-center justify-center gap-2 py-4 bg-crypto-bg-hover text-crypto border border-crypto-border rounded text-xs font-bold uppercase tracking-wider hover:bg-crypto-bg-strong hover:text-crypto-hover transition-all disabled:opacity-40"
                  >
                    {adding ? <RefreshCw size={14} className="animate-spin" /> : <Plus size={14} />}
                    {addressCount > 1 ? `Track ${addressCount} Wallets` : 'Track Wallet'}
                  </button>
                </div>
              </form>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Wallet Disconnect Confirm Modal */}
      <AnimatePresence>
        {disconnecting && (
          <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
            <Motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 bg-black/70" onClick={() => setDisconnecting(null)} />
            <Motion.div initial={{ opacity: 0, scale: 0.9, y: 20 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.9, y: 20 }} className="relative max-h-[100dvh] w-full max-w-lg overflow-y-auto border border-border bg-surface shadow-2xl sm:max-h-[92vh] sm:rounded-3xl">
              <div className="p-5 pb-3 text-center sm:p-8 sm:pb-4">
                <div className="w-16 h-16 bg-loss/10 text-loss rounded-full flex items-center justify-center mx-auto mb-6">
                  <Unlink size={28} />
                </div>
                <h2 className="text-2xl font-bold text-primary mb-2 tracking-tight">Disconnect Wallet</h2>
                <p className="text-sm text-secondary leading-relaxed">
                  You are about to stop tracking <span className="font-mono text-primary font-bold">{shortEthAddress(disconnecting.address)}</span>. How should we handle existing data?
                </p>
              </div>

              <div className="space-y-3 p-5 sm:p-8">
                <button
                  onClick={() => setRemoveData(true)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${removeData ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${removeData ? 'border-accent' : 'border-tertiary'}`}>
                    {removeData && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Full Purge (Recommended)</p>
                    <p className="text-[11px] text-secondary mt-0.5">Delete the account, holdings, transfer history, and historical data for this wallet.</p>
                  </div>
                </button>

                <button
                  onClick={() => setRemoveData(false)}
                  className={`w-full flex items-start gap-4 p-4 rounded border text-left transition-all ${!removeData ? 'border-accent bg-accent/5 ring-1 ring-accent/20' : 'border-border hover:border-border-hover bg-surface-2'}`}
                >
                  <div className={`mt-1 w-4 h-4 rounded-full border-2 flex items-center justify-center ${!removeData ? 'border-accent' : 'border-tertiary'}`}>
                    {!removeData && <div className="w-2 h-2 rounded-full bg-accent" />}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-primary">Unlink &amp; Keep Data</p>
                    <p className="text-[11px] text-secondary mt-0.5">Stop syncing. The account and its current holdings become manual entries; on-chain transfer history is removed.</p>
                  </div>
                </button>
              </div>

              <div className="sticky bottom-0 flex gap-3 bg-surface p-5 pt-0 sm:static sm:p-8 sm:pt-0">
                <button
                  onClick={() => setDisconnecting(null)}
                  className="flex-1 py-4 bg-surface-3 text-secondary hover:text-primary rounded text-xs font-bold uppercase tracking-wider transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleDisconnectConfirm}
                  className="flex-1 py-4 bg-loss text-white rounded text-xs font-bold uppercase tracking-wider hover:opacity-90 transition-all"
                >
                  Confirm Disconnect
                </button>
              </div>
            </Motion.div>
          </div>
        )}
      </AnimatePresence>
    </section>
  );
}

export default WalletsPanel;
