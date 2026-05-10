/**
 * Integration Readiness Report — 8-section monthly PDF for org admins.
 * Spec: D3.4. Maps every section to a compliance obligation an org holds.
 */

interface ReportData {
  orgName: string;
  periodStart: Date;
  periodEnd: Date;
  cohort: {
    activeLearners: number;
    avgHours: number;
    retentionRate: number;
    momChange: number;
  };
  levelProgression: { fromLevel: string; toLevel: string; count: number }[];
  individualLearners: {
    name: string;
    uln: string;
    startDate: Date | null;
    currentLevel: string;
    hours: number;
    scenarios: number;
    vocabRetained: number;
    lastActive: Date | null;
  }[];
  curriculumCoverage: { learnerName: string; skillCodes: string[] }[];
  transitionReady: { name: string; level: string; reason: string }[];
  certificates: { name: string; fromLevel: string; toLevel: string; date: Date }[];
  safeguarding: {
    totalAlerts: number;
    open: number;
    reviewed: number;
    escalated: number;
    resolved: number;
    dismissed: number;
  };
  learnerVoice: { quote: string; rating: "okay" | "confident" }[];
}

const escapeHtml = (s: string): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const fmtDate = (d: Date | null): string =>
  d
    ? new Date(d).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
      })
    : "—";

export const buildIntegrationReadinessHtml = (data: ReportData): string => {
  const periodLabel = `${fmtDate(data.periodStart)} – ${fmtDate(data.periodEnd)}`;

  const learnerRows = data.individualLearners
    .map(
      (l) =>
        `<tr>
          <td>${escapeHtml(l.name)}</td>
          <td>${escapeHtml(l.uln) || "—"}</td>
          <td>${fmtDate(l.startDate)}</td>
          <td>${escapeHtml(l.currentLevel)}</td>
          <td class="num">${l.hours.toFixed(1)}</td>
          <td class="num">${l.scenarios}</td>
          <td class="num">${l.vocabRetained}</td>
          <td>${fmtDate(l.lastActive)}</td>
        </tr>`
    )
    .join("");

  const progressionRows = data.levelProgression.length
    ? data.levelProgression
        .map(
          (p) =>
            `<tr><td>${escapeHtml(p.fromLevel)} → ${escapeHtml(p.toLevel)}</td><td class="num">${p.count}</td></tr>`
        )
        .join("")
    : `<tr><td colspan="2" class="muted">No level changes recorded this period.</td></tr>`;

  const transitionRows = data.transitionReady.length
    ? data.transitionReady
        .map(
          (t) =>
            `<li><strong>${escapeHtml(t.name)}</strong> — ${escapeHtml(t.level)} <span class="muted">(${escapeHtml(t.reason)})</span></li>`
        )
        .join("")
    : `<li class="muted">No learners meeting transition-ready criteria yet.</li>`;

  const curriculumRows = data.curriculumCoverage
    .slice(0, 12)
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.learnerName)}</td><td>${c.skillCodes.map(escapeHtml).join(", ")}</td></tr>`
    )
    .join("");

  const voiceItems = data.learnerVoice.length
    ? data.learnerVoice
        .map(
          (v) =>
            `<blockquote class="voice ${v.rating}"><span class="emoji">${v.rating === "confident" ? "😊" : "🙂"}</span> "${escapeHtml(v.quote)}"</blockquote>`
        )
        .join("")
    : `<p class="muted">No learner voice quotes available for this period.</p>`;

  const certificateItems = data.certificates.length
    ? data.certificates
        .map(
          (c) =>
            `<li><strong>${escapeHtml(c.name)}</strong> advanced from ${escapeHtml(c.fromLevel)} to ${escapeHtml(c.toLevel)} on ${fmtDate(c.date)}</li>`
        )
        .join("")
    : `<li class="muted">No level advancements this period.</li>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Integration Readiness Report — ${escapeHtml(data.orgName)}</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    margin: 0;
    padding: 40px 48px;
    color: #0B2343;
    font-size: 11px;
    line-height: 1.5;
  }
  .header {
    border-bottom: 3px solid #0B2343;
    padding-bottom: 20px;
    margin-bottom: 24px;
  }
  .header .brand {
    color: #ff7c22;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 2px;
    font-weight: 700;
    margin-bottom: 6px;
  }
  .header h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 800;
  }
  .header .meta {
    color: rgba(11,35,67,0.55);
    font-size: 11px;
    margin-top: 4px;
  }
  h2 {
    font-size: 13px;
    margin: 24px 0 8px;
    color: #ff7c22;
    text-transform: uppercase;
    letter-spacing: 1px;
    font-weight: 700;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 16px;
  }
  .stat {
    background: #fafbfc;
    border: 1px solid rgba(11,35,67,0.06);
    border-radius: 8px;
    padding: 12px 14px;
  }
  .stat .label {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: rgba(11,35,67,0.5);
    font-weight: 700;
  }
  .stat .value {
    font-size: 22px;
    font-weight: 800;
    margin-top: 4px;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 12px;
  }
  th {
    text-align: left;
    background: #fafbfc;
    border-top: 1px solid rgba(11,35,67,0.1);
    border-bottom: 1px solid rgba(11,35,67,0.1);
    padding: 8px 10px;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.4px;
    color: rgba(11,35,67,0.6);
    font-weight: 700;
  }
  td {
    padding: 8px 10px;
    border-bottom: 1px solid rgba(11,35,67,0.04);
    vertical-align: top;
    font-size: 10px;
  }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  ul, ol { padding-left: 18px; margin: 6px 0; }
  li { margin: 4px 0; font-size: 10px; }
  .muted { color: rgba(11,35,67,0.4); font-style: italic; }
  .voice {
    background: #fafbfc;
    border-left: 3px solid #ff7c22;
    padding: 10px 14px;
    margin: 8px 0;
    border-radius: 0 6px 6px 0;
    font-size: 10px;
    color: rgba(11,35,67,0.75);
  }
  .voice .emoji { font-size: 13px; margin-right: 6px; }
  .footer {
    margin-top: 32px;
    padding-top: 12px;
    border-top: 1px solid rgba(11,35,67,0.06);
    font-size: 9px;
    color: rgba(11,35,67,0.4);
    text-align: center;
  }
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .badge.open { background: #fef3c7; color: #92400e; }
  .badge.resolved { background: #d1fae5; color: #065f46; }
  .badge.escalated { background: #fee2e2; color: #991b1b; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">Integration Readiness Report — Amber Training</div>
    <h1>${escapeHtml(data.orgName)}</h1>
    <div class="meta">Period: ${periodLabel} · Generated ${fmtDate(new Date())}</div>
  </div>

  <h2>1 · Cohort summary</h2>
  <div class="stat-grid">
    <div class="stat"><div class="label">Active learners</div><div class="value">${data.cohort.activeLearners}</div></div>
    <div class="stat"><div class="label">Avg hours / learner</div><div class="value">${data.cohort.avgHours.toFixed(1)}</div></div>
    <div class="stat"><div class="label">30-day retention</div><div class="value">${(data.cohort.retentionRate * 100).toFixed(0)}%</div></div>
    <div class="stat"><div class="label">MoM change</div><div class="value">${data.cohort.momChange >= 0 ? "+" : ""}${data.cohort.momChange.toFixed(0)}</div></div>
  </div>

  <h2>2 · Level progression</h2>
  <table>
    <thead><tr><th>Movement</th><th class="num">Learners</th></tr></thead>
    <tbody>${progressionRows}</tbody>
  </table>

  <h2>3 · Individual learner records</h2>
  <table>
    <thead>
      <tr>
        <th>Learner</th><th>ULN</th><th>Start</th><th>Level</th>
        <th class="num">Hours</th><th class="num">Scenarios</th>
        <th class="num">Vocab</th><th>Last active</th>
      </tr>
    </thead>
    <tbody>${learnerRows || `<tr><td colspan="8" class="muted">No learners in this period.</td></tr>`}</tbody>
  </table>

  <h2>4 · Curriculum mapping evidence</h2>
  <p class="muted">ESOL Core Curriculum skill codes covered per learner — proves framework alignment for Ofsted.</p>
  <table>
    <thead><tr><th>Learner</th><th>Skill codes covered</th></tr></thead>
    <tbody>${curriculumRows || `<tr><td colspan="2" class="muted">No session data.</td></tr>`}</tbody>
  </table>

  <h2>5 · Transition readiness</h2>
  <p class="muted">Learners meeting all five progression criteria — ready for advancement or physical-classroom transition.</p>
  <ul>${transitionRows}</ul>

  <h2>6 · Level Achievement certificates</h2>
  <ul>${certificateItems}</ul>

  <h2>7 · Safeguarding log summary</h2>
  <p>Total alerts raised: <strong>${data.safeguarding.totalAlerts}</strong></p>
  <p>
    <span class="badge open">Open · ${data.safeguarding.open}</span>
    <span class="badge resolved">Reviewed · ${data.safeguarding.reviewed}</span>
    <span class="badge escalated">Escalated · ${data.safeguarding.escalated}</span>
    <span class="badge resolved">Resolved · ${data.safeguarding.resolved}</span>
  </p>
  <p class="muted">No personal detail is included in this section — see admin dashboard for case-level review.</p>

  <h2>8 · Learner voice</h2>
  <p class="muted">Anonymised quotes from learners who marked sessions "okay" or "confident".</p>
  ${voiceItems}

  <div class="footer">
    Confidential — Amber Training Ltd · esol.ambertraining.co.uk · The Amber Bridge Method™
  </div>
</body>
</html>`;
};

export type { ReportData as IntegrationReadinessData };
