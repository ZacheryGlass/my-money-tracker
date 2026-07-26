'use strict';

const pool = require('../config/database');
const logger = require('../config/logger');
const EthWallet = require('../models/EthWallet');
const chains = require('../config/chains');
const { shortAddress } = require('../utils/ethAddress');

// transactions.amount is DECIMAL(15,2). The valuation pass already clamps to
// the same bound in SQL (AssetPriceHistory.USD_CLAMP), so this is the second
// line rather than the first -- it also catches a NULL or a stray string
// arriving from a hand-written row.
function toAmount(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const capped = Math.max(Math.min(number, 9999999999999.99), -9999999999999.99);
  return Math.round(capped * 100) / 100;
}

// Pure: one eth_transfers row -> a transactions row body, or null when the
// transfer should not appear in the ledger. Ledger sign convention is Plaid's:
// positive = money leaving the account.
//
// USD IS AT-THE-TIME (#73). Every amount below comes from usd_at_time, which
// the valuation pass wrote from the dated series in asset_price_history -- so a
// 2017 transfer carries 2017 dollars, and nothing here fetches a price. That
// also makes a rebuild deterministic: the same stored legs produce the same
// amounts every time, which is exactly what "re-running classification does not
// drift valuations" means.
//
// usd_at_time NULL means UNPRICED -- no close was reachable for that asset on
// that date. SUCH A LEG IS NOT MIRRORED AT ALL.
//
// The mirror's rows are money: `transactions.amount` is what Spending sums, and
// nothing downstream reads a basis column (there is none on `transactions`), so
// a mirrored row IS an assertion about dollars. Writing 0.00 for a leg the
// series could not price makes that assertion "$0", and Spending adds it as a
// real zero -- a 2019 500-USDC deposit outside a free key's 365-day token range
// would quietly remove $500 from the ledger, which is the same silent-zero
// failure #73 exists to delete, just one layer down. Substituting today's price
// would be the other half of that bug.
//
// So the leg is omitted, exactly as NFT legs and ignored tokens are omitted:
// the mirror only ever carried the legs it could state a dollar figure for. The
// activity is NOT lost -- eth_activity explains the transaction with
// usd_basis = 'unpriced', the on-chain feed shows the crypto amount with "No USD
// value", and GET /api/eth/prices/unpriced enumerates the assets responsible.
// Rebuild-safe by construction: the mirror is deleted and rewritten wholesale,
// so a leg that gets priced by a later backfill reappears on the next rebuild
// (the historical-price job re-derives every wallet nightly for that reason).
function buildMirrorRow(transfer, walletAddress, { ignoredContracts = new Set() } = {}) {
  const wallet = walletAddress.toLowerCase();
  const outgoing = transfer.from_address === wallet;
  // Own beats exchange (reclassify also encodes this, belt and suspenders):
  // a tracked wallet that happens to be labeled stays a self-transfer.
  const exchange = transfer.counterparty_is_own ? null : transfer.counterparty_exchange || null;
  const exchangeCategory = outgoing ? 'CRYPTO_EXCHANGE_DEPOSIT' : 'CRYPTO_EXCHANGE_WITHDRAWAL';
  const usd = transfer.usd_at_time == null ? null : Number(transfer.usd_at_time);

  if (transfer.transfer_type === 'gas') {
    // A fee is always a cost, whichever way the transaction went, and it is
    // real even when the transaction reverted. Same rule as a value leg,
    // though: an unpriced fee is an unknown cost, not a free transaction.
    if (usd == null) return null;
    return {
      category: 'CRYPTO_GAS_FEE',
      name: 'Gas fee',
      amount: toAmount(Math.abs(usd)),
    };
  }

  // Failed transfers moved no value; only their gas row (above) is real.
  if (transfer.is_error) return null;

  // NFTs stay out of the ledger. value_wei on these rows is a count of units,
  // not wei and not a scaled token amount, so the branches below would read a
  // 1-of-1 mint as 1e-18 ETH and post a bogus CRYPTO_EXTERNAL row for it. The
  // real economics of an NFT trade are already in the ETH leg and the gas row;
  // presenting the NFT itself is the activity layer's job (#56).
  if (transfer.transfer_type === 'nft' || transfer.transfer_type === 'nft1155') return null;

  // Unpriced: no row, rather than a row asserting $0.00. See the header.
  if (usd == null) return null;
  const amount = toAmount(outgoing ? Math.abs(usd) : -Math.abs(usd));

  if (transfer.transfer_type === 'token') {
    const contract = transfer.token_contract;
    if (!contract || ignoredContracts.has(contract)) return null;
    const symbol = transfer.token_symbol || 'TOKEN';
    return {
      category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER'
        : exchange ? exchangeCategory
        : 'CRYPTO_TOKEN',
      name: outgoing
        ? `${symbol} → ${exchange || shortAddress(transfer.to_address)}`
        : `${symbol} ← ${exchange || shortAddress(transfer.from_address)}`,
      amount,
    };
  }

  return {
    category: transfer.counterparty_is_own ? 'CRYPTO_SELF_TRANSFER'
      : exchange ? exchangeCategory
      : 'CRYPTO_EXTERNAL',
    name: outgoing
      ? `ETH → ${exchange || shortAddress(transfer.to_address)}`
      : `ETH ← ${exchange || shortAddress(transfer.from_address)}`,
    amount,
  };
}

class EthTransactionMirrorService {
  // Deterministic full rebuild of the wallet account's mirrored ledger rows.
  //
  // Touches no network. Before #73 this fetched the current ETH price and a
  // CoinGecko token-price page per chain on every rebuild -- and a rebuild runs
  // on every label click through refreshClassificationsForUser, which is why it
  // needed a TTL cache and a stale-amount fallback to survive rapid triage. The
  // dated series removed all of that: valuation is a SQL pass that ran before
  // this, and this reads its answer.
  static async rebuildForWallet(walletId) {
    const wallet = await EthWallet.findById(walletId);
    if (!wallet) throw new Error(`EthWallet ${walletId} not found`);
    const account = await EthWallet.getAccountForWallet(walletId);
    if (!account) return { skipped: true };

    const [transfersResult, ignoredResult] = await Promise.all([
      pool.query('SELECT * FROM eth_transfers WHERE wallet_id = $1 ORDER BY block_number, id', [walletId]),
      pool.query('SELECT contract_address FROM eth_ignored_tokens WHERE user_id = $1', [wallet.user_id]),
    ]);
    const transfers = transfersResult.rows;
    const ignoredContracts = new Set(ignoredResult.rows.map((row) => row.contract_address));

    const rows = [];
    let unpricedSkipped = 0;
    for (const transfer of transfers) {
      const body = buildMirrorRow(transfer, wallet.address, { ignoredContracts });
      if (!body) {
        // Counted, not mirrored: these are the legs the ledger is knowingly
        // silent about, and the count is what makes that silence visible in the
        // logs instead of looking like a wallet with less activity.
        if (transfer.usd_at_time == null && transfer.usd_basis !== 'not_applicable'
            && transfer.transfer_type !== 'nft' && transfer.transfer_type !== 'nft1155'
            && !transfer.is_error) {
          unpricedSkipped++;
        }
        continue;
      }
      rows.push({
        eth_transfer_id: transfer.id,
        date: transfer.block_time,
        chain_id: Number(transfer.chain_id ?? chains.DEFAULT_CHAIN_ID),
        ...body,
      });
    }

    await pool.query(
      'DELETE FROM transactions WHERE account_id = $1 AND eth_transfer_id IS NOT NULL',
      [account.id]
    );

    const CHUNK = 500;
    for (let start = 0; start < rows.length; start += CHUNK) {
      const chunk = rows.slice(start, start + CHUNK);
      const values = [];
      const placeholders = chunk.map((row, i) => {
        const base = i * 6;
        values.push(row.eth_transfer_id, row.date, row.name, row.amount, row.category, row.chain_id);
        return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, ${account.id}, 'USD', FALSE)`;
      });
      await pool.query(
        `INSERT INTO transactions (eth_transfer_id, date, name, amount, category, chain_id, account_id, currency_code, pending)
         VALUES ${placeholders.join(', ')}
         ON CONFLICT (eth_transfer_id) WHERE eth_transfer_id IS NOT NULL DO NOTHING`,
        values
      );
    }

    logger.info({ walletId, mirrored: rows.length, unpricedSkipped }, 'ETH transaction mirror rebuilt');
    return { mirrored: rows.length, unpricedSkipped };
  }

}

module.exports = EthTransactionMirrorService;
module.exports.buildMirrorRow = buildMirrorRow;
