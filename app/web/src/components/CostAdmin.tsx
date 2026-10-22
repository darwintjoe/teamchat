"use client";

import { useQuery } from "convex/react";
import { api } from "@/lib/api";

type Buckets = {
  le10: number;
  le50: number;
  le200: number;
  le1000: number;
  gt1000: number;
};

type Rollup = {
  day: string;
  messagesSent: number;
  activeSenders: number;
  groupCount: number;
  groupSizeBuckets: Buckets;
  averageGroupSize: number;
  projectedMonthlyCostUsd: number;
  peakViewerMethod: string;
};

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Appendix A admin tile. Everything here is a MODEL ESTIMATE, not a bill: it is calibrated to the
 * PRD's $18/org lever-1 baseline and is meant to show direction and group-size sensitivity.
 */
export function CostAdmin({ orgPublicId }: { orgPublicId: string }) {
  const dashboard = useQuery(api.usage.orgDashboard, { orgPublicId });
  const platform = useQuery(api.usage.platformStatus, {});

  if (dashboard === undefined || platform === undefined) {
    return (
      <details className="panel">
        <summary>Cost estimate</summary>
        <div className="panel-body">
          <p className="hint">Loading…</p>
        </div>
      </details>
    );
  }

  const latest: Rollup | null = dashboard.latest;
  const alert = platform.level;

  return (
    <details className="panel">
      <summary>Cost estimate · {money(dashboard.projection.projectedMonthlyCostUsd)}/mo</summary>
      <div className="panel-body">
        {alert !== "ok" ? (
          <div
            role="alert"
            style={{
              border: "1px solid #7f2a2f",
              background: "#2b1214",
              color: "#ffb4b9",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 10,
              fontSize: 12.5,
            }}
          >
            <strong>
              Platform budget {alert === "over" ? "over ceiling" : "at 70% warning"} — MODEL ALERT,
              not a bill.
            </strong>{" "}
            Projected total across {platform.activeOrgCount} org(s):{" "}
            {money(platform.projectedTotalUsd)}/mo ({platform.percentOfCeiling.toFixed(1)}% of{" "}
            {money(platform.ceilingUsd)}).
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>
            <div className="hint">This org, projected</div>
            <strong style={{ fontSize: 20 }}>
              {money(dashboard.projection.projectedMonthlyCostUsd)}
            </strong>
            <span className="hint"> / month</span>
          </div>
          <div>
            <div className="hint">Model basis</div>
            <span style={{ fontSize: 12.5 }}>
              {dashboard.projection.activeUsers} active users ·{" "}
              {dashboard.projection.messagesPerUserPerDay}/user/day ·{" "}
              {dashboard.projection.averageViewersPerMessage} viewers/message
            </span>
          </div>
        </div>

        <p className="hint" style={{ marginTop: 8 }}>
          <strong>Estimate, not a bill.</strong> Calibrated to Appendix A lever 1 (400 users, 15
          messages/user/day, 15% viewers, outlet/region/org-wide mix ⇒ $18/org). Convex seat fees
          are excluded from its spending limits; the $1,000 ceiling includes them.
        </p>

        {latest === null ? (
          <p className="hint">
            No daily rollup yet. The first row is written by the 00:20 UTC scheduled aggregation;
            the figure above is a live projection from current members and group sizes.
          </p>
        ) : (
          <>
            <div className="hint" style={{ marginTop: 8 }}>
              Latest measured day {latest.day}: {latest.messagesSent} messages ·{" "}
              {latest.activeSenders} active senders · {latest.groupCount} groups · avg size{" "}
              {latest.averageGroupSize}
            </div>
            <div className="hint">
              Group sizes: ≤10 {latest.groupSizeBuckets.le10} · 11–50 {latest.groupSizeBuckets.le50}{" "}
              · 51–200 {latest.groupSizeBuckets.le200} · 201–1000{" "}
              {latest.groupSizeBuckets.le1000} · &gt;1000 {latest.groupSizeBuckets.gt1000}
            </div>
            <div className="hint">
              Peak concurrent viewers: not measured ({latest.peakViewerMethod}). Capturing it
              would require a presence subscription, which Appendix A forbids for this tile.
            </div>
            <table style={{ width: "100%", fontSize: 12, marginTop: 8, borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ textAlign: "left", opacity: 0.7 }}>
                  <th>UTC day</th>
                  <th>Messages</th>
                  <th>Senders</th>
                  <th>Groups</th>
                  <th>Est. $/mo</th>
                </tr>
              </thead>
              <tbody>
                {dashboard.days.map((row) => (
                  <tr key={row.day}>
                    <td>{row.day}</td>
                    <td>{row.messagesSent}</td>
                    <td>{row.activeSenders}</td>
                    <td>{row.groupCount}</td>
                    <td>{money(row.projectedMonthlyCostUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </details>
  );
}
