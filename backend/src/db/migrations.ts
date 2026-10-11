/**
 * Versioned schema migrations.
 *
 * Migrations are an ordered, append-only list. Each runs exactly once and is recorded in
 * `schema_migrations`. Never edit a migration that has been applied: add a new one. That
 * rule is what lets a deployed environment upgrade without losing data.
 *
 * Indexing strategy (the spec asks for indexes on campaignId, address, blockNumber):
 *   - Every table is keyed by (chain_id, contract, tx_hash, log_index) or by its natural
 *     primary key, because the indexer upserts on those.
 *   - campaign_id and address get secondary indexes because the API filters by them.
 *   - block_number is indexed so the indexer can efficiently find "everything after the
 *     last processed block" and so reorg rollback can delete a range quickly.
 */

export interface Migration {
  id: number;
  name: string;
  up: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    name: "initial_schema",
    up: `
    ------------------------------------------------------------------
    -- Campaigns
    ------------------------------------------------------------------
    CREATE TABLE campaigns (
      chain_id            INTEGER NOT NULL,
      address             TEXT    NOT NULL,
      creator             TEXT    NOT NULL,
      goal_wei            TEXT    NOT NULL,
      funding_deadline    INTEGER NOT NULL,
      state               TEXT    NOT NULL,
      total_contributed   TEXT    NOT NULL DEFAULT '0',
      total_released      TEXT    NOT NULL DEFAULT '0',
      released_bps        INTEGER NOT NULL DEFAULT 0,
      treasury            TEXT    NOT NULL DEFAULT '',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL,
      created_tx_hash     TEXT,
      created_block       INTEGER,
      PRIMARY KEY (chain_id, address)
    );
    CREATE INDEX idx_campaigns_creator   ON campaigns (chain_id, creator);
    CREATE INDEX idx_campaigns_state     ON campaigns (chain_id, state);
    CREATE INDEX idx_campaigns_block     ON campaigns (created_block);
    CREATE INDEX idx_campaigns_created_at ON campaigns (created_at DESC);

    ------------------------------------------------------------------
    -- Milestones (child of campaigns; ON DELETE CASCADE proves the
    -- FK enforcement that SQLite leaves off by default)
    ------------------------------------------------------------------
    CREATE TABLE milestones (
      chain_id          INTEGER NOT NULL,
      campaign_address  TEXT    NOT NULL,
      idx               INTEGER NOT NULL,
      description_hash  TEXT    NOT NULL,
      specification_cid TEXT    NOT NULL DEFAULT '',
      tranche_bps       INTEGER NOT NULL,
      deadline          INTEGER NOT NULL,
      state             TEXT    NOT NULL DEFAULT 'Pending',
      evidence_hash     TEXT,
      evidence_cid      TEXT,
      submitted_at      INTEGER,
      resolved_at       INTEGER,
      PRIMARY KEY (chain_id, campaign_address, idx),
      FOREIGN KEY (chain_id, campaign_address)
        REFERENCES campaigns (chain_id, address) ON DELETE CASCADE
    );
    CREATE INDEX idx_milestones_campaign ON milestones (chain_id, campaign_address);
    CREATE INDEX idx_milestones_state    ON milestones (chain_id, state);
    CREATE INDEX idx_milestones_deadline ON milestones (deadline);

    ------------------------------------------------------------------
    -- Contributions
    ------------------------------------------------------------------
    CREATE TABLE contributions (
      chain_id          INTEGER NOT NULL,
      tx_hash           TEXT    NOT NULL,
      log_index         INTEGER NOT NULL,
      campaign_address  TEXT    NOT NULL,
      backer            TEXT    NOT NULL,
      amount_wei        TEXT    NOT NULL,
      block_number      INTEGER NOT NULL,
      block_time        INTEGER NOT NULL,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
    CREATE INDEX idx_contributions_campaign ON contributions (chain_id, campaign_address);
    CREATE INDEX idx_contributions_backer   ON contributions (chain_id, backer);
    CREATE INDEX idx_contributions_block    ON contributions (block_number);

    ------------------------------------------------------------------
    -- Verifier votes
    ------------------------------------------------------------------
    CREATE TABLE votes (
      chain_id       INTEGER NOT NULL,
      tx_hash        TEXT    NOT NULL,
      log_index      INTEGER NOT NULL,
      campaign_address TEXT  NOT NULL,
      milestone_index  INTEGER NOT NULL,
      verifier         TEXT  NOT NULL,
      choice           INTEGER NOT NULL,
      weight           TEXT  NOT NULL,
      block_number     INTEGER NOT NULL,
      block_time       INTEGER NOT NULL,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
    CREATE INDEX idx_votes_campaign ON votes (chain_id, campaign_address, milestone_index);
    CREATE INDEX idx_votes_verifier ON votes (chain_id, verifier);
    CREATE INDEX idx_votes_block    ON votes (block_number);

    ------------------------------------------------------------------
    -- Disputes
    ------------------------------------------------------------------
    CREATE TABLE disputes (
      chain_id          INTEGER NOT NULL,
      dispute_key       TEXT    NOT NULL,
      campaign_address  TEXT    NOT NULL,
      milestone_index   INTEGER NOT NULL,
      raiser            TEXT    NOT NULL,
      state             TEXT    NOT NULL DEFAULT 'Voting',
      outcome           TEXT,
      partial_bps       INTEGER,
      bond_wei          TEXT    NOT NULL DEFAULT '0',
      raised_at         INTEGER NOT NULL,
      vote_deadline     INTEGER NOT NULL,
      resolved_at       INTEGER,
      PRIMARY KEY (chain_id, dispute_key)
    );
    CREATE INDEX idx_disputes_campaign ON disputes (chain_id, campaign_address);
    CREATE INDEX idx_disputes_raiser  ON disputes (chain_id, raiser);
    CREATE INDEX idx_disputes_state    ON disputes (chain_id, state);

    ------------------------------------------------------------------
    -- Reputation snapshot cache (the chain remains the source of truth)
    ------------------------------------------------------------------
    CREATE TABLE reputation_cache (
      chain_id        INTEGER NOT NULL,
      subject         TEXT    NOT NULL,
      score_bps       INTEGER NOT NULL,
      tier            TEXT    NOT NULL,
      fetched_at      INTEGER NOT NULL,
      PRIMARY KEY (chain_id, subject)
    );

    ------------------------------------------------------------------
    -- Credential attestations (hashes only; never PII)
    ------------------------------------------------------------------
    CREATE TABLE credentials (
      chain_id        INTEGER NOT NULL,
      credential_id   TEXT    NOT NULL,
      subject         TEXT    NOT NULL,
      schema_type     TEXT    NOT NULL,
      issuer          TEXT    NOT NULL,
      issued_at       INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      revoked         INTEGER NOT NULL DEFAULT 0,
      revoked_at      INTEGER,
      PRIMARY KEY (chain_id, credential_id)
    );
    CREATE INDEX idx_credentials_subject ON credentials (chain_id, subject);
    CREATE INDEX idx_credentials_expiry  ON credentials (expires_at);

    ------------------------------------------------------------------
    -- Raw event log + indexer cursor
    ------------------------------------------------------------------
    CREATE TABLE events (
      chain_id        INTEGER NOT NULL,
      tx_hash         TEXT    NOT NULL,
      log_index       INTEGER NOT NULL,
      contract        TEXT    NOT NULL,
      event_name      TEXT    NOT NULL,
      campaign_address TEXT,
      actor           TEXT,
      block_number    INTEGER NOT NULL,
      block_time      INTEGER NOT NULL,
      args_json       TEXT    NOT NULL,
      confirmed       INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (chain_id, tx_hash, log_index)
    );
    CREATE INDEX idx_events_block     ON events (block_number);
    CREATE INDEX idx_events_campaign  ON events (chain_id, campaign_address);
    CREATE INDEX idx_events_confirmed ON events (confirmed, block_number);

    -- Per (chain, contract) high-water mark. One row per contract makes the indexer
    -- restart-safe: on boot it resumes from here rather than rescanning from genesis.
    CREATE TABLE indexer_cursor (
      chain_id        INTEGER NOT NULL,
      contract        TEXT    NOT NULL,
      last_block      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      PRIMARY KEY (chain_id, contract)
    );
  `,
  },
];