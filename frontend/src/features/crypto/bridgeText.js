import { shortEthAddress } from '../../utils/format';

// Hop's protocol identity is a hash over the source event fields, while the
// movement evidence also records the gross amount, bonder fee, and exact net
// amount accepted from the destination receipt. Keep those raw units visible:
// the bridge registry does not guess token decimals, and a rounded display
// would make the identity audit less useful than the underlying evidence.
export const hopPairEvidence = (match) => match?.protocol === 'hop'
  && match?.evidence?.hop_pair
  ? match.evidence.hop_pair
  : null;

export const describeHopPair = (match) => {
  const pair = hopPairEvidence(match);
  if (!pair) return null;
  const transferId = pair.transfer_id ? shortEthAddress(pair.transfer_id) : 'unknown ID';
  const route = pair.route?.route_key || 'registered route';
  return `Hop v1 ${transferId} · ${route} · gross ${pair.gross_amount} − bonder fee ${pair.bonder_fee} = net ${pair.net_amount} base units`;
};
