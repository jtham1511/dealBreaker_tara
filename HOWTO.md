# Demo_0005 – Vercel Scaffold (v3)

## Deploy
1. Push to GitHub and import the repo in Vercel.
2. Add Env Vars in Vercel → Settings → Environment Variables:
    const apiKey = process.env.OPENAI_API_KEY;
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini';
3. Visit `/` → redirects to `/INDEX.html` (your Demo_0005).

## Excel-driven refresh
```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install pandas numpy openpyxl
python tools\refresh_index.py Soha-Usage-Price-updated.xlsx public\INDEX.html
```
This recomputes KPIs, Top Users (with Conferences), Recommendations, At‑Risk and exports CSVs to `public/data/`.
