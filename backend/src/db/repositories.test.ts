/**
 * Repository-layer tests.
 *
 * These assert the properties the indexer depends on for correctness, not just that
 * inserts work:
 *   - replaying the same log twice does not double-count (idempotency)
 *   - a reorg rollback removes every row derived from the orphaned block
 *   - the cursor survives a restart
 *   - foreign keys actually cascade (SQLite leaves FK enforcement off by default)
 *
 * Runs on `node:test` rather than Vitest: Vitest's Vite transform intercepts the
 * `node:sqlite` builtin specifier and fails to resolve it. `node:test` executes on the
 * same loader as production, so what is tested is what ships.
 */
import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeDb, getDb, transaction } from "./client.js";
import { migrate } from "./migrate.js";
import {
  campaignRepository,
  contributionRepository,
  eventRepository,
  milestoneRepository,
} from "./repositories.js";

const CHAIN = 31337;

beforeEach(() => {
  // Set the path BEFORE opening so each test gets an isolated in-memory database.
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  getDb();
  migrate();
});

describe("campaignRepository", () => {
  const base = {
    address: "0x1111111111111111111111111111111111111111",
    creator: "0x2222222222222222222222222222222222222222",
    goal_wei: "1000000000000000000",
    funding_deadline: 2_000_000_000,
    state: "Funding",
    total_contributed: "0",
    total_released: "0",
    released_bps: 0,
    treasury: "0x3333333333333333333333333333333333333333",
    created_at: 1_700_000_000,
    updated_at: 1_700_000_000,
    created_tx_hash: "0xabc",
    created_block: 100,
  };

  it("inserts and reads back a campaign", () => {
    campaignRepository.upsert(CHAIN, base);
    const found = campaignRepository.findByAddress(CHAIN, base.address);
    assert.ok(found, "campaign should be found");
    assert.strictEqual(found!.creator, base.creator);
    assert.strictEqual(found!.goal_wei, base.goal_wei);
  });

  it("returns null for an unknown address", () => {
    assert.strictEqual(campaignRepository.findByAddress(CHAIN, "0xdead"), null);
  });

  it("updates on conflict rather than duplicating", () => {
    campaignRepository.upsert(CHAIN, base);
    campaignRepository.upsert(CHAIN, { ...base, state: "Active" });
    const rows = campaignRepository.list(CHAIN, { limit: 10, offset: 0 });
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].state, "Active");
  });

  it("filters by state", () => {
    campaignRepository.upsert(CHAIN, base);
    campaignRepository.upsert(CHAIN, {
      ...base,
      address: "0x4444444444444444444444444444444444444444",
      state: "Active",
    });
    assert.strictEqual(campaignRepository.count(CHAIN), 2);
    assert.strictEqual(campaignRepository.count(CHAIN, "Active"), 1);
    assert.strictEqual(
      campaignRepository.list(CHAIN, { limit: 10, offset: 0, state: "Active" }).length,
      1
    );
  });

  it("paginates with limit and offset", () => {
    for (let i = 0; i < 5; i++) {
      campaignRepository.upsert(CHAIN, {
        ...base,
        address: `0x${String(i).padStart(40, "0")}`,
        created_at: 1_700_000_000 + i,
      });
    }
    const page1 = campaignRepository.list(CHAIN, { limit: 2, offset: 0 });
    const page2 = campaignRepository.list(CHAIN, { limit: 2, offset: 2 });
    assert.strictEqual(page1.length, 2);
    assert.strictEqual(page2.length, 2);
    assert.notStrictEqual(page1[0].address, page2[0].address);
  });

  it("scopes by chain id so the same address on two chains is distinct", () => {
    campaignRepository.upsert(CHAIN, base);
    campaignRepository.upsert(11155111, { ...base, state: "Completed" });
    assert.strictEqual(campaignRepository.count(CHAIN), 1);
    assert.strictEqual(campaignRepository.count(11155111), 1);
    assert.strictEqual(campaignRepository.findByAddress(CHAIN, base.address)!.state, "Funding");
    assert.strictEqual(campaignRepository.findByAddress(11155111, base.address)!.state, "Completed");
  });
});

describe("milestoneRepository", () => {
  const campaign = {
    address: "0xaaaa000000000000000000000000000000000001",
    creator: "0xbbbb000000000000000000000000000000000001",
    goal_wei: "1",
    funding_deadline: 2_000_000_000,
    state: "Active",
    treasury: "0xcccc000000000000000000000000000000000001",
    created_at: 1,
    updated_at: 1,
  };

  it("cascades deletes from campaign to milestones", () => {
    campaignRepository.upsert(CHAIN, campaign);
    milestoneRepository.upsertMany(CHAIN, campaign.address, [
      { idx: 0, description_hash: "0x01", specification_cid: "cid0", tranche_bps: 4000, deadline: 1 },
      { idx: 1, description_hash: "0x02", specification_cid: "cid1", tranche_bps: 6000, deadline: 2 },
    ]);
    assert.strictEqual(milestoneRepository.listByCampaign(CHAIN, campaign.address).length, 2);

    getDb()
      .prepare("DELETE FROM campaigns WHERE chain_id = ? AND address = ?")
      .run(CHAIN, campaign.address);

    // Proves PRAGMA foreign_keys = ON is actually in force.
    assert.strictEqual(milestoneRepository.listByCampaign(CHAIN, campaign.address).length, 0);
  });

  it("upserts milestones idempotently", () => {
    campaignRepository.upsert(CHAIN, campaign);
    const rows = [
      { idx: 0, description_hash: "0x01", specification_cid: "cid0", tranche_bps: 4000, deadline: 1 },
    ];
    milestoneRepository.upsertMany(CHAIN, campaign.address, rows);
    milestoneRepository.upsertMany(CHAIN, campaign.address, rows);
    assert.strictEqual(milestoneRepository.listByCampaign(CHAIN, campaign.address).length, 1);
  });

  it("records evidence and transitions state", () => {
    campaignRepository.upsert(CHAIN, campaign);
    milestoneRepository.upsertMany(CHAIN, campaign.address, [
      { idx: 0, description_hash: "0x01", specification_cid: "cid0", tranche_bps: 4000, deadline: 1 },
    ]);

    milestoneRepository.setEvidence(CHAIN, campaign.address, 0, "QmEvidence", "0xhash", 1234);
    let m = milestoneRepository.listByCampaign(CHAIN, campaign.address)[0];
    assert.strictEqual(m.state, "Submitted");
    assert.strictEqual(m.evidence_cid, "QmEvidence");

    milestoneRepository.setState(CHAIN, campaign.address, 0, "Verified", 5678);
    m = milestoneRepository.listByCampaign(CHAIN, campaign.address)[0];
    assert.strictEqual(m.state, "Verified");
    assert.strictEqual(m.resolved_at, 5678);
  });
});

describe("contributionRepository idempotency", () => {
  const contribution = {
    tx_hash: "0xtx1",
    log_index: 0,
    campaign_address: "0xaaaa000000000000000000000000000000000002",
    backer: "0xdddd000000000000000000000000000000000001",
    amount_wei: "1000000000000000000",
    block_number: 150,
    block_time: 1_700_000_100,
  };

  it("inserts once and ignores a replay of the same log", () => {
    const first = contributionRepository.insert(CHAIN, contribution);
    const second = contributionRepository.insert(CHAIN, contribution);

    assert.strictEqual(first, true);
    // The whole point: a re-scan must not double-count, or totals inflate silently.
    assert.strictEqual(second, false);
    assert.strictEqual(
      contributionRepository.listByCampaign(CHAIN, contribution.campaign_address).length,
      1
    );
  });

  it("treats a different log index in the same tx as a distinct contribution", () => {
    contributionRepository.insert(CHAIN, contribution);
    contributionRepository.insert(CHAIN, { ...contribution, log_index: 1, amount_wei: "2" });
    assert.strictEqual(
      contributionRepository.listByCampaign(CHAIN, contribution.campaign_address).length,
      2
    );
  });

  it("sums contributions per campaign and lists by backer", () => {
    contributionRepository.insert(CHAIN, contribution);
    contributionRepository.insert(CHAIN, {
      ...contribution,
      log_index: 1,
      amount_wei: "3000000000000000000",
      backer: "0xdddd000000000000000000000000000000000002",
    });

    assert.strictEqual(
      contributionRepository.sumByCampaign(CHAIN, contribution.campaign_address),
      "4000000000000000000"
    );
    assert.strictEqual(contributionRepository.listByBacker(CHAIN, contribution.backer).length, 1);
  });

  it("sums wei exactly beyond the JS safe-integer range", () => {
    // 1e19 wei is ~10 ETH. Number.MAX_SAFE_INTEGER is ~9.007e15, so a float-based SUM
    // would return an imprecise total here. Values are stored as TEXT and summed as
    // BigInt precisely to avoid that.
    contributionRepository.insert(CHAIN, { ...contribution, log_index: 0, amount_wei: "10000000000000000000" });
    contributionRepository.insert(CHAIN, { ...contribution, log_index: 1, amount_wei: "1" });

    assert.strictEqual(
      contributionRepository.sumByCampaign(CHAIN, contribution.campaign_address),
      "10000000000000000001"
    );
  });

  it("returns an empty set for an unknown campaign", () => {
    assert.strictEqual(contributionRepository.listByCampaign(CHAIN, "0xnope").length, 0);
  });
});

describe("eventRepository: cursor and reorg handling", () => {
  const makeEvent = (block: number, logIndex: number) => ({
    tx_hash: `0xtx${block}`,
    log_index: logIndex,
    contract: "0xfactory",
    event_name: "Contribution",
    campaign_address: "0xcamp",
    actor: "0xbacker",
    block_number: block,
    block_time: 1_700_000_000 + block,
    args: { value: "1" },
    confirmed: 0,
  });

  it("deduplicates events by (tx_hash, log_index)", () => {
    assert.strictEqual(eventRepository.insert(CHAIN, makeEvent(10, 0)), true);
    assert.strictEqual(eventRepository.insert(CHAIN, makeEvent(10, 0)), false);
  });

  it("marks events confirmed up to a block height", () => {
    eventRepository.insert(CHAIN, makeEvent(10, 0));
    eventRepository.insert(CHAIN, makeEvent(11, 0));
    eventRepository.insert(CHAIN, makeEvent(12, 0));

    const marked = eventRepository.markConfirmedUpTo(CHAIN, 11);
    assert.strictEqual(marked, 2);

    const rows = getDb()
      .prepare("SELECT block_number, confirmed FROM events WHERE chain_id = ? ORDER BY block_number")
      .all(CHAIN) as any[];
    assert.deepStrictEqual(rows.map((r) => Number(r.confirmed)), [1, 1, 0]);
  });

  it("rolls back every event from an orphaned block and rewinds the cursor", () => {
    for (let b = 10; b <= 15; b++) eventRepository.insert(CHAIN, makeEvent(b, 0));
    eventRepository.setCursor(CHAIN, "0xfactory", 15);

    // Chain reorgs: block 13 is gone.
    const deleted = eventRepository.deleteFromBlock(CHAIN, 13);
    assert.strictEqual(deleted, 3); // blocks 13, 14, 15

    const remaining = getDb()
      .prepare("SELECT COUNT(*) AS n FROM events WHERE chain_id = ?")
      .get(CHAIN) as { n: number };
    assert.strictEqual(Number(remaining.n), 3); // blocks 10, 11, 12

    // Cursor must be rewound so the next scan re-reads from the orphaned range.
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xfactory"), 12);
  });

  it("persists the cursor to disk so a restart resumes instead of rescanning", () => {
    // Uses a real file rather than :memory:, because an in-memory database is
    // discarded on close and cannot demonstrate persistence at all.
    const dir = mkdtempSync(join(tmpdir(), "cursor-test-"));
    const file = join(dir, "restart.db");

    process.env.DATABASE_PATH = file;
    closeDb();
    getDb();
    migrate();

    eventRepository.setCursor(CHAIN, "0xfactory", 42);
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xfactory"), 42);
    closeDb();

    // Simulate a process restart: fresh connection to the same file.
    getDb();
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xfactory"), 42);

    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns -1 for a contract that has never been indexed", () => {
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xnever"), -1);
  });

  it("keeps cursors independent per contract", () => {
    eventRepository.setCursor(CHAIN, "0xa", 10);
    eventRepository.setCursor(CHAIN, "0xb", 20);
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xa"), 10);
    assert.strictEqual(eventRepository.cursorFor(CHAIN, "0xb"), 20);
  });
});

describe("transaction helper", () => {
  it("rolls back on error", () => {
    campaignRepository.upsert(CHAIN, {
      address: "0xrollback",
      creator: "0x1",
      goal_wei: "1",
      funding_deadline: 1,
      state: "Funding",
      treasury: "0x2",
      created_at: 1,
      updated_at: 1,
    } as any);

    assert.throws(() => {
      transaction(() => {
        getDb().prepare("DELETE FROM campaigns WHERE address = ?").run("0xrollback");
        throw new Error("boom");
      });
    }, /boom/);

    // The delete must have been rolled back.
    assert.ok(campaignRepository.findByAddress(CHAIN, "0xrollback"));
  });
});