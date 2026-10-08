import { shortEthAddress } from '../../../utils/format';

// Rule 8's one-way transfers are judged by WHO the other side is, so they
// group per counterparty (one label explains them all). Everything else
// groups by what is wrong with it, whoever it was with.
const PER_PARTY_CATEGORIES = new Set(['send', 'receive']);

export const reviewPartyName = (row) => row.counterparty_name
  || row.exchange_match?.account_name
  || (row.counterparty_address ? shortEthAddress(row.counterparty_address) : null)
  || (row.source === 'exchange' ? row.account_name || row.source_label : null)
  || 'Unknown party';

// Flagged ledger rows, grouped so a run of identical problems is one decision.
// Largest group first, then the most recent.
export function groupReviewRows(rows) {
  const groups = new Map();
  for (const row of rows || []) {
    const perParty = row.source === 'onchain' && PER_PARTY_CATEGORIES.has(row.category);
    const reason = row.review_reason || null;
    const key = [
      row.source,
      row.category,
      reason || '',
      perParty ? (row.counterparty_address || reviewPartyName(row)).toLowerCase() : '',
    ].join('|');
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        source: row.source,
        category: row.category,
        reason,
        perParty,
        counterpartyAddress: perParty ? row.counterparty_address || null : null,
        parties: new Set(),
        rows: [],
        usdTotal: 0,
        unpriced: 0,
        latest: null,
      };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.parties.add(reviewPartyName(row));
    const usd = Number(row.usd_value);
    if (row.usd_value != null && Number.isFinite(usd)) group.usdTotal += Math.abs(usd);
    else group.unpriced += 1;
    if (!group.latest || String(row.occurred_at) > String(group.latest)) group.latest = row.occurred_at;
  }
  return [...groups.values()]
    .map((group) => ({ ...group, parties: [...group.parties] }))
    .sort((a, b) => b.rows.length - a.rows.length || String(b.latest).localeCompare(String(a.latest)));
}

// What would explain this kind of flag, in one sentence. Advice, not a rule:
// every group can still be opened row by row.
export function suggestedFix(group) {
  const who = group.parties.length === 1 ? group.parties[0] : 'these exchanges';
  if (group.source === 'exchange') {
    return 'Flagged when it was imported. Check the details, then mark it reviewed; a fuller export can also fill it in.';
  }
  if (group.category === 'exchange_deposit' || group.category === 'exchange_withdrawal') {
    return `No record from ${who} covers ${group.rows.length === 1 ? 'this transfer' : 'these transfers'}. Import ${who === 'these exchanges' ? 'their' : `${who}'s`} history on the Exchanges page, or mark them reviewed if you are satisfied they are what they say.`;
  }
  if (group.category === 'bridge_out' || group.category === 'bridge_in') {
    return 'The other side of the bridge has not been matched. Confirm a pairing on the Bridges tab, or mark them reviewed.';
  }
  if (group.perParty) {
    return `Say who ${group.parties[0]} is. One label explains every transfer with it.`;
  }
  return 'Open a transaction to correct its category, or mark them reviewed if the category is right.';
}
