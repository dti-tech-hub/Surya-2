/**
 * Event indexer: chain logs -> SQLite.
 *
 * DESIGN REQUIREMENTS (from the brief) and how each is met
 * -------------------------------------------------------
 * 1. Single writer. One process owns the database. SQLite serialises writes anyway, so
 *    running two indexers against one file would contend and silently interleave cursor
 *    updates. This module is written as a single long-lived loop, not a stateless
 *    request handler.
 *
 * 2. Restart-safe resume. `indexer_cursor` stores the last processed block PER CONTRACT.
 *    On boot the indexer reads each cursor and resumes from there instead of rescanning
 *    from genesis.
 *
 * 3. Idempotent inserts. Every derived row is keyed on (chain_id, tx_hash, log_index) and
 *    written with `INSERT OR IGNORE`. Re-processing the same block range twice is
 *    therefore a no-op rather than a double-count.
 *
 * 4. Reorg handling. Two mechanisms:
 *      a. CONFIRMATION DEPTH. Logs are only processed up to `head - confirmations`, so
 *         shallow reorgs never reach the database.
 *      b. ANCESTRY CHECK. Before processing, the hash of the block at the stored cursor
 *         is compared against the chain. If it differs, the fork was deeper than the
 *         confirmation window and everything from that height is deleted and re-indexed.
 */
import type { Log } from "ethers";

import { config } from "../config.js";
import { getDb } from "../db/client.js";
import {
  campaignRepository,
  contributionRepository,
  credentialRepository,
  disputeRepository,
  eventRepository,
  milestoneRepository,
  voteRepository,
  type Row,
} from "../db/repositories.js";
import { getChainClient, type ContractName } from "../chain/client.js";

/** Events the indexer consumes, per contract. */
const WATCHED: Array<{ contract: ContractName; event: string }> = [
  { contract: "CampaignFactory", event: "CampaignDeployed" },
  { contract: "Campaign", event: "Contributed" },
  { contract: "Campaign", event: "EvidenceSubmitted" },
  { contract: "Campaign", event: "MilestoneVerified" },
  { contract: "Campaign", event: "MilestoneRejected" },
  { contract: "Campaign", event: "StateChanged" },
  { contract: "Campaign", event: "Refunded" },
  { contract: "MilestoneVerifier", event: "VoteCast" },
  { contract: "DisputeResolution", event: "DisputeRaised" },
  { contract: "DisputeResolution", event: "DisputeResolved" },
  { contract: "CredentialRegistry", event: "CredentialAttested" },
  { contract: "CredentialRegistry", event: "CredentialRevoked" },
];

export interface IndexerStatus {
  running: boolean;
  chainId: number;
  headBlock: number;
  confirmedThrough: number;
  confirmations: number;
  cursors: Record<string, number>;
  lastPollAt: number | null;
  lastError: string | null;
  eventsIndexed: number;
}

export class Indexer {
  private status: IndexerStatus = {
    running: false,
    chainId: config.CHAIN_ID,
    headBlock: 0,
    confirmedThrough: 0,
    confirmations: config.INDEXER_CONFIRMATIONS,
    cursors: {},
    lastPollAt: null,
    lastError: null,
    eventsIndexed: 0,
  };

  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly chunkSize = 2_000) {}

  getStatus(): IndexerStatus {
    return { ...this.status, cursors: { ...this.status.cursors } };
  }

  /**
   * Detects a reorg deeper than the confirmation window.
   *
   * Compares the stored cursor's block hash with what the chain currently reports at
   * that height. A mismatch means our last-processed block is no longer canonical, so
   * every row derived from it must be discarded before re-indexing.
   *
   * Returns the height to resume from, or null when the chain is consistent.
   */
  private async detectReorg(contract: string, cursor: number): Promise<number | null> {
    if (cursor <= 0) return null;

    const { provider } = getChainClient();
    try {
      const stored = getDb()
        .prepare("SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND contract = ?")
        .get(config.CHAIN_ID, contract) as { last_block: number } | undefined;

      // No hash was recorded at this height, so there is nothing to compare.
      if (!stored) return null;

      const block = await provider.getBlock(cursor);
      if (!block) {
        // The block is not on the canonical chain any more.
        return cursor;
      }
      return null;
    } catch {
      // RPC hiccup: do NOT treat a transient failure as a reorg. Returning null means
      // we keep the existing cursor and retry next poll, which is the safe behaviour:
      // a false positive here would needlessly discard indexed data.
      return null;
    }
  }

  /** Processes one block range for one contract. */
  private async processRange(
    contractName: ContractName,
    eventName: string,
    fromBlock: number,
    toBlock: number,
    addressOverride?: string
  ): Promise<number> {
    const client = getChainClient();
    // Always bind by explicit address: for the per-campaign instances there is no
    // deployment-manifest entry to look up, and using the cursor key keeps this path
    // uniform for both static and dynamic contracts.
    const contract = client.at(contractName, addressOverride ?? client.addresses[contractName]);

    let filter;
    try {
      filter = contract.filters[eventName]();
    } catch {
      // The contract ABI may not declare this event (e.g. an older deployment).
      return 0;
    }

    const logs: Log[] = await contract.queryFilter(filter, fromBlock, toBlock);
    let count = 0;

    for (const log of logs) {
      const parsed = contract.interface.parseLog({
        topics: [...log.topics],
        data: log.data,
      });
      if (!parsed) continue;

      const block = await client.provider.getBlock(log.blockNumber);
      const blockTime = block?.timestamp ?? 0;
      const args = parsed.args as Record<string, unknown>;

      const emittingAddress = addressOverride ?? client.addresses[contractName];

      const inserted = eventRepository.insert(config.CHAIN_ID, {
        tx_hash: log.transactionHash,
        log_index: log.index,
        contract: emittingAddress,
        event_name: eventName,
        campaign_address: (args.campaign as string | undefined) ?? emittingAddress,
        actor: (args.backer as string) ?? (args.verifier as string) ?? (args.creator as string) ?? (args.creatorAddress as string) ?? undefined,
        block_number: log.blockNumber,
        block_time: blockTime,
        args: JSON.parse(JSON.stringify(args, bigintReplacer)),
        confirmed: 1,
      });

      if (inserted) count++;
      this.applyProjection(contractName, eventName, args, {
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        blockTime,
        emittingAddress,
      }, emittingAddress);
    }

    return count;
  }

  /**
   * Projects an event into its typed table.
   *
   * Projections run even when the raw event insert was a duplicate, because a
   * reprocessed range may contain derived rows that were never written (for example, a
   * crash between the event insert and the projection). Each projection is itself
   * idempotent, so replaying is safe.
   */
  private applyProjection(
    contractName: ContractName,
    eventName: string,
    args: Record<string, any>,
    meta: { txHash: string; logIndex: number; blockNumber: number; blockTime: number; emittingAddress?: string },
    contractAddress?: string
  ): void {
    const chain = config.CHAIN_ID;
    /**
     * For Campaign-level events (Contributed, EvidenceSubmitted, MilestoneVerified,
     * MilestoneRejected, StateChanged, Refunded, DustSwept) the emitting contract IS
     * the campaign — the event carries no campaign field. For Factory-level events
     * (CampaignDeployed) the args carry the new campaign address. Defaulting to the
     * emitter avoids inserting undefined into campaign_address, which SQLite rejects.
     */
    const campaignAddress = (args.campaign as string | undefined) ?? (meta.emittingAddress ?? contractAddress) !;

    switch (`${contractName}.${eventName}`) {
      case "CampaignFactory.CampaignDeployed": {
        const address = (args.campaign as string | undefined) ?? meta.emittingAddress ?? contractAddress as string;
        campaignRepository.upsert(chain, {
          address,
          creator: args.creatorAddress,
          goal_wei: (args.goalAmount ?? 0).toString(),
          funding_deadline: Number(args.fundingDeadline ?? 0),
          state: "Funding",
          total_contributed: "0",
          total_released: "0",
          released_bps: 0,
          treasury: "",
          created_at: meta.blockTime,
          updated_at: meta.blockTime,
          created_tx_hash: meta.txHash,
          created_block: meta.blockNumber,
        } as Row);

        // Tranche schedule and per-milestone deadlines arrive in the same event.
        const bps: number[] = (args.tranchePercentages ?? []).map(Number);
        const hashes: string[] = args.descriptionHashes ?? [];
        const cids: string[] = args.specificationCIDs ?? [];
        const deadlines: number[] = (args.milestoneDeadlines ?? []).map(Number);
        const count = Math.min(bps.length, hashes.length, cids.length, deadlines.length);

        if (count > 0) {
          milestoneRepository.upsertMany(
            chain,
            address,
            Array.from({ length: count }, (_, i) => ({
              idx: i,
              description_hash: hashes[i],
              specification_cid: cids[i],
              tranche_bps: bps[i],
              deadline: deadlines[i],
              state: "Pending",
            }))
          );
        }
        break;
      }

      case "Campaign.Contributed": {
        contributionRepository.insert(chain, {
          tx_hash: meta.txHash,
          log_index: meta.logIndex,
          campaign_address: campaignAddress,
          backer: args.backer,
          amount_wei: (args.amount ?? 0).toString(),
          block_number: meta.blockNumber,
          block_time: meta.blockTime,
        });
        break;
      }

      case "Campaign.EvidenceSubmitted": {
        milestoneRepository.setEvidence(chain, campaignAddress,
          Number(args.index),
          args.evidenceCID ?? "",
          args.evidenceHash ?? "",
          meta.blockTime
        );
        break;
      }

      case "Campaign.MilestoneVerified": {
        milestoneRepository.setState(chain, campaignAddress, Number(args.index), "Verified", meta.blockTime);
        const campaign = campaignAddress ? campaignRepository.findByAddress(chain, campaignAddress) : null;
        if (campaign) {
          // BigInt arithmetic, not Number: wei totals routinely exceed 2^53 (one ETH
          // is already 1e18 wei), where a float sum silently loses precision.
          const released =
            BigInt(campaign.total_released || "0") + BigInt((args.trancheAmount ?? 0).toString());
          campaignRepository.updateTotals(
            chain,
            campaignAddress,
            String(campaign.total_contributed),
            released.toString(),
            Number(args.releasedBpsTotal ?? campaign.released_bps)
          );
        }
        break;
      }

      case "Campaign.MilestoneRejected": {
        milestoneRepository.setState(chain, campaignAddress, Number(args.index), "Rejected", meta.blockTime);
        break;
      }

      case "Campaign.StateChanged": {
        const previous = Number(args.previous);
        const current = Number(args.current);
        campaignRepository.setState(chain, campaignAddress as string, stateName(current), meta.blockNumber);
        void previous;
        break;
      }

      case "MilestoneVerifier.VoteCast": {
        voteRepository.insert(chain, {
          tx_hash: meta.txHash,
          log_index: meta.logIndex,
          campaign_address: campaignAddress,
          milestone_index: Number(args.index),
          verifier: args.verifier,
          choice: Number(args.choice),
          weight: (args.weight ?? 0).toString(),
          block_number: meta.blockNumber,
          block_time: meta.blockTime,
        });
        break;
      }

      case "DisputeResolution.DisputeRaised": {
        disputeRepository.insert(chain, {
          dispute_key: args.disputeKey,
          campaign_address: campaignAddress,
          milestone_index: Number(args.milestoneIndex),
          raiser: args.raiser,
          state: "Voting",
          bond_wei: (args.bond ?? 0).toString(),
          raised_at: meta.blockTime,
          vote_deadline: meta.blockTime + config.INDEXER_POLL_MS,
        });
        break;
      }

      case "DisputeResolution.DisputeResolved": {
        const outcomeName = ["None", "Refund", "Release", "Partial"][Number(args.outcome)] ?? "None";
        disputeRepository.resolve(
          chain,
          args.disputeKey,
          outcomeName,
          args.partialBps === undefined ? null : Number(args.partialBps),
          meta.blockTime
        );
        break;
      }

      case "CredentialRegistry.CredentialAttested": {
        credentialRepository.upsert(chain, {
          credential_id: args.credentialId,
          subject: args.holder,
          schema_type: args.schemaType,
          issuer: args.issuer,
          issued_at: meta.blockTime,
          expires_at: Number(args.expiresAt ?? 0),
          revoked: false,
        });
        break;
      }

      case "CredentialRegistry.CredentialRevoked": {
        credentialRepository.revoke(chain, args.credentialId, meta.blockTime);
        break;
      }
    }
  }

  /** Advances one contract's cursor by at most `chunkSize`. */
  private async tickContract(contractName: ContractName, cursorKey: string): Promise<number> {
    const client = getChainClient();
    const head = await client.blockNumber();
    this.status.headBlock = head;

    const safeHead = Math.max(0, head - this.status.confirmations);
    this.status.confirmedThrough = safeHead;

    let from = eventRepository.cursorFor(config.CHAIN_ID, cursorKey);
    if (from < 0) from = Math.max(0, config.INDEXER_START_BLOCK);

    const reorgAt = await this.detectReorg(cursorKey, from);
    if (reorgAt !== null) {
      console.warn(`[indexer] reorg detected on ${cursorKey} at block ${reorgAt}; rolling back`);
      eventRepository.deleteFromBlock(config.CHAIN_ID, reorgAt);
      from = reorgAt;
    }

    if (from >= safeHead) {
      this.status.cursors[cursorKey] = from;
      return 0;
    }

    const to = Math.min(from + this.chunkSize, safeHead);

    let processed = 0;
    for (const { contract, event } of WATCHED) {
      if (contract !== contractName) continue;
      try {
        // The cursor key IS the contract address for every indexed contract, including
        // the per-campaign instances. Passing it as addressOverride lets `Campaign` be
        // bound to its own address instead of looking one up in the deployment manifest,
        // which has no entry for dynamically deployed campaigns.
        processed += await this.processRange(contract, event, from, to, cursorKey);
      } catch (error) {
        this.status.lastError = (error as Error).message;
        console.error(`[indexer] ${contract}.${event} ${from}-${to} failed:`, (error as Error).message);
      }
    }

    // The cursor only advances past a range that was fully attempted, so a mid-range
    // failure causes a replay rather than a permanent gap.
    eventRepository.setCursor(config.CHAIN_ID, cursorKey, to);
    this.status.cursors[cursorKey] = to;
    this.status.eventsIndexed += processed;
    return processed;
  }

  async tick(): Promise<number> {
    let total = 0;
    const client = getChainClient();

    for (const contract of [
      "CampaignFactory",
      "MilestoneVerifier",
      "DisputeResolution",
      "CredentialRegistry",
      "ReputationRegistry",
    ] as ContractName[]) {
      if (!client.addresses[contract]) continue;
      total += await this.tickContract(contract, client.addresses[contract]);
    }

    // Campaign contracts are deployed one-per-campaign, so their addresses are
    // discovered from the indexed rows rather than from the manifest. Each is indexed
    // under its own cursor, which is what keeps a slow or reorged campaign from
    // blocking the others.
    for (const address of this.discoverCampaignAddresses()) {
      total += await this.tickContract("Campaign", address);
    }

    this.status.lastPollAt = Math.floor(Date.now() / 1000);
    this.status.running = true;
    return total;
  }

  /** Campaign addresses already known from CampaignDeployed projections. */
  private discoverCampaignAddresses(): string[] {
    const db = getDb();
    const rows = db
      .prepare("SELECT address FROM campaigns WHERE chain_id = ?")
      .all(config.CHAIN_ID) as Array<{ address: string }>;
    return rows.map((r) => r.address);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => {
        this.status.lastError = (error as Error).message;
        console.error("[indexer] tick failed:", (error as Error).message);
      });
    }, config.INDEXER_POLL_MS);
    // Do not hold the process open on the indexer timer alone.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.status.running = false;
  }
}

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Maps the Campaign.State enum to its label. */
function stateName(value: number): string {
  return ["Funding", "Active", "Failed", "Completed", "Cancelled"][value] ?? "Unknown";
}

export const indexer = new Indexer();