/** Realistic mock data so the dashboard is fully functional even without a running backend. */

import type { CampaignSummary, CampaignDetail, StatsData, IndexerStatus, ReadyChecks } from "./api";

export const MOCK_CAMPAIGNS: CampaignSummary[] = [
  {
    address: "0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B",
    creator:  "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    goalWei: "10000000000000000000",           // 10 ETH
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 12,
    state: "Funding",
    totalContributed: "4200000000000000000",   // 4.2 ETH
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 5,
    risk: { score: 28.4, band: "Low" },
  },
  {
    address: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
    creator:  "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    goalWei: "50000000000000000000",           // 50 ETH
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 25,
    state: "Active",
    totalContributed: "50000000000000000000",
    totalReleased: "20000000000000000000",
    releasedBps: 4000,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 30,
    risk: { score: 41.7, band: "Medium" },
  },
  {
    address: "0x2546BcD3c84621e976D8185a91A922aE77ECEc30",
    creator:  "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    goalWei: "5000000000000000000",            // 5 ETH
    fundingDeadline: Math.floor(Date.now()/1000) - 86400 * 2,
    state: "Completed",
    totalContributed: "5800000000000000000",
    totalReleased: "5800000000000000000",
    releasedBps: 10000,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 60,
    risk: { score: 12.1, band: "Low" },
  },
  {
    address: "0xbDA5747bFD65F08deb54cb465eB87D40e51B197E",
    creator:  "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
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
    goalWei: "8000000000000000000",
    fundingDeadline: Math.floor(Date.now()/1000) - 86400 * 10,
    state: "Failed",
    totalContributed: "2100000000000000000",
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 45,
    risk: { score: 54.8, band: "Medium" },
  },
  {
    address: "0x8626f6940E2eb28930eFb4CeF49B2d1F2C9C1199",
    creator:  "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    goalWei: "20000000000000000000",
    fundingDeadline: Math.floor(Date.now()/1000) + 86400 * 40,
    state: "Funding",
    totalContributed: "3500000000000000000",
    totalReleased: "0",
    releasedBps: 0,
    createdAt: Math.floor(Date.now()/1000) - 86400 * 2,
    risk: { score: 22.9, band: "Low" },
  },
];

export const MOCK_CAMPAIGN_DETAIL: CampaignDetail = {
  ...MOCK_CAMPAIGNS[1],
  milestones: [
    { idx: 0, state: "Verified", trancheBps: 2000, descriptionHash: "0xabc...", evidenceCID: "QmXyz", submittedAt: Math.floor(Date.now()/1000) - 86400*15 },
    { idx: 1, state: "Verified", trancheBps: 2000, descriptionHash: "0xdef...", evidenceCID: "QmAbc", submittedAt: Math.floor(Date.now()/1000) - 86400*8 },
    { idx: 2, state: "Submitted", trancheBps: 3000, descriptionHash: "0x123...", evidenceCID: "QmDef", submittedAt: Math.floor(Date.now()/1000) - 86400*1 },
    { idx: 3, state: "Pending", trancheBps: 3000, descriptionHash: "0x456...", evidenceCID: null, submittedAt: null },
  ],
  disputes: [],
  votesByMilestone: [
    { milestoneIndex: 0, votes: [{ verifier: "0xaaa...", choice: "Approve", weight: "2000000000000000000" }] },
    { milestoneIndex: 1, votes: [{ verifier: "0xbbb...", choice: "Approve", weight: "1500000000000000000" }] },
  ],
  contributors: 14,
  risk: { score: 41.7, band: "Medium" },
};

export const MOCK_STATS: StatsData = {
  campaigns: MOCK_CAMPAIGNS.length,
  byState: { Funding: 2, Active: 2, Completed: 1, Failed: 1 },
  totalRaisedWei: "95600000000000000000",
};

export const MOCK_INDEXER: IndexerStatus = {
  running: true,
  chainId: 31337,
  headBlock: 127,
  confirmedThrough: 124,
  confirmations: 3,
  cursors: {
    CampaignFactory: 127,
    MilestoneVerifier: 127,
    ReputationRegistry: 124,
    DisputeResolution: 124,
  },
  lastPollAt: Math.floor(Date.now()/1000) - 4,
  lastError: null,
  eventsIndexed: 48,
};

export const MOCK_READY: ReadyChecks = {
  ready: true,
  checks: {
    database: { ok: true, detail: "12 migrations applied" },
    chain: { ok: true, detail: "head block 127" },
    ml: { ok: true, detail: "models_trained=true" },
  },
};
