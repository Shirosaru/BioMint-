export function selectExecutionPlan(agents, cfg) {
  const now = Date.now();

  const active = agents
    .filter((a) => {
      // Accept both lastHeartbeatMs (number) and lastHeartbeat (ISO string/number)
      const hb = a.lastHeartbeatMs ?? (typeof a.lastHeartbeat === "string"
        ? new Date(a.lastHeartbeat).getTime()
        : a.lastHeartbeat);
      return Number.isFinite(hb) && now - hb <= cfg.maxStaleHeartbeatSec * 1000;
    })
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));

  // Accept both canApprove and approves field names
  const approvals = active.filter((a) => a.canApprove ?? a.approves).length;

  if (active.length === 0) {
    return {
      ok: false,
      reason: "no live agents",
      leader: null,
      backups: [],
      approvals
    };
  }

  if (approvals < cfg.minApprovals) {
    return {
      ok: false,
      reason: "insufficient agent approvals",
      leader: active[0].id,
      backups: active.slice(1).map((a) => a.id),
      approvals
    };
  }

  return {
    ok: true,
    reason: "quorum reached",
    leader: active[0].id,
    backups: active.slice(1).map((a) => a.id),
    approvals
  };
}
