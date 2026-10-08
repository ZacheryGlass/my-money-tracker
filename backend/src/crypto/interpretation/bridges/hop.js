'use strict';

// Bridge adapter: hop. Pure decoder of one envelope (transaction, receipt,
// chain-scoped endpoint rows) into bridge evidence events; see kit.js.

const { keccak_256 } = require('@noble/hashes/sha3.js');
const { bytesToHex, hexToBytes } = require('@noble/hashes/utils.js');
const {
  ADDRESS_RE,
  lower,
  functionSelector,
  bytes32,
  logIndex,
  dataWord,
  dataWordCount,
  uintWord,
  receiptStatus,
  addressWord,
  transactionInput,
  evidence,
  TOPICS,
  ZERO_ADDRESS,
} = require('./kit');

const HOP_SELECTORS = Object.freeze({
  send: functionSelector('send(uint256,address,uint256,uint256,(uint8,uint256,uint256),address)'),
  sendLegacy: functionSelector('send(uint256,address,uint256,uint256,uint256,uint256)'),
  swapAndSend: functionSelector('swapAndSend(uint256,address,uint256,uint256,(uint8,uint256,uint256),(uint8,uint256,uint256),address)'),
  swapAndSendLegacy: functionSelector('swapAndSend(uint256,address,uint256,uint256,uint256,uint256,uint256,uint256)'),
  sendToL2: functionSelector('sendToL2(uint256,address,uint256,uint256,uint256,address,uint256)'),
  bondWithdrawal: functionSelector('bondWithdrawal(address,uint256,bytes32,uint256)'),
  // The pinned Hop node ABI uses the deployed v1 six-word selector. The
  // current source tree also exposes a tuple-shaped variant, so retain that
  // selector as a decode-only compatibility path without using either call as
  // destination receipt proof.
  bondWithdrawalAndDistribute: functionSelector('bondWithdrawalAndDistribute(address,uint256,bytes32,uint256,uint256,uint256)'),
  bondWithdrawalAndDistributeTuple: functionSelector('bondWithdrawalAndDistribute(address,uint256,bytes32,uint256,(uint8,uint256,uint256))'),
});

function hopBlockNumber(envelope) {
  const raw = envelope.receipt?.blockNumber ?? envelope.block_number;
  if (typeof raw === 'string' && /^0x[0-9a-f]+$/i.test(raw)) {
    const parsed = Number.parseInt(raw, 16);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function jsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function routeAddressList(route, field) {
  return jsonArray(route?.[field]).map(lower).filter((value) => ADDRESS_RE.test(value));
}

function observedHopAssets(envelope, direction) {
  if (!Array.isArray(envelope.legs)) return { known: false, addresses: [] };
  const addresses = envelope.legs
    .filter((leg) => leg.direction === direction)
    .map((leg) => lower(leg.contract || leg.token_contract) || ZERO_ADDRESS)
    .filter((value) => ADDRESS_RE.test(value));
  return { known: true, addresses: [...new Set(addresses)] };
}

function routeBlockApplies(route, envelope, side) {
  const block = hopBlockNumber(envelope);
  const from = Number(route?.[`${side}_valid_from_block`]);
  const to = Number(route?.[`${side}_valid_to_block`]);
  if ((route?.[`${side}_valid_from_block`] != null || route?.[`${side}_valid_to_block`] != null)
      && (!Number.isSafeInteger(block) || block < 0)) return false;
  if (route?.[`${side}_valid_from_block`] != null && block < from) return false;
  if (route?.[`${side}_valid_to_block`] != null && block > to) return false;
  return true;
}

function routeEndpointApplies(route, envelope, side, log) {
  const logAddress = lower(log?.address);
  const transactionAddress = lower(envelope.transaction?.to || envelope.receipt?.to);
  if (side === 'source') {
    return logAddress === lower(route.source_bridge_address)
      || transactionAddress === lower(route.source_bridge_address)
      || transactionAddress === lower(route.source_wrapper_address);
  }
  return logAddress === lower(route.destination_bridge_address)
    || transactionAddress === lower(route.destination_bridge_address)
    || transactionAddress === lower(route.destination_wrapper_address);
}

function routeTokenIndexApplies(route, field, tokenIndex) {
  if (tokenIndex == null) return true;
  const indexes = jsonArray(route?.[field]).map(Number);
  return !indexes.length || indexes.includes(Number(tokenIndex));
}

function hopRouteCandidates(envelope, {
  side, destinationChainId = null, tokenIndex = null, sourceTokenIndex = null,
  log = null, abiVariant = null,
}) {
  const chainId = Number(envelope.chain_id);
  const assets = observedHopAssets(envelope, side === 'source' ? 'out' : 'in');
  return (envelope.hop_routes || []).filter((route) => {
    if (route.enabled === false || route.family_version !== 'v1') return false;
    if (abiVariant && route.abi_variant !== abiVariant) return false;
    if (side === 'source') {
      if (Number(route.source_chain_id) !== chainId
          || Number(route.destination_chain_id) !== Number(destinationChainId)) return false;
      if (!routeBlockApplies(route, envelope, 'source')) return false;
      if (!routeEndpointApplies(route, envelope, 'source', log)) return false;
      if (!routeTokenIndexApplies(route, 'destination_token_indices', tokenIndex)
          || !routeTokenIndexApplies(route, 'source_token_indices', sourceTokenIndex)) return false;
      const allowed = routeAddressList(route, 'source_asset_addresses');
      if (assets.known && (!assets.addresses.length
          || !assets.addresses.every((address) => allowed.includes(address)))) return false;
    } else {
      if (Number(route.destination_chain_id) !== chainId) return false;
      if (!routeBlockApplies(route, envelope, 'destination')) return false;
      if (!routeEndpointApplies(route, envelope, 'destination', log)) return false;
      const allowed = routeAddressList(route, 'destination_asset_addresses');
      if (assets.known && (!assets.addresses.length
          || !assets.addresses.every((address) => allowed.includes(address)))) return false;
    }
    return true;
  });
}

function hopRouteSummary(route) {
  return {
    route_key: route.route_key,
    deployment_key: route.deployment_key,
    asset_key: route.asset_key,
    source_chain_id: Number(route.source_chain_id),
    destination_chain_id: Number(route.destination_chain_id),
    source_bridge_address: lower(route.source_bridge_address),
    source_wrapper_address: lower(route.source_wrapper_address),
    destination_bridge_address: lower(route.destination_bridge_address),
    destination_wrapper_address: lower(route.destination_wrapper_address) || null,
    source_asset_addresses: routeAddressList(route, 'source_asset_addresses'),
    destination_asset_addresses: routeAddressList(route, 'destination_asset_addresses'),
    source_token_indices: jsonArray(route.source_token_indices).map(Number),
    destination_token_indices: jsonArray(route.destination_token_indices).map(Number),
    abi_variant: route.abi_variant || null,
    finality_policy: route.finality_policy || null,
  };
}

function hopEndpointMentioned(envelope, log) {
  const addresses = new Set([
    lower(log?.address), lower(envelope.transaction?.to), lower(envelope.receipt?.to),
  ]);
  return (envelope.endpoints || []).some((endpoint) => endpoint.protocol === 'hop'
      && addresses.has(lower(endpoint.address)))
    || (envelope.hop_routes || []).some((route) => [
      route.source_bridge_address, route.source_wrapper_address,
      route.destination_bridge_address, route.destination_wrapper_address,
    ].map(lower).some((address) => addresses.has(address)));
}

function abiUintWord(value) {
  try {
    const number = BigInt(value);
    if (number < 0n || number >= (1n << 256n)) return null;
    return number.toString(16).padStart(64, '0');
  } catch {
    return null;
  }
}

function abiAddressWord(value) {
  const address = lower(value);
  return ADDRESS_RE.test(address) ? `${'0'.repeat(24)}${address.slice(2)}` : null;
}

function abiBytes32Word(value) {
  const hash = bytes32(value);
  return hash ? hash.slice(2) : null;
}

function hopTransferId(chainId, recipient, amount, transferNonce, bonderFee, amountOutMin, deadline) {
  const words = [
    abiUintWord(chainId), abiAddressWord(recipient), abiUintWord(amount),
    abiBytes32Word(transferNonce), abiUintWord(bonderFee),
    abiUintWord(amountOutMin), abiUintWord(deadline),
  ];
  if (words.some((word) => word == null)) return null;
  return `0x${bytesToHex(keccak_256(hexToBytes(words.join(''))))}`;
}

function hopTransferIdCurrent(
  chainId, recipient, amount, transferNonce, bonderFee, tokenIndex, amountOutMin, deadline
) {
  const words = [
    abiUintWord(chainId), abiAddressWord(recipient), abiUintWord(amount),
    abiBytes32Word(transferNonce), abiUintWord(bonderFee), abiUintWord(tokenIndex),
    abiUintWord(amountOutMin), abiUintWord(deadline),
  ];
  if (words.some((word) => word == null)) return null;
  return `0x${bytesToHex(keccak_256(hexToBytes(words.join(''))))}`;
}

function callWords(input) {
  if (typeof input !== 'string' || !/^0x[0-9a-f]*$/.test(input) || input.length < 10) return null;
  const body = `0x${input.slice(10)}`;
  return { selector: input.slice(0, 10), body, count: dataWordCount(body) };
}

function decodeHopCall(input) {
  const call = callWords(input);
  if (!call) return input == null ? { kind: 'missing' } : { kind: 'malformed' };
  const word = (index) => uintWord(dataWord(call.body, index));
  const address = (index) => addressWord(dataWord(call.body, index));
  const hash = (index) => bytes32(dataWord(call.body, index));
  const malformed = (expected) => call.count !== expected;
  if (call.selector === HOP_SELECTORS.send) {
    if (malformed(8)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      token_index: word(4)?.toString() || null,
      amount_out_min: word(5)?.toString() || null,
      deadline: word(6)?.toString() || null,
      bonder: address(7),
    };
  }
  if (call.selector === HOP_SELECTORS.sendLegacy) {
    if (malformed(6)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send_legacy', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      amount_out_min: word(4)?.toString() || null,
      deadline: word(5)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.swapAndSend) {
    if (malformed(11)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'swap_and_send', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      source_token_index: word(4)?.toString() || null,
      source_amount_out_min: word(5)?.toString() || null,
      source_deadline: word(6)?.toString() || null,
      destination_token_index: word(7)?.toString() || null,
      destination_amount_out_min: word(8)?.toString() || null,
      destination_deadline: word(9)?.toString() || null,
      bonder: address(10),
    };
  }
  if (call.selector === HOP_SELECTORS.swapAndSendLegacy) {
    if (malformed(8)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'swap_and_send_legacy', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      bonder_fee: word(3)?.toString() || null,
      source_amount_out_min: word(4)?.toString() || null,
      source_deadline: word(5)?.toString() || null,
      destination_amount_out_min: word(6)?.toString() || null,
      destination_deadline: word(7)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.sendToL2) {
    if (malformed(7)) return { kind: 'malformed', selector: call.selector };
    return {
      kind: 'send_to_l2', selector: call.selector,
      destination_chain_id: word(0)?.toString() || null,
      recipient: address(1), amount: word(2)?.toString() || null,
      amount_out_min: word(3)?.toString() || null,
      deadline: word(4)?.toString() || null,
      relayer: address(5), relayer_fee: word(6)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawalAndDistribute) {
    if (malformed(6)) return { kind: 'bond_withdrawal_and_distribute', selector: call.selector };
    return {
      kind: 'bond_withdrawal_and_distribute', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null,
      transfer_nonce: hash(2), bonder_fee: word(3)?.toString() || null,
      amount_out_min: word(4)?.toString() || null, deadline: word(5)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawalAndDistributeTuple) {
    if (malformed(7)) return { kind: 'bond_withdrawal_and_distribute', selector: call.selector };
    return {
      kind: 'bond_withdrawal_and_distribute', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null,
      transfer_nonce: hash(2), bonder_fee: word(3)?.toString() || null,
      token_index: word(4)?.toString() || null,
      amount_out_min: word(5)?.toString() || null, deadline: word(6)?.toString() || null,
    };
  }
  if (call.selector === HOP_SELECTORS.bondWithdrawal) {
    if (malformed(4)) return { kind: 'bond_withdrawal', selector: call.selector };
    return {
      kind: 'bond_withdrawal', selector: call.selector,
      recipient: address(0), amount: word(1)?.toString() || null, transfer_nonce: hash(2),
      bonder_fee: word(3)?.toString() || null,
    };
  }
  return { kind: 'unknown', selector: call.selector };
}

function hopCallMatchesSource(call, fields) {
  if (!call || call.kind === 'missing') return true;
  if (call.kind === 'malformed' || call.kind === 'unknown' || call.kind === 'send_to_l2') return false;
  if (call.destination_chain_id !== fields.destination_chain_id
      || call.recipient !== fields.recipient
      || call.bonder_fee !== fields.bonder_fee) return false;
  if (call.kind === 'send') {
    return call.amount === fields.amount
      && call.token_index === fields.token_index
      && call.amount_out_min === fields.amount_out_min
      && call.deadline === fields.deadline
      && call.bonder === fields.bonder;
  }
  if (call.kind === 'send_legacy') {
    return call.amount === fields.amount
      && call.amount_out_min === fields.amount_out_min
      && call.deadline === fields.deadline;
  }
  if (call.kind === 'swap_and_send_legacy') {
    const emitted = hopBigInt(fields.amount);
    const sourceMinimum = hopBigInt(call.source_amount_out_min);
    return emitted != null && sourceMinimum != null && emitted >= sourceMinimum
      && call.destination_amount_out_min === fields.amount_out_min
      && call.destination_deadline === fields.deadline;
  }
  const emitted = hopBigInt(fields.amount);
  const sourceMinimum = hopBigInt(call.source_amount_out_min);
  return emitted != null && sourceMinimum != null && emitted >= sourceMinimum
    && call.destination_token_index === fields.token_index
    && call.destination_amount_out_min === fields.amount_out_min
    && call.destination_deadline === fields.deadline
    && call.bonder === fields.bonder;
}

function hopCoverage(envelope, assetObservation) {
  if (!Array.isArray(envelope.feed_coverage)) return null;
  const native = assetObservation?.known === true
    && assetObservation.addresses.length > 0
    && assetObservation.addresses.every((address) => address === ZERO_ADDRESS);
  if (native) {
    const block = hopBlockNumber(envelope);
    const candidates = envelope.feed_coverage.filter(
      (entry) => entry.feed === 'internal' || entry.feed === 'normal'
    );
    if (!candidates.length) {
      return { status: 'incomplete', reason: 'destination_native_feed_coverage_missing' };
    }
    const complete = candidates.find((entry) => Number.isSafeInteger(Number(entry.covered_through_block))
      && Number(entry.covered_through_block) >= block);
    if (complete) {
      return {
        status: 'complete', feed: complete.feed,
        covered_through_block: Number(complete.covered_through_block),
      };
    }
    return {
      status: 'incomplete', reason: 'destination_native_feed_coverage_behind_receipt',
      feeds: candidates.map((entry) => ({
        feed: entry.feed, status: entry.status || null,
        covered_through_block: Number.isSafeInteger(Number(entry.covered_through_block))
          ? Number(entry.covered_through_block) : null,
      })),
    };
  }
  const tokenCoverage = envelope.feed_coverage.find((entry) => entry.feed === 'token');
  const block = hopBlockNumber(envelope);
  if (!tokenCoverage) {
    return { status: 'incomplete', reason: 'destination_token_feed_coverage_missing', feed: 'token' };
  }
  const coveredThrough = Number(tokenCoverage.covered_through_block);
  if (Number.isSafeInteger(block) && Number.isSafeInteger(coveredThrough)
      && coveredThrough >= block) {
    return { status: 'complete', feed: 'token', covered_through_block: coveredThrough };
  }
  if (tokenCoverage.status !== 'complete') {
    return {
      status: 'incomplete', reason: `destination_token_feed_${tokenCoverage.status || 'unknown'}`,
      feed: 'token', coverage_status: tokenCoverage.status || null,
    };
  }
  if (!Number.isSafeInteger(block) || !Number.isSafeInteger(coveredThrough)
      || coveredThrough < block) {
    return {
      status: 'incomplete', reason: 'destination_token_feed_coverage_behind_receipt',
      feed: 'token', covered_through_block: Number.isSafeInteger(coveredThrough)
        ? coveredThrough : null,
    };
  }
  return { status: 'complete', feed: 'token', covered_through_block: coveredThrough };
}

function hopStatus(envelope) {
  return receiptStatus(envelope.receipt) === 0n ? 'failed' : 'pending';
}

function hopDiagnostic(envelope, log, reason, details = {}) {
  const role = envelope.category === 'bridge_out' ? 'initiation' : 'destination_execution';
  const key = `hop:unsupported:${Number(envelope.wallet_id)}:${Number(envelope.chain_id)}:${lower(envelope.tx_hash)}:${logIndex(log) ?? 'tx'}`;
  return evidence(envelope, log, {
    protocol: 'hop', family_version: 'v1', role,
    direction: envelope.category === 'bridge_out' ? 'out' : 'in',
    correlation_key: key, status: 'unsupported',
    details: { reason, hop: { reason, ...details } },
  });
}

function decodeHop(envelope) {
  const events = [];
  for (const log of envelope.receipt?.logs || []) {
    const topic0 = lower(log.topics?.[0]);
    if (![TOPICS.hopTransferSentPinned, TOPICS.hopTransferSent, TOPICS.hopTransferSentToL2,
      TOPICS.hopTransferFromL1Completed, TOPICS.hopWithdrawalBonded,
      TOPICS.hopWithdrawalBondedLegacy, TOPICS.hopWithdrew]
      .includes(topic0)) continue;
    if (!hopEndpointMentioned(envelope, log)) continue;

    if (topic0 === TOPICS.hopTransferSentPinned || topic0 === TOPICS.hopTransferSent) {
      if (envelope.category !== 'bridge_out') continue;
      const pinnedEvent = topic0 === TOPICS.hopTransferSentPinned;
      const expectedDataWords = pinnedEvent ? 6 : 8;
      if (log.topics?.length !== 4 || dataWordCount(log.data) !== expectedDataWords) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_log'));
        continue;
      }
      const eventTransferId = pinnedEvent ? bytes32(log.topics[1]) : null;
      const destinationChainId = uintWord(log.topics[pinnedEvent ? 2 : 1]);
      const recipient = addressWord(log.topics[3]);
      const amount = uintWord(dataWord(log.data, 0));
      const transferNonce = bytes32(dataWord(log.data, 1));
      const bonderFee = uintWord(dataWord(log.data, 2));
      const tokenIndex = pinnedEvent ? null : uintWord(dataWord(log.data, 4));
      const amountOutMin = uintWord(dataWord(log.data, pinnedEvent ? 4 : 5));
      const deadline = uintWord(dataWord(log.data, pinnedEvent ? 5 : 6));
      const bonder = pinnedEvent ? null : addressWord(dataWord(log.data, 7));
      if (destinationChainId == null || (pinnedEvent && !eventTransferId) || !recipient
          || amount == null || !transferNonce || bonderFee == null
          || (!pinnedEvent && (tokenIndex == null || tokenIndex > 255n || !bonder))
          || amountOutMin == null || deadline == null) {
        events.push(hopDiagnostic(envelope, log, 'malformed_transfer_sent_fields'));
        continue;
      }
      const computedTransferId = pinnedEvent
        ? hopTransferId(
          destinationChainId, recipient, amount, transferNonce, bonderFee, amountOutMin, deadline
        )
        : hopTransferIdCurrent(
          destinationChainId, recipient, amount, transferNonce, bonderFee,
          tokenIndex, amountOutMin, deadline
        );
      const transferId = eventTransferId || computedTransferId;
      const transferIdMatches = Boolean(computedTransferId)
        && (!eventTransferId || eventTransferId === computedTransferId);
      const input = transactionInput(envelope.transaction);
      const call = decodeHopCall(input);
      const routes = hopRouteCandidates(envelope, {
        side: 'source', destinationChainId: destinationChainId.toString(),
        tokenIndex: tokenIndex == null ? null : tokenIndex.toString(),
        sourceTokenIndex: call.source_token_index, log,
        abiVariant: pinnedEvent ? 'hop-v1-transfer-sent-withdrawal-v1'
          : 'hop-v1-current-transfer-sent',
      });
      const routeSummaries = routes.map(hopRouteSummary);
      const callKnown = call.kind !== 'missing';
      const target = lower(envelope.transaction?.to || envelope.receipt?.to);
      const sourceTargets = new Set(routes.flatMap((route) => [
        lower(route.source_bridge_address), lower(route.source_wrapper_address),
      ]));
      if (!transferIdMatches || !routes.length
          || (callKnown && (!sourceTargets.has(target) || !hopCallMatchesSource(call, {
            destination_chain_id: destinationChainId.toString(), recipient,
            amount: amount.toString(), bonder_fee: bonderFee.toString(),
            token_index: tokenIndex == null ? null : tokenIndex.toString(),
            amount_out_min: amountOutMin.toString(), deadline: deadline.toString(), bonder,
          })))) {
        const reason = !transferIdMatches ? 'transfer_id_mismatch'
          : !routes.length ? 'unsupported_route'
          : call.kind === 'malformed' ? 'malformed_source_calldata'
            : call.kind === 'unknown' ? 'unsupported_source_calldata_selector'
              : !sourceTargets.has(target) ? 'source_endpoint_mismatch' : 'source_calldata_mismatch';
        events.push(hopDiagnostic(envelope, log, reason, {
          transfer_id: transferId, computed_transfer_id: computedTransferId,
          destination_chain_id: destinationChainId.toString(),
          route_candidates: routeSummaries, call,
        }));
        continue;
      }
      const assetIds = [...new Set(routeSummaries.map((route) => route.asset_key))];
      events.push(evidence(envelope, log, {
        protocol: 'hop', family_version: 'v1', role: 'initiation', direction: 'out',
        correlation_key: `hop:v1:${transferId}`, asset_id: assetIds.length === 1 ? `hop:${assetIds[0]}` : null,
        amount: amount.toString(), fee_amount: bonderFee.toString(), status: hopStatus(envelope),
        details: {
          identity_fields: {
            transfer_id: transferId,
            source_chain_id: String(envelope.chain_id),
            destination_chain_id: destinationChainId.toString(),
            direction: 'out',
          },
          hop: {
            transfer_id: transferId,
            transfer_nonce: transferNonce,
            destination_chain_id: destinationChainId.toString(),
            recipient,
            gross_amount: amount.toString(),
            bonder_fee: bonderFee.toString(),
            token_index: tokenIndex == null ? null : tokenIndex.toString(),
            amount_out_min: amountOutMin.toString(),
            deadline: deadline.toString(),
            bonder,
            route_candidates: routeSummaries,
            source_calldata: call,
            source_asset_observation: observedHopAssets(envelope, 'out'),
          },
        },
      }));
    } else if (topic0 === TOPICS.hopTransferSentToL2
        || topic0 === TOPICS.hopTransferFromL1Completed) {
      events.push(hopDiagnostic(envelope, log, 'unsupported_l1_l2_transfer_id_absent'));
    } else if (topic0 === TOPICS.hopWithdrawalBonded
        || topic0 === TOPICS.hopWithdrawalBondedLegacy) {
      if (envelope.category !== 'bridge_in') continue;
      const legacy = topic0 === TOPICS.hopWithdrawalBondedLegacy;
      const transferId = bytes32(log.topics?.[1]);
      const expectedWords = legacy ? 1 : 2;
      const amount = uintWord(dataWord(log.data, 0));
      const bonder = legacy ? null : addressWord(dataWord(log.data, 1));
      const call = decodeHopCall(transactionInput(envelope.transaction));
      const walletAddress = lower(envelope.wallet_address);
      const assetObservation = observedHopAssets(envelope, 'in');
      const routes = hopRouteCandidates(envelope, { side: 'destination', log });
      const routeSummaries = routes.map(hopRouteSummary);
      if (!transferId || log.topics?.length !== 2
          || dataWordCount(log.data) !== expectedWords || amount == null
          || (!legacy && !bonder)) {
        events.push(hopDiagnostic(envelope, log, 'malformed_withdrawal_bonded_log', {
          transfer_id: transferId,
        }));
        continue;
      }
      if (!['bond_withdrawal', 'bond_withdrawal_and_distribute'].includes(call.kind)
          || !call.recipient || !call.transfer_nonce
          || call.amount == null || call.bonder_fee == null) {
        events.push(hopDiagnostic(envelope, log,
          call.kind === 'malformed' ? 'malformed_destination_calldata'
            : 'unsupported_withdrawal_bonded_calldata', {
            transfer_id: transferId, destination_calldata: call,
          }));
        continue;
      }
      if (!walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_wallet_address_missing', {
          transfer_id: transferId, recipient: call.recipient,
        }));
        continue;
      }
      if (call.recipient !== walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_recipient_not_owned', {
          transfer_id: transferId, recipient: call.recipient, wallet_address: walletAddress,
        }));
        continue;
      }
      if (call.amount !== amount.toString()) {
        events.push(hopDiagnostic(envelope, log, 'destination_calldata_amount_mismatch', {
          transfer_id: transferId, destination_event_amount: amount.toString(),
          destination_calldata: call,
        }));
        continue;
      }
      if (!routes.length) {
        events.push(hopDiagnostic(envelope, log, 'unsupported_destination_route', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      if (assetObservation.known && !assetObservation.addresses.length) {
        events.push(hopDiagnostic(envelope, log, 'destination_asset_not_observed', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      const assetIds = [...new Set(routeSummaries.map((route) => route.asset_key))];
      const coverage = hopCoverage(envelope, assetObservation);
      events.push(evidence(envelope, log, {
        protocol: 'hop', family_version: 'v1', role: 'destination_execution', direction: 'in',
        correlation_key: `hop:v1:${transferId}`,
        asset_id: assetIds.length === 1 ? `hop:${assetIds[0]}` : null,
        amount: amount.toString(), status: hopStatus(envelope),
        details: {
          identity_fields: {
            transfer_id: transferId,
            destination_chain_id: String(envelope.chain_id),
            direction: 'in',
          },
          hop: {
            transfer_id: transferId,
            destination_event: legacy ? 'WithdrawalBonded(bytes32,uint256)'
              : 'WithdrawalBonded(bytes32,uint256,address)',
            destination_event_amount: amount.toString(),
            transfer_nonce: call.transfer_nonce,
            recipient: call.recipient,
            bonder,
            destination_bonder_fee: call.bonder_fee,
            destination_amount_out_min: call.amount_out_min || null,
            destination_deadline: call.deadline || null,
            wallet_address: walletAddress,
            route_candidates: routeSummaries,
            destination_asset_observation: assetObservation,
            destination_coverage: coverage,
            destination_calldata: call,
          },
        },
      }));
    } else {
      if (envelope.category !== 'bridge_in') continue;
      const transferId = bytes32(log.topics?.[1]);
      const isWithdrew = topic0 === TOPICS.hopWithdrew;
      const expectedTopics = isWithdrew ? 3 : 2;
      const expectedWords = 2;
      if (!transferId || log.topics?.length !== expectedTopics
          || dataWordCount(log.data) !== expectedWords) {
        events.push(hopDiagnostic(envelope, log, 'malformed_destination_log'));
        continue;
      }
      const amount = uintWord(dataWord(log.data, 0));
      const transferNonce = isWithdrew ? bytes32(dataWord(log.data, 1)) : null;
      const recipient = isWithdrew ? addressWord(log.topics?.[2]) : null;
      const walletAddress = lower(envelope.wallet_address);
      const routes = hopRouteCandidates(envelope, { side: 'destination', log });
      const routeSummaries = routes.map(hopRouteSummary);
      if (amount == null || (isWithdrew && (!transferNonce || !recipient)) || !routes.length) {
        events.push(hopDiagnostic(envelope, log, !routes.length ? 'unsupported_destination_route' : 'malformed_destination_fields', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      if (isWithdrew && walletAddress && recipient !== walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_recipient_not_owned', {
          transfer_id: transferId, recipient, wallet_address: walletAddress,
        }));
        continue;
      }
      if (isWithdrew && !walletAddress) {
        events.push(hopDiagnostic(envelope, log, 'destination_wallet_address_missing', {
          transfer_id: transferId, recipient,
        }));
        continue;
      }
      const assetObservation = observedHopAssets(envelope, 'in');
      if (assetObservation.known && !assetObservation.addresses.length) {
        events.push(hopDiagnostic(envelope, log, 'destination_asset_not_observed', {
          transfer_id: transferId, route_candidates: routeSummaries,
        }));
        continue;
      }
      const assetIds = [...new Set(routeSummaries.map((route) => route.asset_key))];
      const coverage = hopCoverage(envelope, assetObservation);
      events.push(evidence(envelope, log, {
        protocol: 'hop', family_version: 'v1', role: 'destination_execution', direction: 'in',
        correlation_key: `hop:v1:${transferId}`, asset_id: assetIds.length === 1 ? `hop:${assetIds[0]}` : null,
        amount: amount.toString(), status: hopStatus(envelope),
        details: {
          identity_fields: {
            transfer_id: transferId,
            destination_chain_id: String(envelope.chain_id),
            direction: 'in',
          },
          hop: {
            transfer_id: transferId,
            destination_event_amount: amount.toString(),
            transfer_nonce: transferNonce,
            recipient,
            wallet_address: walletAddress || null,
            route_candidates: routeSummaries,
            destination_asset_observation: assetObservation,
            destination_coverage: coverage,
            destination_calldata: decodeHopCall(transactionInput(envelope.transaction)),
          },
        },
      }));
    }
  }
  return events;
}

function hopRouteIdentity(route) {
  return `${route?.deployment_key || ''}:${route?.route_key || ''}`;
}

function hopObservedAssetsMatch(observation, allowed) {
  if (!observation || observation.known !== true) return true;
  if (!Array.isArray(observation.addresses) || observation.addresses.length === 0) return false;
  return observation.addresses.every((address) => allowed.includes(lower(address)));
}

function hopBigInt(value) {
  try {
    if (value == null || !/^\d+$/.test(String(value))) return null;
    return BigInt(value);
  } catch {
    return null;
  }
}

function validateHopPair(sourceEvent, destinationEvent) {
  const reject = (reason, details = {}) => ({ ok: false, reason, ...details });
  const source = sourceEvent?.evidence?.hop;
  const destination = destinationEvent?.evidence?.hop;
  if (!source || !destination) return reject('missing_hop_identity');
  if (source.transfer_id !== destination.transfer_id) return reject('incompatible_transfer_id');
  if (source.transfer_nonce && destination.transfer_nonce
      && lower(source.transfer_nonce) !== lower(destination.transfer_nonce)) {
    return reject('incompatible_transfer_nonce');
  }

  const sourceRoutes = Array.isArray(source.route_candidates) ? source.route_candidates : [];
  const destinationRoutes = Array.isArray(destination.route_candidates)
    ? destination.route_candidates : [];
  const destinationByIdentity = new Map(
    destinationRoutes.map((route) => [hopRouteIdentity(route), route])
  );
  const matches = sourceRoutes
    .map((route) => ({ source: route, destination: destinationByIdentity.get(hopRouteIdentity(route)) }))
    .filter((pair) => pair.destination);
  if (matches.length === 0) return reject('unsupported_or_incompatible_route');
  if (matches.length !== 1) return reject('ambiguous_route');
  const route = matches[0].source;

  if (Number(sourceEvent.chain_id) !== Number(route.source_chain_id)
      || Number(destinationEvent.chain_id) !== Number(route.destination_chain_id)) {
    return reject('route_chain_mismatch');
  }
  const recipient = lower(source.recipient);
  const destinationRecipient = lower(destination.recipient);
  const walletAddress = lower(destination.wallet_address);
  if (!ADDRESS_RE.test(recipient) || recipient !== destinationRecipient
      || recipient !== walletAddress) {
    return reject('destination_recipient_not_owned');
  }

  if (!hopObservedAssetsMatch(source.source_asset_observation, route.source_asset_addresses)
      || !hopObservedAssetsMatch(destination.destination_asset_observation,
        route.destination_asset_addresses)) {
    return reject('route_asset_mismatch');
  }

  const gross = hopBigInt(source.gross_amount);
  const fee = hopBigInt(source.bonder_fee);
  const destinationAmount = hopBigInt(destination.destination_event_amount);
  if (gross == null || fee == null || destinationAmount == null || fee > gross) {
    return reject('malformed_hop_amounts');
  }
  const net = gross - fee;
  // Hop's Withdrew event records the amount including the bonder fee. The
  // contract subtracts that fee only when distributing the recipient's funds.
  if (destinationAmount !== gross) return reject('gross_amount_mismatch', {
    gross_amount: gross.toString(), bonder_fee: fee.toString(),
    destination_amount: destinationAmount.toString(), expected_gross_amount: gross.toString(),
  });
  if (destination.destination_bonder_fee != null
      && hopBigInt(destination.destination_bonder_fee) !== fee) {
    return reject('bonder_fee_mismatch');
  }
  if (destination.destination_amount_out_min != null
      && destination.destination_amount_out_min !== source.amount_out_min) {
    return reject('destination_amount_out_min_mismatch');
  }
  if (destination.destination_deadline != null
      && destination.destination_deadline !== source.deadline) {
    return reject('destination_deadline_mismatch');
  }

  const coverage = destination.destination_coverage;
  const pendingReason = coverage && coverage.status !== 'complete'
    ? coverage.reason || 'destination_feed_coverage_incomplete' : null;
  return {
    ok: true,
    route,
    transfer_id: source.transfer_id,
    gross_amount: gross.toString(),
    bonder_fee: fee.toString(),
    net_amount: net.toString(),
    pending_reason: pendingReason,
  };
}

module.exports = {
  protocol: 'hop',
  order: 90,
  decode: decodeHop,
  validatePair: validateHopPair,
  HOP_SELECTORS,
  decodeHopCall,
  hopTransferId,
  hopTransferIdCurrent,
  validateHopPair,
};
