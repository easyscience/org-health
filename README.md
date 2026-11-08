# org-health

One page that shows code quality, open issues, pull requests and CI status across the EasyScience repositories. It is rebuilt every six hours and published with GitHub Pages:

**https://easyscience.github.io/org-health/** (once Pages is enabled)

The per-repository badge pages in [`easyScience/dashboard`](https://github.com/easyScience/dashboard) are left as they are. This repository reads the other repositories and writes nothing back to them.

## What it shows

- A summary line and totals: failing workflows, open issues and PRs, source lines, tests and commits.
- A scorecard with one sortable row per repository: CI, issues, PRs, oldest PR, Codecov coverage, docstring coverage against core's 45% gate, complexity, tests, commits, latest release, and lines on develop that are not yet on master.
- CI status: the latest non-PR run of each key workflow on master and develop, linked to the run.
- Open pull requests, oldest first, and issue/PR flow over the last 90 days.
- Commits per month for each repository, all on one scale.
- Trends over time from `history.json`, which gains one point per repository on each build.
- The most complex functions in each repository.

## How it works

```
repos.yml ──> collector/collect.py ──> site/data/latest.json + history.json ──> GitHub Pages
                │  git clone (shallow, 13 months)
                │  radon + interrogate  (same tools as each repo's dashboard.yml)
                │  GitHub REST API      (issues, PRs, workflow runs, releases)
                └  Codecov public API   (test coverage, optional)
```

- `repos.yml` lists the tracked repositories and the source folder(s) to scan in each.
- `collector/collect.py` writes `latest.json`, which holds the full snapshot. It also appends to `history.json`, starting from the copy already published on Pages, so no data branch or commit is needed.
- `site/` is a static page: `index.html`, `app.js` and `style.css`, plus d3 loaded from cdnjs. There is no build step.
- `.github/workflows/build.yml` runs the collector every 6 hours, on push to `main`, on manual dispatch, and on `repository_dispatch` (`refresh`). It then deploys `site/` with `actions/deploy-pages`.

## Setup (one time)

1. Create the repository `easyScience/org-health` (public) and push this code to `main`.
2. Go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. Run the workflow from **Actions → Build and publish board → Run workflow**. The first run takes about 2 minutes.
4. Optional: add a repository secret `ORG_HEALTH_TOKEN`. Without it the workflow uses `github.token`, which can read all public repositories in the org at 1,000 requests per hour. One build uses roughly 60–120 requests, so this only matters for private repositories. Use either:
   - a fine-grained PAT with read access to *Actions, Issues, Pull requests, Metadata*, or
   - a token from the existing `easyscience[bot]` app via `actions/create-github-app-token`.
5. Optional: to rebuild right after a tracked repository's CI finishes, add a step there that sends a `repository_dispatch` with type `refresh` to this repository.

## Run locally

```bash
pip install -r requirements.txt
```

```bash
GITHUB_TOKEN=$(gh auth token) python collector/collect.py --out site/data
```

```bash
python -m http.server -d site 8000
```

Pass `--no-api` to skip GitHub and Codecov and collect only the code and git metrics.

## Adding a repository

Add an entry to `repos.yml` with `name`, `family`, `kind` and `source`. Use `source: []` for a repository without Python code.
