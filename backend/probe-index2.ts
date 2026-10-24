/** Probe part 2: campaign-level logs + raw log fields the indexer binds. */
import { getChainClient } from "./src/chain/client.js";
import { config } from "./src/config.js";

const client = getChainClient();
const head = await client.blockNumber();

for (const addr of ["0x856e4424f806D16E8CBC702B3c0F2ede5468eae5", "0xb0279Db6a2F1E01fbC8483FCCef0Be2bC6299cC3"]) {
  const c = client.at("Campaign", addr);
  const filter = c.filters.Contributed();
  const logs = await c.queryFilter(filter, 0, head);
  console.log(`Contributed on ${addr}: ${logs.length}`);
  for (const log of logs.slice(0, 3)) {
    const parsed = c.interface.parseLog({ topics: [...log.topics], data: log.data });
    const args = parsed?.args as Record<string, unknown>;
    console.log(
      `  block=${log.blockNumber} index=${String(log.index)} tx=${log.transactionHash} backer=${args.backer} amount=${String(args.amount)} total=${String(args.totalContributed)}`
    );
    if (typeof log.index !== "number") console.log("  SUSPECT: log.index is " + typeof log.index);
  }
  const all = await client.provider.getLogs({ address: addr, fromBlock: 0, toBlock: head });
  console.log(`  ALL logs on ${addr}: ${all.length}`);
  for (const l of all) {
    try {
      const p = c.interface.parseLog({ topics: [...l.topics], data: l.data });
      console.log(`    block=${l.blockNumber} event=${p?.name ?? "UNPARSEABLE"}`);
    } catch {
      console.log(`    block=${l.blockNumber} event=PARSE-FAIL topics[0]=${l.topics[0]}`);
    }
  }
}

// MilestoneVerifier: what are the 6 logs?
const mv = client.at("MilestoneVerifier", client.addresses.MilestoneVerifier);
const mvLogs = await client.provider.getLogs({ address: client.addresses.MilestoneVerifier, fromBlock: 0, toBlock: head });
for (const l of mvLogs) {
  try {
    const p = mv.interface.parseLog({ topics: [...l.topics], data: l.data });
    const a = p?.args as Record<string, unknown>;
    console.log(`MV block=${l.blockNumber} event=${p?.name} keys=${p ? Object.keys(a).filter((k) => isNaN(Number(k))).join(",") : "-"}`);
  } catch {
    console.log(`MV block=${l.blockNumber} PARSE-FAIL`);
  }
}
console.log("MV has VoteCast in ABI: " + (mv.interface.hasEvent("VoteCast") ? "yes" : "NO"));
void config;
