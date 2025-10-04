#!/usr/bin/env python3
"""
Refresh Demo_0005-based INDEX.html from Soha-Usage-Price-updated.xlsx:
- KPIs with "Data as of" and status pills (APV utilization, Survey)
- Top Users (with Conferences), Recommendations, At-Risk tables
- CSV exports to public/data/
"""
import sys, re, datetime as dt
from pathlib import Path
import pandas as pd, numpy as np

def mm(x):
    try: return f"${float(x)/1_000_000:.2f}M"
    except: return "-"
def money(x):
    try: return "${:,.0f}".format(float(x))
    except: return "-"
def pct(x):
    try: return f"{float(x):.1f}%"
    except: return "-"

def compute(xlsx_path):
    xls = pd.ExcelFile(xlsx_path)
    contract = xls.parse("Contract APV and Spend")
    usage = xls.parse("Usage-Price")
    survey = xls.parse("38 Survey Responses")

    def row_val(name, col):
        row = contract[contract['Unnamed: 0'] == name]
        return float(row.iloc[0][col]) if not row.empty and pd.notna(row.iloc[0][col]) else np.nan

    total_cost_3y = row_val('Total Cost','Total 3 Years')
    apv_total = row_val('Contract APV','Total 3 Years')
    gt_y1 = row_val('GovTech Cost','Year 1'); gt_y2 = row_val('GovTech Cost','Year 2')
    sg_y1 = row_val('SNG Cost','Year 1'); sg_y2 = row_val('SNG Cost','Year 2')
    spent_20m = (gt_y1 + sg_y1) + (gt_y2 + sg_y2) * (8/12)
    pct_apv_20m = (spent_20m / apv_total * 100.0) if apv_total else np.nan

    for c in ['No of Report download','No of Call','No. Participants Attended Gartner Conferences','Total Cost (3 Years)']:
        if c in usage.columns: usage[c] = pd.to_numeric(usage[c], errors='coerce').fillna(0)

    licensed_users = int(usage.shape[0])
    downloads = int(usage['No of Report download'].sum()) if 'No of Report download' in usage.columns else 0
    total_cost_users_sum = float(usage['Total Cost (3 Years)'].sum()) if 'Total Cost (3 Years)' in usage.columns else 0.0
    cost_per_download = total_cost_users_sum / downloads if downloads else float('nan')

    def score(x):
        import re as _re
        m = _re.search(r'(\d+)', str(x))
        return int(m.group(1)) if m else np.nan
    avg_survey = float(pd.to_numeric(survey['Q1_Overall_Usefulness'].map(score), errors='coerce').mean()) if 'Q1_Overall_Usefulness' in survey.columns else float('nan')

    usage['total_interactions'] = usage.get('No of Report download',0) + usage.get('No of Call',0) + usage.get('No. Participants Attended Gartner Conferences',0)
    name_col = 'Licensed User Name (2)' if 'Licensed User Name (2)' in usage.columns else usage.columns[0]
    type_col = 'Account Type(Short)' if 'Account Type(Short)' in usage.columns else None
    team_candidates = ['Department','Dept','Agency','Organisation','Organization','Org','Team','Division','Group','Account Type(Short)']
    team_col = next((c for c in team_candidates if c in usage.columns), type_col)

    topu = usage[[name_col,'No of Report download','No of Call','No. Participants Attended Gartner Conferences','total_interactions']].copy()
    topu['monthly_avg'] = (topu['total_interactions']/20.0).round(1)
    topu = topu.rename(columns={name_col:'User','No of Report download':'Downloads','No of Call':'Calls','No. Participants Attended Gartner Conferences':'Conferences'})
    topu = topu.sort_values('total_interactions', ascending=False).head(10)

    low = usage.sort_values('total_interactions').head(10)[[c for c in [name_col, type_col, 'total_interactions'] if c]].to_dict('records')
    remove = usage[usage['total_interactions']==0].head(10)[[c for c in [name_col, type_col, 'Total Cost (3 Years)'] if c in usage.columns]].to_dict('records')
    active = usage[usage['total_interactions']>0].copy()
    if not active.empty:
        active['cost_per_interaction'] = np.where(active['total_interactions']>0, active['Total Cost (3 Years)']/active['total_interactions'], np.inf)
        q25 = active['total_interactions'].quantile(0.25)
        down = active[active['total_interactions']<=q25].sort_values('cost_per_interaction', ascending=False).head(10)[[c for c in [name_col, type_col, 'total_interactions', 'cost_per_interaction'] if c]].to_dict('records')
    else:
        down = []

    if team_col:
        grp = usage.groupby(team_col, dropna=False); q25_all = usage['total_interactions'].quantile(0.25); rows=[]
        for team, g in grp:
            users = int(g.shape[0]); zero = int((g['total_interactions']==0).sum()); lowc = int((g['total_interactions']<=q25_all).sum())
            avg_int = float(g['total_interactions'].mean()) if users else 0.0
            cost = float(g['Total Cost (3 Years)'].sum()) if 'Total Cost (3 Years)' in g.columns else 0.0
            zero_rate = zero/users if users else 0.0; low_rate = lowc/users if users else 0.0
            risk = 0.6*zero_rate + 0.4*low_rate
            rows.append({"Team": str(team) if team==team else "Unspecified","Users":users,"ZeroUsage":zero,"LowUtil":lowc,"ZeroRate":round(zero_rate,3),"LowRate":round(low_rate,3),"AvgInteractions":round(avg_int,2),"TotalCost3Y":round(cost,2),"RiskScore":round(risk,3)})
        at_risk = pd.DataFrame(rows).sort_values(["RiskScore","ZeroRate","LowRate"], ascending=False)
    else:
        at_risk = pd.DataFrame(columns=["Team","Users","ZeroUsage","LowUtil","ZeroRate","LowRate","AvgInteractions","TotalCost3Y","RiskScore"])

    return {
        "kpi": {"total_cost_3y": total_cost_3y, "spent_20m": spent_20m, "apv_total": apv_total, "pct_apv_20m": pct_apv_20m, "licensed_users": licensed_users, "cost_per_download": cost_per_download, "avg_survey": avg_survey},
        "topu": topu, "low": low, "remove": remove, "down": down, "at_risk": at_risk,
        "cols": {"name": name_col, "type": type_col}
    }

def apv_status(p):
    try:
        v = float(p)
        if v >= 80: return "risk"
        if v >= 60: return "warn"
        return "ok"
    except: return "ok"

def survey_status(s):
    try:
        v = float(s)
        if v >= 4.0: return "ok"
        if v >= 3.0: return "warn"
        return "risk"
    except: return "ok"

def patch(html, data, as_of_str):
    # Ensure onclick signatures are showTab('id', event)
    html = re.sub(r"onclick=\"showTab\\('([^']+)'\\)\"", r"onclick=\"showTab('\\1', event)\"", html)

    k = data["kpi"]
    apv_stat = apv_status(k['pct_apv_20m'])
    survey_stat = survey_status(k['avg_survey'])

    kpi_css = """
<!-- KPI v2 START -->
<style>
  :root { --kpi-green:#16a34a; --kpi-amber:#f59e0b; --kpi-red:#dc2626; --kpi-blue:#0d6efd; }
  .kpi-grid { display:grid; grid-template-columns: repeat(4, minmax(180px,1fr)); gap:12px; margin:12px 0 8px 0; }
  .kpi-card { background:#0d6efd; color:#fff; border-radius:14px; padding:16px; box-shadow:0 4px 14px rgba(0,0,0,.08); position:relative; }
  .kpi-value { font-size:28px; font-weight:700; line-height:1.1; }
  .kpi-label { font-size:13px; opacity:.95; margin-top:4px; }
  .kpi-sub   { font-size:12px; opacity:.9; margin-top:6px; }
  .kpi-pill { position:absolute; top:10px; right:10px; font-size:11px; padding:3px 8px; border-radius:999px; background:rgba(255,255,255,.18); border:1px solid rgba(255,255,255,.35); }
  .kpi-pill.ok::before, .kpi-pill.warn::before, .kpi-pill.risk::before { content:''; display:inline-block; width:8px; height:8px; border-radius:999px; margin-right:6px; vertical-align:middle; }
  .kpi-pill.ok::before { background:var(--kpi-green); }
  .kpi-pill.warn::before { background:var(--kpi-amber); }
  .kpi-pill.risk::before { background:var(--kpi-red); }
  .kpi-asof { font-size:12px; color:#6b7280; margin:4px 2px 14px 2px; }
  @media (max-width: 960px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 540px) { .kpi-grid { grid-template-columns: 1fr; } }
</style>
"""
    kpi_html = f"""{kpi_css}
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-value">{mm(k['total_cost_3y'])}</div>
    <div class="kpi-label">Total Contract Cost (GovTech + SNG)</div>
    <div class="kpi-sub">20‑month spend: <strong>{mm(k['spent_20m'])}</strong> · {pct(k['pct_apv_20m'])} of APV {mm(k['apv_total'])}</div>
    <div class="kpi-pill {apv_stat}">APV utilization</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value">{int(k['licensed_users'])}</div>
    <div class="kpi-label">Licensed Users</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value">{money(k['cost_per_download'])}</div>
    <div class="kpi-label">Cost per Download</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-value">{float(k['avg_survey']):.2f}</div>
    <div class="kpi-label">User Satisfaction (5 scale)</div>
    <div class="kpi-pill {survey_stat}">Survey</div>
  </div>
</div>
<div class="kpi-asof">Data as of: <strong>{as_of_str}</strong></div>
<!-- KPI v2 END -->
"""
    html = re.sub(r'<!--\\s*KPI v2 START\\s*-->[\\s\\S]*?<!--\\s*KPI v2 END\\s*-->\\s*', '', html, flags=re.IGNORECASE)
    html = re.sub(r'<!--\\s*KPI START\\s*-->[\\s\\S]*?<!--\\s*KPI END\\s*-->\\s*', '', html, flags=re.IGNORECASE)
    m_overview = re.search(r'(<div[^>]+id="overview"[^>]*>)', html, flags=re.IGNORECASE)
    if m_overview:
        html = html.replace(m_overview.group(1), m_overview.group(1) + "\\n" + kpi_html, 1)
    return html

def main():
    if len(sys.argv) != 3:
        print("Usage: python tools/refresh_index.py <excel> <public/INDEX.html>")
        sys.exit(1)
    xlsx, html_path = sys.argv[1], sys.argv[2]
    data = compute(xlsx)
    as_of = dt.datetime.fromtimestamp(Path(xlsx).stat().st_mtime).strftime("%Y-%m-%d")
    html = Path(html_path).read_text(encoding='utf-8', errors='ignore')
    Path(html_path).write_text(patch(html, data, as_of), encoding='utf-8')

    out_dir = Path(html_path).parent / "data"; out_dir.mkdir(parents=True, exist_ok=True)
    pd.DataFrame(data["low"]).to_csv(out_dir / "low_utilization_accounts.csv", index=False)
    pd.DataFrame(data["remove"]).to_csv(out_dir / "remove_seats.csv", index=False)
    pd.DataFrame(data["down"]).to_csv(out_dir / "downgrade_candidates.csv", index=False)
    data["at_risk"].to_csv(out_dir / "at_risk_teams.csv", index=False)
    print("OK: refreshed INDEX.html and CSVs.")

if __name__ == "__main__":
    main()
