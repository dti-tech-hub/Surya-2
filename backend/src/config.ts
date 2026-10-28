/**
 * Typed runtime configuration, validated once at startup.
 *
 * Failing fast here matters: an indexer that silently starts against the wrong RPC URL or
 * without a confirmation depth produces a subtly wrong database that looks healthy. A
 * missing required variable should stop the process, not degrade quietly.
 */
import { z } from "zod";

// NOTE on trimming: `cmd /c "set FOO=bar && ..."` leaves a trailing space in FOO on
// Windows. A trailing space in NETWORK_NAME silently selects a nonexistent deployment
// manifest ("localhost .json"), which makes the indexer start with zero contract
// addresses and index nothing while reporting healthy. Every string field below uses
// zod's built-in `.trim()` so that failure class cannot recur. (An earlier attempt
// used z.preprocess, which widens the inferred type to unknown and breaks typecheck.)

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_PATH: z.string().trim().default("./data/app.db"),

  BACKEND_JWT_SECRET: z.string().trim().min(8).default("dev-only-insecure-secret"),

  FRONTEND_ORIGIN: z.string().trim().default("http://localhost:5180,http://localhost:5173"),
  /** Blocks a list page; health checks and metrics stay unthrottled. */
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),

  /**
   * Number of confirmations the indexer waits for before treating a log as final.
   * This is the reorg safety margin. Lowering it trades reorg safety for freshness.
   */
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).default(3),
  INDEXER_POLL_MS: z.coerce.number().int().positive().default(5_000),
  INDEXER_START_BLOCK: z.coerce.number().int().min(0).default(0),

  RPC_URL: z.string().trim().default("http://127.0.0.1:8545"),
  CHAIN_ID: z.coerce.number().int().default(31337),

  /**
   * Selects deployments/<NETWORK_NAME>.json. Must match the Hardhat network name.
   * Defaults to `localhost` because RPC_URL defaults to a local node; the in-process
   * `hardhat` network cannot be reached over HTTP.
   */
  NETWORK_NAME: z.string().trim().default("localhost"),

  FACTORY_ADDRESS: z.string().trim().optional(),
  VERIFIER_ADDRESS: z.string().trim().optional(),
  REPUTATION_ADDRESS: z.string().trim().optional(),
  DISPUTES_ADDRESS: z.string().trim().optional(),
  CREDENTIALS_ADDRESS: z.string().trim().optional(),

  PINATA_JWT: z.string().trim().optional(),
  PINATA_GATEWAY_URL: z.string().trim().default("https://gateway.pinata.cloud"),
  IPFS_GATEWAY_URL: z.string().trim().default("https://ipfs.io/ipfs/"),
  /**
   * Optional local IPFS daemon (Kubo) HTTP API. When absent and no Pinata JWT is set, the
   * backend falls back to a local content-addressed store, explicitly reported as
   * `local-content-store` rather than IPFS.
   */
  IPFS_API_URL: z.string().trim().optional(),
  IPFS_LOCAL_DIR: z.string().trim().default("./data/evidence"),

  /** VC issuer key. Only needed for credential issuance/attestation. */
  VC_ISSUER_PRIVATE_KEY: z.string().trim().optional(),
  VC_ISSUER_DID: z.string().trim().optional(),
  VC_ATTEST_ONCHAIN: z.coerce.boolean().default(false),

  ML_SERVICE_URL: z.string().trim().default("http://127.0.0.1:8000"),
  ML_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

  VERAMO_AGENT_PRIVATE_KEY: z.string().trim().optional(),
  VERAMO_ISSUER_DID: z.string().trim().optional(),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // Intentionally not using the logger here: it may not be configured yet.
  console.error("Invalid configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const config = parsed.data;

/** True when Pinata credentials are present. Gates the evidence-upload route. */
export const ipfsConfigured = Boolean(config.PINATA_JWT);