import type { CampaignSummary } from "../api";
import { formatEth, formatTime } from "../api";

export function CampaignCard({
  campaign,
  onOpen,
}: {
  campaign: CampaignSummary;
  onOpen: (address: string) => void;
}) {
  const band = campaign.risk?.band?.toLowerCase() ?? "unknown";
  return (
    <div className="card campaign" onClick={() => onOpen(campaign.address)}>
      <h3>
        {campaign.state}{" "}
        {campaign.risk && (
          <span className={`badge ${band}`}>
            risk {campaign.risk.score.toFixed(1)} · {campaign.risk.band}
          </span>
        )}
      </h3>
      <div className="mono">{campaign.address}</div>
      <div>
        Goal {formatEth(campaign.goalWei)} · Raised{" "}
        {formatEth(campaign.totalContributed)}
      </div>
      <div>
        <small>Deadline {formatTime(campaign.fundingDeadline)}</small>
      </div>
    </div>
  );
}
