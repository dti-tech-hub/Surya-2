/** Debug probe: replays every chain log through the indexer's bind values. */
import { getChainClient } from "./src/chain/client.js";
import { config } from "./src/config.js";

console.log("network=" + config.NETWORK_NAME + " rpc=" + config.RPC_URL);

const client = getChainClient();
console.log("addresses=" + JSON.stringify(client.addresses));

const head = await client.blockNumber();
console.log("head=" + head);

function flag(label: string, value: unknown): void {
  const bad =
    value === undefined ||
    (typeof value === "number" && !Number.isFinite(value)) ||
    (typeof value === "object" && value !== null);
  if (bad) console.log("  SUSPECT " + label + " = " + String(value));
}

const factory = client.at("CampaignFactory", client.addresses.CampaignFactory);
const deploys = await factory.queryFilter(factory.filters.CampaignDeployed(), 0, head);
console.log("deploys=" + deploys.length);
for (const log of deploys) {
  const parsed = factory.interface.parseLog({ topics: [...log.topics], data: log.data });
  const args = parsed?.args as Record<string, unknown>;
  console.log(
    `deploy block=${log.blockNumber} campaign=${args.campaign} creator=${args.creatorAddress} goal=${String(args.goalAmount)} deadline=${String(args.fundingDeadline)} count=${String(args.milestoneCount)}`
  );
  flag("goal_wei", (args.goalAmount ?? 0).toString());
  flag("creator", args.creatorAddress);
  // milestone arrays the indexer reads (present on the EVENT? or only on createCampaign fn args?)
  for (const k of ["tranchePercentages", "descriptionHashes", "specificationCIDs", "milestoneDeadlines"]) {
    console.log(`  event field ${k}: ${args[k] === undefined ? "MISSING" : "present"}`);
  }
}

for (const [name, addr] of Object.entries(client.addresses)) {
  if (name === "CampaignFactory" || !addr) continue;
  try {
    const c = client.at(name as never, addr);
    const events = await c.queryFilter("*" as never, 0, head).catch(() => []);
    console.log(`${name} ${addr}: ${(events as unknown[]).length} total logs`);
  } catch (e) {
    console.log(`${name}: query failed: ${(e as Error).message}`);
  }
}
