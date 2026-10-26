/** Realistic mock data so the dashboard is fully functional even without a running backend. */

import type { CampaignSummary, CampaignDetail, StatsData, IndexerStatus, ReadyChecks } from "./api";

export const MOCK_CAMPAIGNS: CampaignSummary[] = [
  {
    address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    creator:  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    title: "Rust SDK & Offline Hardware Signer",
    category: "Developer Tooling",
    creatorName: "Alex Rivera (Verified Dev)",
    tagline: "High-throughput, memory-safe client library for air-gapped cryptographic signing and hardware wallets.",
    goalWei: "50000000000000000000",           // 50 ETH
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 25,
    state: "Active",
    totalContributed: "50000000000000000000",
    totalReleased: "20000000000000000000",     // 20 ETH released
    releasedBps: 4000,                          // 40% released
    createdAt: Math.floor(Date.now()/1000) - 86400 * 30,
    risk: { score: 24.5, band: "Low" },
  },
  {
    address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
    creator:  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    title: "EcoMesh: Solar LoRaWAN Climate Stations",
    category: "IoT & CleanTech",
    creatorName: "EcoSense Labs (DID Verified)",
    tagline: "Decentralized hyper-local weather sensor mesh with tamper-proof IPFS telemetry logging.",
    goalWei: "10000000000000000000",           // 10 ETH
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 12,
    state: "Funding",
    totalContributed: "6800000000000000000",   // 6.8 ETH
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 5,
    risk: { score: 18.2, band: "Low" },
  },
  {
    address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
    creator:  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    title: "ZK-Vault: Zero-Knowledge Document Attestation",
    category: "Cryptography",
    creatorName: "Privacy Collective (3rd Project)",
    tagline: "Cryptographic proof of credentials and agreements without leaking metadata or sensitive personal details.",
    goalWei: "5000000000000000000",            // 5 ETH
    fundingDeadline: Math.floor(Date.now()/1000) - 86400 * 2,
    state: "Completed",
    totalContributed: "5800000000000000000",
    totalReleased: "5800000000000000000",
    releasedBps: 10000,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 60,
    risk: { score: 11.4, band: "Low" },
  },
  {
    address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    creator:  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    title: "Autonomous Medical Cargo Drone",
    category: "Robotics & Health",
    creatorName: "AeroMed Systems",
    tagline: "Open-source long-range emergency payload transport for isolated rural health clinics.",
    goalWei: "30000000000000000000",
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 8,
    state: "Active",
    totalContributed: "30000000000000000000",
    totalReleased: "9000000000000000000",
    releasedBps: 3000,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 20,
    risk: { score: 67.3, band: "High" },
  },
  {
    address: "0xdD2FD4581271e230360230F9337D5c0430Bf44C0",
    creator:  "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    title: "HyperScale L3 zk-Rollup Prototype",
    category: "Infrastructure",
    creatorName: "Anonymous Entity (Unverified)",
    tagline: "Experimental 100k TPS execution environment with recursive STARK compression.",
    goalWei: "8000000000000000000",
    fundingDeadline: Math.floor(Date.now()/1000) - 86400 * 10,
    state: "Failed",
    totalContributed: "2100000000000000000",
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 45,
    risk: { score: 78.9, band: "High" },
  },
  {
    address: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    creator:  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    title: "OpenHardware 64-bit RISC-V Dev Board",
    category: "Open Hardware",
    creatorName: "Nikhil Sharma (SiliconGuild)",
    tagline: "Low-cost dual-core SoC dev board with open silicon schematics and Linux kernel drivers.",
    goalWei: "20000000000000000000",
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 40,
    state: "Funding",
    totalContributed: "4800000000000000000",
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 2,
    risk: { score: 29.1, band: "Low" },
  },
];

export const MOCK_CAMPAIGN_DETAIL: CampaignDetail = {
  ...MOCK_CAMPAIGNS[0],
  milestones: [
    {
      idx: 0,
      title: "Core Cryptographic Primitives & Benchmarks",
      description: "Implemented Ed25519 batch signature verification, ChaCha20 encryption, and published 100% test coverage benchmarks.",
      state: "Verified",
      trancheBps: 2000, // 20%
      evidenceCID: "QmXoypizjW3WknfiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
      evidenceHash: "0x78ab29c4021235b8098c19dfa872635417bb124239857dcb1726aef618274a12",
      submittedAt: Math.floor(Date.now()/1000) - 86400 * 20,
      resolvedAt: Math.floor(Date.now()/1000) - 86400 * 18,
      quorumMet: true,
      approvalPct: 100,
    },
    {
      idx: 1,
      title: "Offline Transaction Serialization & Hardware Transport",
      description: "USB and WebHID protocol drivers for Ledger Nano S/X and Trezor Model T with air-gapped QR transaction signing.",
      state: "Verified",
      trancheBps: 2000, // 20%
      evidenceCID: "QmZTM52LGBVUbhWhXdMVumAUqaiGLGcvj79DmVaKsKsCa7",
      evidenceHash: "0x45fe1239aa8712df8712365417cb218491823746192847562819203948571625",
      submittedAt: Math.floor(Date.now()/1000) - 86400 * 10,
      resolvedAt: Math.floor(Date.now()/1000) - 86400 * 7,
      quorumMet: true,
      approvalPct: 92.5,
    },
    {
      idx: 2,
      title: "Cross-Platform CLI, GUI Signer & Documentation",
      description: "Electron + React companion app with visual transaction simulator and automated human-readable permission warnings.",
      state: "Submitted",
      trancheBps: 3000, // 30%
      evidenceCID: "QmQPeNsJPyVWPFDVHb77w8G42Fvo15z4bG2X8TF2FfbBGZ",
      evidenceHash: "0x9812476123485712948712039485716253481920394857162534819203948571",
      submittedAt: Math.floor(Date.now()/1000) - 86400 * 2,
      resolvedAt: null,
      votingDeadline: Math.floor(Date.now()/1000) + 86400 * 1,
      quorumMet: true,
      currentStakeVotedEth: "14.5",
      approvalPct: 86.2,
    },
    {
      idx: 3,
      title: "Third-Party Security Audit & Mainnet Launch",
      description: "Comprehensive static analysis and manual penetration audit by an independent security firm with public remediations.",
      state: "Pending",
      trancheBps: 3000, // 30%
      evidenceCID: null,
      evidenceHash: null,
      submittedAt: null,
      resolvedAt: null,
    },
  ],
  disputes: [],
  votesByMilestone: [
    {
      milestoneIndex: 0,
      votes: [
        { verifier: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", choice: "Approve", weightEth: "5.0", timestamp: "20 days ago" },
        { verifier: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", choice: "Approve", weightEth: "3.5", timestamp: "19 days ago" },
        { verifier: "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65", choice: "Approve", weightEth: "2.0", timestamp: "19 days ago" },
      ],
    },
    {
      milestoneIndex: 1,
      votes: [
        { verifier: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC", choice: "Approve", weightEth: "5.0", timestamp: "9 days ago" },
        { verifier: "0x90F79bf6EB2c4f870365E785982E1f101E93b906", choice: "Approve", weightEth: "3.5", timestamp: "8 days ago" },
        { verifier: "0x976EA74026E726554dB657fA54763abd0C3a0aa9", choice: "Reject",  weightEth: "0.8", timestamp: "8 days ago" },
      ],
    },
  ],
  contributors: 42,
  risk: { score: 24.5, band: "Low" },
};

export const MOCK_STATS: StatsData = {
  campaigns: MOCK_CAMPAIGNS.length,
  byState: { Funding: 2, Active: 2, Completed: 1, Failed: 1 },
  totalRaisedWei: "99500000000000000000", // ~99.5 ETH
};

export const MOCK_INDEXER: IndexerStatus = {
  running: true,
  chainId: 31337,
  headBlock: 142,
  confirmedThrough: 139,
  confirmations: 3,
  cursors: {
    CampaignFactory: 142,
    MilestoneVerifier: 142,
    ReputationRegistry: 139,
    DisputeResolution: 139,
  },
  lastPollAt: Math.floor(Date.now()/1000) - 3,
  lastError: null,
  eventsIndexed: 64,
};

export const MOCK_READY: ReadyChecks = {
  ready: true,
  checks: {
    database: { ok: true, detail: "12 migrations active" },
    chain: { ok: true, detail: "Local Hardhat (Block #142)" },
    ml: { ok: true, detail: "Model engine ready (3 models active)" },
  },
};
