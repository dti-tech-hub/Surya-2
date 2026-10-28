/**
 * Repository layer.
 *
 * WHY A REPOSITORY LAYER
 * ----------------------
 * Every SQL statement in the application lives in this directory. Routes, the indexer,
 * and the ML feature extractor talk to these interfaces, never to `DatabaseSync`
 * directly. That is the seam that makes the engine swappable: migrating to PostgreSQL
 * means writing new implementations of these interfaces, not rewriting the API.
 *
 * The interfaces are intentionally expressed in terms of domain types rather than SQL
 * row shapes, so a different backend does not leak its idioms into the callers.
 *
 * Single-writer note: SQLite serialises writes, so the indexer is designed as one
 * process (see docs/DECISIONS.md, D-009). These repositories do not attempt to make
 * concurrent writers safe; that is a property of the storage engine's locking, not of
 * this code.
 */
import { getDb, transaction } from "./client.js";

export type Row = Record<string, any>;

/** Converts a bigint column to a decimal string. */
function bigintToString(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

/**
 * Sum of a TEXT column of decimal strings, computed exactly.
 *
 * WHY NOT `SUM(CAST(col AS INTEGER))`
 * -----------------------------------
 * Wei amounts routinely exceed Number.MAX_SAFE_INTEGER (2^53-1 ~= 9.007e15). One ETH
 * is already 1e18 wei, so a campaign holding 10 ETH overflows a JS number. SQLite's
 * SUM() over an INTEGER column returns a float, which silently loses precision above
 * 2^53 — a campaign total that is off by a few wei would be reported as exact, and the
 * dApp would show a wrong funded amount.
 *
 * Instead the column is declared TEXT and summed as a BigInt in JS, which is exact to
 * arbitrarily large magnitudes. The cost is that summation happens in JS rather than
 * SQL, so this is only appropriate for aggregates over a single campaign's
 * contributions, not unbounded table scans. That is the only place it is used.
 */
function sumDecimalStrings(values: Array<string | number | bigint | null>): string {
  let total = 0n;
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    total += BigInt(value.toString());
  }
  return total.toString();
}

export interface CampaignRepository {
  upsert(chainId: number, campaign: Row): void;
  findByAddress(chainId: number, address: string): Row | null;
  list(chainId: number, opts: { limit: number; offset: number; state?: string }): Row[];
  count(chainId: number, state?: string): number;
  setState(chainId: number, address: string, state: string, blockNumber: number): void;
  updateTotals(chainId: number, address: string, contributed: string, released: string, releasedBps: number): void;
}

export const campaignRepository: CampaignRepository = {
  upsert(chainId, campaign) {
    const db = getDb();
    db.prepare(
      `INSERT INTO campaigns (
         chain_id, address, creator, goal_wei, funding_deadline, state,
         total_contributed, total_released, released_bps, treasury,
         created_at, updated_at, created_tx_hash, created_block
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, address) DO UPDATE SET
         goal_wei         = excluded.goal_wei,
         funding_deadline = excluded.funding_deadline,
         state            = excluded.state,
         total_contributed= excluded.total_contributed,
         total_released   = excluded.total_released,
         released_bps     = excluded.released_bps,
         treasury         = excluded.treasury,
         updated_at       = excluded.updated_at`
    ).run(
      chainId,
      campaign.address,
      campaign.creator,
      campaign.goal_wei,
      campaign.funding_deadline,
      campaign.state ?? "Funding",
      campaign.total_contributed ?? "0",
      campaign.total_released ?? "0",
      campaign.released_bps ?? 0,
      campaign.treasury ?? "",
      campaign.created_at,
      campaign.updated_at ?? campaign.created_at,
      campaign.created_tx_hash ?? null,
      campaign.created_block ?? null
    );
  },

  findByAddress(chainId, address) {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM campaigns WHERE chain_id = ? AND address = ?")
      .get(chainId, address) as Row | undefined;
    return row ?? null;
  },

  list(chainId, { limit, offset, state }) {
    const db = getDb();
    const base =
      state === undefined
        ? "SELECT * FROM campaigns WHERE chain_id = ?"
        : "SELECT * FROM campaigns WHERE chain_id = ? AND state = ?";
    const params = state === undefined ? [chainId, limit, offset] : [chainId, state, limit, offset];
    const order = " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    return db.prepare(base + order).all(...params) as Row[];
  },

  count(chainId, state) {
    const db = getDb();
    const sql =
      state === undefined
        ? "SELECT COUNT(*) AS n FROM campaigns WHERE chain_id = ?"
        : "SELECT COUNT(*) AS n FROM campaigns WHERE chain_id = ? AND state = ?";
    const params = state === undefined ? [chainId] : [chainId, state];
    const row = db.prepare(sql).get(...params) as { n: number };
    return Number(row.n);
  },

  setState(chainId, address, state, _blockNumber) {
    const db = getDb();
    db.prepare(
      "UPDATE campaigns SET state = ?, updated_at = ? WHERE chain_id = ? AND address = ?"
    ).run(state, Math.floor(Date.now() / 1000), chainId, address);
  },

  updateTotals(chainId, address, contributed, released, releasedBps) {
    const db = getDb();
    db.prepare(
      `UPDATE campaigns
         SET total_contributed = ?, total_released = ?, released_bps = ?, updated_at = ?
       WHERE chain_id = ? AND address = ?`
    ).run(contributed, released, releasedBps, Math.floor(Date.now() / 1000), chainId, address);
  },
};

export interface MilestoneRepository {
  upsertMany(chainId: number, campaignAddress: string, milestones: Row[]): void;
  listByCampaign(chainId: number, campaignAddress: string): Row[];
  setEvidence(chainId: number, campaignAddress: string, idx: number, cid: string, hash: string, submittedAt: number): void;
  setState(chainId: number, campaignAddress: string, idx: number, state: string, resolvedAt: number): void;
}

export const milestoneRepository: MilestoneRepository = {
  upsertMany(chainId, campaignAddress, milestones) {
    const db = getDb();
    const stmt = db.prepare(
      `INSERT INTO milestones (
         chain_id, campaign_address, idx, description_hash, specification_cid,
         tranche_bps, deadline, state
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, campaign_address, idx) DO UPDATE SET
         description_hash  = excluded.description_hash,
         specification_cid = excluded.specification_cid,
         tranche_bps       = excluded.tranche_bps,
         deadline          = excluded.deadline`
    );
    transaction(() => {
      for (const m of milestones) {
        stmt.run(
          chainId,
          campaignAddress,
          m.idx,
          m.description_hash,
          m.specification_cid ?? "",
          m.tranche_bps,
          m.deadline,
          m.state ?? "Pending"
        );
      }
    });
  },

  listByCampaign(chainId, campaignAddress) {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM milestones WHERE chain_id = ? AND campaign_address = ? ORDER BY idx"
      )
      .all(chainId, campaignAddress) as Row[];
  },

  setEvidence(chainId, campaignAddress, idx, cid, hash, submittedAt) {
    const db = getDb();
    db.prepare(
      `UPDATE milestones
         SET evidence_cid = ?, evidence_hash = ?, submitted_at = ?, state = 'Submitted'
       WHERE chain_id = ? AND campaign_address = ? AND idx = ?`
    ).run(cid, hash, submittedAt, chainId, campaignAddress, idx);
  },

  setState(chainId, campaignAddress, idx, state, resolvedAt) {
    const db = getDb();
    db.prepare(
      "UPDATE milestones SET state = ?, resolved_at = ? WHERE chain_id = ? AND campaign_address = ? AND idx = ?"
    ).run(state, resolvedAt, chainId, campaignAddress, idx);
  },
};

export interface ContributionRepository {
  /** Idempotent on (chain_id, tx_hash, log_index) so replaying logs is safe. */
  insert(chainId: number, contribution: Row): boolean;
  listByCampaign(chainId: number, campaignAddress: string): Row[];
  listByBacker(chainId: number, backer: string): Row[];
  sumByCampaign(chainId: number, campaignAddress: string): string;
}

export const contributionRepository: ContributionRepository = {
  insert(chainId, c) {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO contributions (
           chain_id, tx_hash, log_index, campaign_address, backer,
           amount_wei, block_number, block_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chainId,
        c.tx_hash,
        c.log_index,
        c.campaign_address,
        c.backer,
        c.amount_wei,
        c.block_number,
        c.block_time
      );
    // changes === 0 means the row already existed: the log was a replay.
    return Number(result.changes) > 0;
  },

  listByCampaign(chainId, campaignAddress) {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM contributions WHERE chain_id = ? AND campaign_address = ? ORDER BY block_number, log_index"
      )
      .all(chainId, campaignAddress) as Row[];
  },

  listByBacker(chainId, backer) {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM contributions WHERE chain_id = ? AND backer = ? ORDER BY block_number DESC"
      )
      .all(chainId, backer) as Row[];
  },

  sumByCampaign(chainId, campaignAddress) {
    const db = getDb();
    const rows = db
      .prepare(
        "SELECT amount_wei FROM contributions WHERE chain_id = ? AND campaign_address = ?"
      )
      .all(chainId, campaignAddress) as Array<{ amount_wei: string }>;
    return sumDecimalStrings(rows.map((r) => r.amount_wei));
  },
};

export interface VoteRepository {
  insert(chainId: number, vote: Row): boolean;
  listByMilestone(chainId: number, campaignAddress: string, milestoneIndex: number): Row[];
}

export const voteRepository: VoteRepository = {
  insert(chainId, v) {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO votes (
           chain_id, tx_hash, log_index, campaign_address, milestone_index,
           verifier, choice, weight, block_number, block_time
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chainId,
        v.tx_hash,
        v.log_index,
        v.campaign_address,
        v.milestone_index,
        v.verifier,
        v.choice,
        v.weight,
        v.block_number,
        v.block_time
      );
    return Number(result.changes) > 0;
  },

  listByMilestone(chainId, campaignAddress, milestoneIndex) {
    const db = getDb();
    return db
      .prepare(
        "SELECT * FROM votes WHERE chain_id = ? AND campaign_address = ? AND milestone_index = ? ORDER BY block_number"
      )
      .all(chainId, campaignAddress, milestoneIndex) as Row[];
  },
};

export interface DisputeRepository {
  insert(chainId: number, dispute: Row): boolean;
  resolve(chainId: number, disputeKey: string, outcome: string, partialBps: number | null, resolvedAt: number): void;
  findByKey(chainId: number, disputeKey: string): Row | null;
  listByCampaign(chainId: number, campaignAddress: string): Row[];
}

export const disputeRepository: DisputeRepository = {
  insert(chainId, d) {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO disputes (
           chain_id, dispute_key, campaign_address, milestone_index, raiser,
           state, bond_wei, raised_at, vote_deadline
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chainId,
        d.dispute_key,
        d.campaign_address,
        d.milestone_index,
        d.raiser,
        d.state ?? "Voting",
        d.bond_wei ?? "0",
        d.raised_at,
        d.vote_deadline
      );
    return Number(result.changes) > 0;
  },

  resolve(chainId, disputeKey, outcome, partialBps, resolvedAt) {
    const db = getDb();
    db.prepare(
      "UPDATE disputes SET state = 'Resolved', outcome = ?, partial_bps = ?, resolved_at = ? WHERE chain_id = ? AND dispute_key = ?"
    ).run(outcome, partialBps, resolvedAt, chainId, disputeKey);
  },

  findByKey(chainId, disputeKey) {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM disputes WHERE chain_id = ? AND dispute_key = ?")
      .get(chainId, disputeKey) as Row | undefined;
    return row ?? null;
  },

  listByCampaign(chainId, campaignAddress) {
    const db = getDb();
    return db
      .prepare("SELECT * FROM disputes WHERE chain_id = ? AND campaign_address = ? ORDER BY raised_at DESC")
      .all(chainId, campaignAddress) as Row[];
  },
};

export interface EventRepository {
  /** Idempotent on (chain_id, tx_hash, log_index). */
  insert(chainId: number, event: Row): boolean;
  markConfirmedUpTo(chainId: number, blockNumber: number): number;
  deleteFromBlock(chainId: number, blockNumber: number): number;
  cursorFor(chainId: number, contract: string): number;
  cursorHashFor(chainId: number, contract: string, blockNumber: number): string | null;
  setCursor(chainId: number, contract: string, blockNumber: number, blockHash?: string | null): void;
  /**
   * Clears all derived rows and cursors for a chain. Called after a reorg that is deeper
   * than the confirmation window: rebuilding from scratch is slower than a targeted
   * rollback, but it cannot leave a partially-rewound projection (stale campaign totals,
   * milestone states, dispute rows) behind.
   */
  resetAll(chainId: number): void;
}

export const eventRepository: EventRepository = {
  insert(chainId, e) {
    const db = getDb();
    const result = db
      .prepare(
        `INSERT OR IGNORE INTO events (
           chain_id, tx_hash, log_index, contract, event_name,
           campaign_address, actor, block_number, block_hash, block_time,
           args_json, confirmed
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chainId,
        e.tx_hash,
        e.log_index,
        e.contract,
        e.event_name,
        e.campaign_address ?? null,
        e.actor ?? null,
        e.block_number,
        e.block_hash ?? null,
        e.block_time,
        JSON.stringify(e.args ?? {}),
        e.confirmed ?? 0
      );
    return Number(result.changes) > 0;
  },

  markConfirmedUpTo(chainId, blockNumber) {
    const db = getDb();
    const result = db
      .prepare("UPDATE events SET confirmed = 1 WHERE chain_id = ? AND block_number <= ? AND confirmed = 0")
      .run(chainId, blockNumber);
    return Number(result.changes);
  },

  /**
   * Deletes every row derived from a block at or above `blockNumber`, then rewinds the
   * cursors. The raw event log alone is not enough: contributions and votes carry the
   * block number, while disputes and credentials carry the block timestamp, so both are
   * used to find orphaned derived rows.
   */
  deleteFromBlock(chainId, blockNumber) {
    const db = getDb();
    return transaction(() => {
      const cutoff = db
        .prepare(
          "SELECT MIN(block_time) AS t FROM events WHERE chain_id = ? AND block_number >= ?"
        )
        .get(chainId, blockNumber) as { t: number | null } | undefined;
      const cutoffTime = cutoff?.t ?? null;

      db.prepare(
        "DELETE FROM contributions WHERE chain_id = ? AND block_number >= ?"
      ).run(chainId, blockNumber);
      db.prepare("DELETE FROM votes WHERE chain_id = ? AND block_number >= ?").run(
        chainId,
        blockNumber
      );

      if (cutoffTime !== null) {
        db.prepare(
          "DELETE FROM disputes WHERE chain_id = ? AND raised_at >= ?"
        ).run(chainId, cutoffTime);
        db.prepare(
          "DELETE FROM credentials WHERE chain_id = ? AND issued_at >= ?"
        ).run(chainId, cutoffTime);
      }

      // Campaigns created in the orphaned range lose all their children via the
      // ON DELETE CASCADE foreign key. Campaigns created earlier keep their identity but
      // may hold stale totals; those are repaired by resetAll() on a deep reorg.
      db.prepare(
        "DELETE FROM campaigns WHERE chain_id = ? AND created_block >= ?"
      ).run(chainId, blockNumber);
      db.prepare("DELETE FROM reputation_cache WHERE chain_id = ?").run(chainId);

      const result = db
        .prepare("DELETE FROM events WHERE chain_id = ? AND block_number >= ?")
        .run(chainId, blockNumber);
      db.prepare(
        "UPDATE indexer_cursor SET last_block = ?, last_block_hash = NULL, updated_at = ? WHERE chain_id = ? AND last_block >= ?"
      ).run(blockNumber - 1, Math.floor(Date.now() / 1000), chainId, blockNumber);
      return Number(result.changes);
    });
  },

  cursorFor(chainId, contract) {
    const db = getDb();
    const row = db
      .prepare("SELECT last_block FROM indexer_cursor WHERE chain_id = ? AND contract = ?")
      .get(chainId, contract) as { last_block: number } | undefined;
    return row ? Number(row.last_block) : -1;
  },

  cursorHashFor(chainId, contract, blockNumber) {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT last_block, last_block_hash FROM indexer_cursor WHERE chain_id = ? AND contract = ?"
      )
      .get(chainId, contract) as
      | { last_block: number; last_block_hash: string | null }
      | undefined;
    if (!row || Number(row.last_block) !== blockNumber) return null;
    return row.last_block_hash;
  },

  setCursor(chainId, contract, blockNumber, blockHash = null) {
    const db = getDb();
    db.prepare(
      `INSERT INTO indexer_cursor (chain_id, contract, last_block, last_block_hash, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, contract) DO UPDATE SET
         last_block      = excluded.last_block,
         last_block_hash = excluded.last_block_hash,
         updated_at      = excluded.updated_at`
    ).run(chainId, contract, blockNumber, blockHash, Math.floor(Date.now() / 1000));
  },

  resetAll(chainId) {
    const db = getDb();
    transaction(() => {
      // Children first so the cascade path is not required for correctness.
      db.prepare("DELETE FROM milestones WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM contributions WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM votes WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM disputes WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM credentials WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM reputation_cache WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM campaigns WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM events WHERE chain_id = ?").run(chainId);
      db.prepare("DELETE FROM indexer_cursor WHERE chain_id = ?").run(chainId);
    });
  },
};

export interface ReputationCacheRepository {
  set(chainId: number, subject: string, scoreBps: number, tier: string): void;
  get(chainId: number, subject: string): Row | null;
}

export const reputationCacheRepository: ReputationCacheRepository = {
  set(chainId, subject, scoreBps, tier) {
    const db = getDb();
    db.prepare(
      `INSERT INTO reputation_cache (chain_id, subject, score_bps, tier, fetched_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, subject) DO UPDATE SET
         score_bps = excluded.score_bps,
         tier      = excluded.tier,
         fetched_at= excluded.fetched_at`
    ).run(chainId, subject, scoreBps, tier, Math.floor(Date.now() / 1000));
  },

  get(chainId, subject) {
    const db = getDb();
    const row = db
      .prepare("SELECT * FROM reputation_cache WHERE chain_id = ? AND subject = ?")
      .get(chainId, subject) as Row | undefined;
    return row ?? null;
  },
};

export interface CredentialRepository {
  upsert(chainId: number, credential: Row): void;
  revoke(chainId: number, credentialId: string, revokedAt: number): void;
  findBySubject(chainId: number, subject: string): Row[];
  isValid(chainId: number, subject: string, schemaType: string): boolean;
}

export const credentialRepository: CredentialRepository = {
  upsert(chainId, c) {
    const db = getDb();
    db.prepare(
      `INSERT INTO credentials (
         chain_id, credential_id, subject, schema_type, issuer,
         issued_at, expires_at, revoked
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_id, credential_id) DO UPDATE SET
         expires_at = excluded.expires_at,
         revoked    = excluded.revoked`
    ).run(
      chainId,
      c.credential_id,
      c.subject,
      c.schema_type,
      c.issuer,
      c.issued_at,
      c.expires_at,
      c.revoked ? 1 : 0
    );
  },

  revoke(chainId, credentialId, revokedAt) {
    const db = getDb();
    db.prepare(
      "UPDATE credentials SET revoked = 1, revoked_at = ? WHERE chain_id = ? AND credential_id = ?"
    ).run(revokedAt, chainId, credentialId);
  },

  findBySubject(chainId, subject) {
    const db = getDb();
    return db
      .prepare("SELECT * FROM credentials WHERE chain_id = ? AND subject = ?")
      .all(chainId, subject) as Row[];
  },

  isValid(chainId, subject, schemaType) {
    const db = getDb();
    const now = Math.floor(Date.now() / 1000);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM credentials
          WHERE chain_id = ? AND subject = ? AND schema_type = ?
            AND revoked = 0 AND expires_at > ?`
      )
      .get(chainId, subject, schemaType, now) as { n: number };
    return Number(row.n) > 0;
  },
};