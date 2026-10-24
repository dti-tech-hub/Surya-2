/** Probe part 3: execute the EXACT indexer inserts for the block-12 Contributed log. */
import { getChainClient } from "./src/chain/client.js";
import { config } from "./src/config.js";
import { eventRepository, contributionRepository } from "./src/db/repositories.js";
import "./src/db/migrate.js";

const client = getChainClient();
const ADDR = "0x856e4424f806D16E8CBC702B3c0F2ede5468eae5";
const c = client.at("Campaign", ADDR);
const logs = await c.queryFilter(c.filters.Contributed(), 0, 12);
console.log("logs in 0-12: " + logs.length);
for (const log of logs) {
  const parsed = c.interface.parseLog({ topics: [...log.topics], data: log.data });
  const args = parsed?.args as Record<string, unknown>;
  const block = await client.provider.getBlock(log.blockNumber);
  const blockTime = block?.timestamp ?? 0;
  const emittingAddress = ADDR;

  const eventRow = {
    tx_hash: log.transactionHash,
    log_index: (log as unknown as Record<string, unknown>).index,
    contract: emittingAddress,
    event_name: "Contributed",
    campaign_address: (args.campaign as string | undefined) ?? emittingAddress,
    actor: args.backer as string,
    block_number: log.blockNumber,
    block_time: blockTime,
    args,
    confirmed: 1,
  };
  console.log("eventRow types: " + Object.entries(eventRow).map(([k, v]) => `${k}:${typeof v}`).join(" "));
  try {
    const ok = eventRepository.insert(config.CHAIN_ID, eventRow);
    console.log("event insert ok=" + ok);
  } catch (e) {
    console.log("EVENT INSERT THREW: " + (e as Error).message);
  }

  const contribRow = {
    tx_hash: log.transactionHash,
    log_index: (log as unknown as Record<string, unknown>).index,
    campaign_address: (args.campaign as string | undefined) ?? emittingAddress,
    backer: args.backer,
    amount_wei: (args.amount ?? 0).toString(),
    block_number: log.blockNumber,
    block_time: blockTime,
  };
  console.log("contribRow types: " + Object.entries(contribRow).map(([k, v]) => `${k}:${typeof v}`).join(" "));
  try {
    const ok = contributionRepository.insert(config.CHAIN_ID, contribRow);
    console.log("contrib insert ok=" + ok);
  } catch (e) {
    console.log("CONTRIB INSERT THREW: " + (e as Error).message);
  }
}
