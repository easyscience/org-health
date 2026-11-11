# org-health

A page that shows code quality, open issues, pull requests, and CI status across the EasyScience repositories. It is rebuilt every six hours and published with GitHub Pages:

**https://easyscience.github.io/org-health/**

## What it shows

- A summary line and totals: failing workflows, open issues, open PRs and commits.
- A scorecard with one sortable row per repository: CI, slowest CI workflow (median duration), issues, PRs, oldest PR, Codecov coverage, docstring coverage against core's 45% gate, complexity, tests, commits, latest release, commits since that release, and lines on develop that are not yet on master.
- CI status: the latest non-PR run of each key workflow on master and develop, linked to the run, with its duration.
- Open pull requests, oldest first, with their size in lines changed, and issue/PR flow over the last 90 days.
- Commits per month for each repository, all on one scale.
- Trends over time from `history.json`, which gains one point per repository on each build.
- The most complex functions in each repository.

For a wall screen, use **poster view**: click "Poster view" in the header, press `P`, or open the page with `?poster` (https://easyscience.github.io/org-health/?poster). It fills the window, scales the type to the screen and hides the explanatory notes and secondary columns. It also reloads every 15 minutes to pick up new builds. `Esc` leaves it.

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

## License

BSD 3-Clause. See [LICENSE](LICENSE).
