import { formatExactUnits, formatTokenUnits, shortEthAddress } from '../../utils/format';

// How an API ledger row reads on screen: its legs as one description, who it
// was with, and whether that party can take a label. Shared by the Activity
// ledger and the Review queue, which render the same rows.

// A uint256 token id runs to 78 digits and would blow the column out.
const shortTokenId = (id) => {
  const text = String(id);
  return text.length > 10 ? `${text.slice(0, 8)}…` : text;
};

// Base units through the SHARED formatter, which is BigInt end to end, at FULL
// precision. Not the six-place default and not an eight-place cap either: the
// server derives `decimals` from the amount's own significant digits, so there
// is no padding to hide, and any cap turns the smallest legs -- a 1-wei dust
// receipt, exactly the row a user has to explain -- into "0 ETH", which is the
// one thing they are not.
// Fiat is the exception: a venue quotes "141.7322484123 USD" to its internal
// precision, but a dollar amount past the cent is noise, not evidence.
const FIAT_ASSETS = new Set(['USD', 'ZUSD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'JPY']);

// Truncated to `digits`, but never to a bare "0": a nonzero amount that cuts
// away entirely says how small it is instead of claiming nothing moved.
export const formatCapped = (units, decimals, digits) => {
  const text = formatTokenUnits(units, decimals, { maxFractionDigits: digits });
  if (text == null) return null;
  const nonzero = /[1-9]/.test(String(units));
  if (nonzero && !/[1-9]/.test(text)) return `< 0.${'0'.repeat(Math.max(digits - 1, 0))}1`;
  return text;
};

const legText = (leg) => {
  const id = leg.token_id != null ? ` #${shortTokenId(leg.token_id)}` : '';
  const amount = (FIAT_ASSETS.has(String(leg.asset).toUpperCase())
    ? formatCapped(leg.units, leg.decimals, 2)
    : formatExactUnits(leg.units, leg.decimals)) ?? String(leg.amount ?? '');
  return `${amount} ${leg.asset}${id}`;
};

// "0.5 ETH -> 1,832.4 USDC". One description built from netted legs, for both
// sources: an exchange trade's base/quote and an on-chain swap's netted legs
// arrive in the same shape from the API precisely so this reads them once.
export const describeLegs = (legs) => {
  const out = (legs || []).filter((leg) => leg.direction === 'out').map(legText);
  const incoming = (legs || []).filter((leg) => leg.direction === 'in').map(legText);
  if (out.length && incoming.length) return `${out.join(' + ')} → ${incoming.join(' + ')}`;
  if (out.length) return `− ${out.join(' + ')}`;
  if (incoming.length) return `+ ${incoming.join(' + ')}`;
  return 'No net movement';
};

// A folded venue record outranks the bare address: it is PROOF of which venue
// the transaction was with, where an unlabeled 0xbbbb…bbbb is only a hex string
// nobody has judged. A user's own label still beats both.
const counterpartyText = (row) => {
  if (row.counterparty_name) return row.counterparty_name;
  if (row.exchange_match?.account_name) return row.exchange_match.account_name;
  if (row.counterparty_address) return shortEthAddress(row.counterparty_address);
  if (row.record_address) return row.record_address;
  return '—';
};

// Rows whose counterparty can carry a verdict. Gas-only rows have none, a
// zero-address mint/burn has no party to label, and an exchange record's
// counterparty IS the venue.
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const isLabelable = (row) => row.source === 'onchain'
  && Boolean(row.counterparty_address)
  && row.counterparty_address !== ZERO_ADDRESS;

// The display fields every ledger surface derives from an API row.
//
// The folded half's legs are NOT merged in. #61 only ever pairs a deposit with
// a withdrawal, so the other side is the SAME money seen from the other end --
// merging renders a 1.25 ETH deposit as "1.25 ETH → 1.25 ETH", which reads as a
// swap of an asset for itself. The pairing shows as the Matched chip and, in
// full, in the row detail.
export const enrichLedgerRow = (row) => {
  const legs = row.legs || [];
  return {
    ...row,
    allLegs: legs,
    description: describeLegs(legs),
    counterparty: counterpartyText(row),
    labelable: isLabelable(row),
  };
};

