# Bridge matching v1

Status: implementation specification
Rule version: `bridge-match-v1`
Research cut: 2026-08-05

## Purpose

Two transactions that are close in time and amount are not proof of one bridge
movement. Folding them can hide a real payment, receive, or failed bridge. This
spec therefore treats bridge matching as an identity problem, not a similarity
problem.

A movement may be folded only when either:

1. a versioned protocol adapter derives the same protocol-defined identifier
   from independently fetched source and destination evidence; or
2. the user confirms one exact pair of transaction coordinates.

Address, asset, amount, and time can nominate candidates. They never authorize
folding. When more than one candidate is plausible, all alternatives are shown
and none is selected. A note does not constitute a verdict and does not clear
`needs_review`.

## Evidence levels

| Level | Meaning | May fold? |
|---|---|---:|
| Protocol identity | Both sides carry the same protocol-defined correlation key and compatible roles, and both receipt chains are finalized | Yes |
| User verdict | A durable, user-scoped confirmation names both transaction coordinates | Yes |
| Address + contract asset + exact amount | Chain-scoped endpoint and exact asset/amount agree | No |
| Contract asset + narrow time window | Asset and time agree without endpoint corroboration | No |
| Symbol, percentage tolerance, or greedy choice | Display similarity only | No |
| Incomplete, malformed, reorged, or unsupported evidence | Identity cannot be proved | No |

Protocol identity is not inferred from a shared bridge address. Endpoints only
route a receipt to the correct decoder and version. The decoder must still emit
a correlation key from protocol data.

## Data model

`eth_bridge_endpoints` is a chain-scoped, versioned registry. A row includes
protocol, family version, chain, address, role, direction, deployment bounds,
and a first-party source URL. The same address may have different roles on two
chains. User address-label overrides still control classification; the endpoint
registry controls decoding, not personal intent.

`eth_bridge_receipts` is durable source evidence keyed by owner wallet, chain,
and transaction hash. It preserves the transaction envelope, block number and
hash, receipt status, log address/index/topics/data, provider boundary, fetch
status, and decoder version. Failures are receipts too: an unavailable provider,
malformed response, or missing transaction is stored without fabricating data.
The table survives activity rebuilds.

`eth_bridge_movements` is the logical cross-chain movement. It stores protocol,
version, lifecycle status, verification method, correlation key, rule version,
evidence summary, and any invalidation receipt. Its database constraint permits
automatic folding only for `protocol_identity`; the only other folding method
is `user_verdict`.

`eth_bridge_movement_members` names durable transaction coordinates rather than
ephemeral activity row ids. Roles are initiation, destination execution/fill,
proof, finalization, refund, and fee. A rebuild projects active, verified members
onto `eth_activity_links` for legacy readers. Raw activity and gas rows remain.

`eth_bridge_suggestions` contains every non-identity alternative and its reason.
`eth_bridge_verdicts` contains user-scoped confirmed or rejected coordinate
pairs. Both survive rebuilds. Rejection suppresses only that exact candidate.

## Lifecycle and folding

Statuses are:

- `protocol_verified`: matching protocol identity exists on both sides and both
  receipt chains are finalized;
- `user_confirmed`: the user confirmed an exact pair;
- `suggested`: one or more non-identity candidates exist;
- `pending`: only an initiation is proven so far;
- `refunded`: protocol evidence proves a refund member;
- `failed`: protocol evidence proves failure;
- `unsupported`: current evidence cannot express the protocol identity; and
- `invalidated`: a reorg, endpoint-version change, malformed refetch, or user
  rejection withdrew the former basis.

Only `protocol_verified` and `user_confirmed` movements project a fold. Pending,
refunded, failed, unsupported, invalidated, and suggested rows remain visible as
separate activity. A refund is a separate member, never a successful arrival.
Fees come only from protocol-declared fields or exact movement-member asset
deltas after identity is proven; no percentage tolerance participates in
identity.

## Finality and reorgs

Receipt acquisition records the block hash. Every bridge rebuild revalidates a
stored candidate receipt against the provider when a provider is available. A
changed block hash is durably appended to the receipt's bounded reorg history
and the movement is derived again from the replacement receipt. A missing
transaction, changed/absent protocol identity, or failed receipt invalidates the
former protocol movement and removes its projection. It never deletes raw
transfers. The legs return to review. User confirmations remain durable; if an
activity disappears, its fold is omitted while the verdict stays audit-visible.

Providers are bounded. A null, empty, truncated, or error response is accepted
only when its boundary proves that answer. Otherwise the fetch is failed and no
new identity is derived. Logs are validated before storage; unknown topics are
preserved but do not decode.

For EVM receipts, finality is established only by the standard
`eth_getBlockByNumber("finalized", false)` boundary and requires the receipt
block to be at or below that finalized height. The finalized block number and
hash are stored with the receipt. If a provider does not expose the finalized
tag, returns a malformed boundary, or has not finalized the receipt block yet,
an otherwise exact protocol pair remains `pending`. The matcher deliberately
has no confirmation-count approximation. Current public RPCs prove this
boundary for OP Mainnet, Base, Gnosis, and zkSync Era; the configured Etherscan
proxy does not expose the tag for Ethereum, Polygon, Arbitrum, or Linea, so
paths requiring those receipts remain pending until a finality-capable provider
or an explicit user verdict is available. zkSync Lite archive records marked
committed by the official archive are treated as finalized archive evidence.

## Adapter contract

Every adapter implements one pure interface:

```text
decode({ chain, transaction, receipt, endpoints }) -> evidence events[]
```

An evidence event states protocol/version, role, direction, lifecycle status,
canonical correlation key, contract asset identity, protocol amount/fee when
available, and the exact transaction/log evidence used. The orchestrator joins
events only when protocol, compatible family version, correlation key, chain
direction, and roles agree. Adapters never search by amount/time and never claim
one side greedily.

Malformed known events fail closed. Unknown events are retained in the receipt
but ignored. Decoder version is stored so a future ruleset can invalidate and
re-evaluate old output reproducibly.

## Protocol matrix

### OP Stack: OP Mainnet and Base

Versions: Bedrock and later canonical Portal/StandardBridge.

- L1 to L2: the L1 Portal emits
  `TransactionDeposited(from,to,version,opaqueData)`. For a user deposit the
  source hash is
  `keccak256(bytes32(0), keccak256(l1BlockHash, bytes32(logIndex)))`.
  The type `0x7e` L2 deposit transaction carries that `sourceHash`. Equality is
  protocol identity.
- L2 to L1: `L2ToL1MessagePasser.MessagePassed` emits `withdrawalHash`; the L1
  Portal's `WithdrawalFinalized(withdrawalHash,success)` carries the same hash.
- `ETHBridgeInitiated`/`ETHBridgeFinalized` identify assets and roles but do not
  alone identify a cross-chain pair.
- A false `success` is `failed`; only a true finalization completes.

First-party sources:
[deposits specification](https://specs.optimism.io/protocol/deposits.html),
[withdrawals specification](https://specs.optimism.io/protocol/withdrawals.html),
and the [Superchain address registry](https://github.com/ethereum-optimism/superchain-registry).

### Arbitrum Classic and Nitro

- Nitro L2 to L1: `ArbSys.L2ToL1Tx` carries indexed `position`; the L1 Outbox
  emits `OutBoxTransactionExecuted` with the same non-indexed
  `transactionIndex` (its third indexed field is a compatibility zero).
  The correlation key includes the Arbitrum chain id and position.
- Nitro L1 to L2 retryables expose `InboxMessageDelivered(messageNum, data)`,
  but the destination identity requires the canonical retryable-id derivation
  and complete message data. Until that derivation is implemented from a full
  receipt, these deposits are suggestions.
- Classic deposits/withdrawals remain suggestions. A migrated Classic deposit
  normalized by the account feed is an activity fact, not cross-chain proof.

First-party sources: Offchain Labs'
[Nitro contracts](https://github.com/OffchainLabs/nitro-contracts) and
[Arbitrum SDK](https://github.com/OffchainLabs/arbitrum-sdk).

### Polygon PoS and Plasma

- PoS deposits emit `StateSynced(id,receiver,data)` on Ethereum. The current
  Polygon account/state-sync feed reduces the destination credit to the MRC20
  `Deposit` event and does not preserve an independently correlatable state id.
  Those paths remain suggestions.
- PoS exits require proof data submitted to `exit`; a burn amount and later
  release are not identity without decoding that proof.
- Native POL uses the Plasma DepositManager and MRC20 state-sync path. The
  destination receipt currently does not provide a validated source deposit id,
  so it remains suggestion-only.

First-party sources: Polygon's [PoS portal contracts](https://github.com/maticnetwork/pos-portal),
[state-sync specification](https://docs.polygon.technology/pos/architecture/bor/state-sync/),
and [state transfer guide](https://docs.polygon.technology/pos/how-to/bridging/l1-l2-communication/state-transfer/).

### Gnosis xDAI and USDS

- Legacy Ethereum to Gnosis: destination `AffirmationCompleted` carries the
  Ethereum reference transaction hash. It must equal the source transaction.
- Legacy Gnosis to Ethereum: destination `RelayedMessage` carries the Gnosis
  reference transaction hash. It must equal the source transaction.
- `UserRequestForAffirmation`/`UserRequestForSignature` provide initiation and
  asset evidence but no second-side identity by themselves.
- New BridgeRouter/USDS paths remain suggestions until their exact router
  message identifier is present in both receipts.

First-party source: Gnosis'
[token bridge contracts](https://github.com/gnosischain/tokenbridge-contracts) and
[xDAI bridge documentation](https://docs.gnosischain.com/bridges/About%20Token%20Bridges/xdai-bridge).

### zkSync Era

- Modern deposits: `BridgehubDepositFinalized(chainId,txDataHash,l2DepositTxHash)`
  supplies the destination L2 transaction hash. A destination activity with that
  exact hash is protocol identity.
- The initiation events preserve sender, chain, asset id, and mint data. Failed
  deposits and recovery are lifecycle members, not arrivals.
- Withdrawals emit `L1MessageSent(sender,hash,message)` on L2, but current L1
  finalization events do not independently expose that hash. Until the proof or
  finalize calldata is decoded, withdrawals remain suggestions.

First-party source: Matter Labs'
[Era contracts](https://github.com/matter-labs/era-contracts), especially
`IL1Nullifier`, `IAssetRouterBase`, `IMailboxImpl`, and `IL1Messenger`.

### zkSync Lite

- A Lite `Deposit` priority operation is identified by the Ethereum transaction
  hash. The official archive returns that hash as the Lite transaction hash. An
  Ethereum initiation with the same exact hash is protocol identity.
- Lite withdrawals may be completed in batches on Ethereum. Amount/time cannot
  identify the completion, so withdrawals remain suggestions unless a user
  confirms them.
- Rejected Lite operations are failed, never completed bridge members.

First-party sources: Matter Labs' [Lite basic concepts](https://docs.lite.zksync.io/dev/payments/basic/)
and [official archive event schema](https://docs.lite.zksync.io/api/events/).

### Linea

`MessageSent` emits an indexed `messageHash`; `MessageClaimed` emits the same
indexed hash. The hash is computed from sender, recipient, fee, value, nonce,
and calldata. Equality is protocol identity. Token bridge initiation/finalized
events supply assets and amounts but the MessageService hash performs pairing.

First-party source: Consensys' [Linea contracts](https://github.com/Consensys/linea-contracts),
especially `IMessageService` and `L1MessageService`.

### Across V2 and V3

- Legacy V3 `V3FundsDeposited`/`FilledV3Relay` and current
  `FundsDeposited`/`FilledRelay` carry `depositId` plus origin chain id.
- The canonical key is `(Across version, originChainId, depositId)`. The fill's
  origin chain must equal the source receipt chain and its destination must be
  the fill receipt chain. Common relay parameters, depositor, recipient, token
  identities, and declared amounts must also be compatible.
- Speed-ups update destination terms but retain the key. Duplicate or competing
  fills are all retained; malformed or incompatible alternatives match none.
- V2 also carries deposit identifiers, but deployed V2 event layouts changed
  and permitted partial fills. Until endpoints are block-bounded to those ABI
  variants and partial fills are modeled, V2 is suggestion-only.
- The output/input difference is a declared relay economic delta only after
  identity is established. It is not a matching tolerance.

First-party sources: Across'
[tracking guide](https://docs.across.to/introduction/tracking-deposits),
[migration guide](https://docs.across.to/developer-quickstart/migration-guides/migration-guide-v2-to-v3),
and [contract interfaces](https://github.com/across-protocol/contracts).

### Hop v1

Issue #86 adds a registry-scoped Hop v1 adapter for the reviewed mainnet
USDC.e deployment. The initial registry covers Ethereum plus Gnosis, Polygon,
Optimism, Arbitrum, and Base: 11 endpoint rows and 25 directed asset routes
(each supported L2 to Ethereum route and each supported L2-to-L2 route). It
does not imply that every Hop asset, chain, or newer deployment is supported.
The registry is generated from the pinned [Hop mainnet address
matrix](https://github.com/hop-protocol/hop/blob/3ae90badbed5708d72cec46d0efeb004a4d0c587/packages/sdk/src/addresses/mainnet.ts),
with deployment bounds, canonical/Hop token variants, bridge and wrapper
addresses, and the source commit stored with every route.

For an L2 initiation, `TransferSent` is the identity-bearing source event. It
contains the destination chain, recipient, gross amount, transfer nonce,
bonder fee, destination token index, `amountOutMin`, deadline, and bonder. The
adapter derives the v1 transfer id as:

```text
keccak256(abi.encode(
  destinationChainId, recipient, amount, transferNonce,
  bonderFee, amountOutMin, deadline
))
```

The exact field order follows the [pinned Hop transfer-ID
helper](https://github.com/hop-protocol/hop/blob/3ae90badbed5708d72cec46d0efeb004a4d0c587/packages/hop-node/src/utils/getTransferId.ts).
The event's `tokenIndex` is still checked against the registered route, but it
is deliberately not added to the hash because it is not part of that deployed
v1 helper. `send` and `swapAndSend` calldata is decoded only to corroborate the
event and endpoint target; the destination swap tuple is checked for the
token index, minimum, and deadline. Unknown or malformed calldata does not
become a match.

The destination identity-bearing event is `Withdrew(transferId, recipient,
amount, transferNonce)`. The recipient must equal the destination wallet and
the observed destination asset must be one of the route's registered canonical
or Hop token addresses. The destination amount must equal `gross amount −
bonder fee` exactly. A `WithdrawalBonded` log is a bonder accounting step, not
proof that the user's wallet received funds, and `TransferSentToL2`/
`TransferFromL1Completed` are left unsupported because the current v1 evidence
does not provide one shared source/destination transfer id for those L1-to-L2
paths. They remain visible for review rather than being amount-matched.

Both receipts require the normal finalized RPC boundary. Destination token-feed
coverage must also be complete through the receipt block; a missing, failed, or
behind feed leaves the Hop movement pending. Route intersection, exact
recipient ownership, asset observation, amount arithmetic, receipt status,
finality, and coverage are all checked before the existing evidence-first
projection can fold the pair. Recapture/refetch re-evaluates the durable raw
receipts without changing user labels, overrides, or verdicts.

First-party sources: the [Hop v1 L2 bridge
contract](https://github.com/hop-protocol/contracts/blob/master/contracts/bridges/L2_Bridge.sol),
the [L2 AMM wrapper](https://github.com/hop-protocol/contracts/blob/master/contracts/bridges/L2_AmmWrapper.sol),
the [pinned SDK ABI](https://github.com/hop-protocol/hop/blob/3ae90badbed5708d72cec46d0efeb004a4d0c587/packages/sdk/src/contracts/Bridge.ts),
and the [pinned mainnet deployment registry](https://github.com/hop-protocol/hop/blob/3ae90badbed5708d72cec46d0efeb004a4d0c587/packages/sdk/src/addresses/mainnet.ts).

## API and UI

The ledger returns `bridge_movement` with status, verification method, protocol,
rule version, members, evidence summary, and alternatives. It folds members only
for verified/confirmed states. The UI labels states exactly as:

- Protocol verified
- User confirmed
- Suggested
- Pending
- Refunded
- Failed
- Unsupported

Suggested alternatives expose Confirm and Reject. A confirmation request names
both wallet ids, chain ids, and transaction hashes. The server verifies both
wallets belong to the caller and that no other confirmed movement already claims
a member. Confirming writes a verdict and rebuilds the projection atomically.
Rejection removes only the named candidate and is undoable.

## Migration

The old amount/time links are copied into `eth_bridge_suggestions` with reason
`legacy_amount_time_heuristic`, then removed from `eth_activity_links`. Their
legs are re-flagged. No historical heuristic is grandfathered into a verified
movement. The projection table gains a required movement id and an evidence
method constraint, so application code cannot reintroduce heuristic folds.

The endpoint seed is rebuilt into the chain-scoped registry without changing
the existing human-correctable address labels. Historical activity is then
re-evaluated from durable receipts. Unsupported paths stay visible and named;
none are presented as complete.

## Definition of done for a protocol path

A path is verified only when synthetic/public fixtures cover concurrent
identical transfers, out-of-order fills, cross-protocol collisions,
retries/speed-ups, refunds/failures, malformed logs, finality gating, reorg invalidation, and
multi-user isolation. Unsupported directions have an explicit tested boundary
and produce suggestions or pending rows, never silent links.
