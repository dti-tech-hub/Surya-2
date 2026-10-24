import type { CampaignDetail } from "../api";
import { formatEth, formatTime } from "../api";

export function CampaignDetailView({
  detail,
  onBack,
}: {
  detail: CampaignDetail;
  onBack: () => void;
}) {
  return (
    <div>
      <button className="ghost" onClick={onBack}>
        ← back to list
      </button>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>
          {detail.state}{" "}
          {detail.risk && (
            <span className={`badge ${detail.risk.band.toLowerCase()}`}>
              risk {detail.risk.score.toFixed(1)} · {detail.risk.band}
            </span>
          )}
        </h3>
        <div className="mono">{detail.address}</div>
        <table>
          <tbody>
            <tr>
              <th>Creator</th>
              <td className="mono">{detail.creator}</td>
            </tr>
            <tr>
              <th>Goal</th>
              <td>{formatEth(detail.goalWei)}</td>
            </tr>
            <tr>
              <th>Raised</th>
              <td>{formatEth(detail.totalContributed)}</td>
            </tr>
            <tr>
              <th>Released</th>
              <td>{formatEth(detail.totalReleased)}</td>
            </tr>
            <tr>
              <th>Contributors</th>
              <td>{detail.contributors}</td>
            </tr>
            <tr>
              <th>Deadline</th>
              <td>{formatTime(detail.fundingDeadline)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <div className="card">
          <h3>Milestones ({detail.milestones.length})</h3>
          <pre className="dump">{JSON.stringify(detail.milestones, null, 2)}</pre>
        </div>
        <div className="card">
          <h3>Disputes ({detail.disputes.length})</h3>
          <pre className="dump">{JSON.stringify(detail.disputes, null, 2)}</pre>
        </div>
      </div>
      <div className="card" style={{ marginTop: 12 }}>
        <h3>Votes by milestone</h3>
        <pre className="dump">{JSON.stringify(detail.votesByMilestone, null, 2)}</pre>
      </div>
    </div>
  );
}
