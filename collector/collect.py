"""Collect code, git, GitHub and Codecov metrics for the EasyScience org health board.

Usage:
    python collector/collect.py --config repos.yml --workdir .cache --out site/data
    python collector/collect.py ... --no-api          # code + git only (no network to api.github.com)

Environment:
    GITHUB_TOKEN   token for api.github.com (the Actions GITHUB_TOKEN is enough for public repos)
    HISTORY_URL    optional URL of the previously published history.json, to append to
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request

import yaml

API = 'https://api.github.com'
NOW = dt.datetime.now(dt.timezone.utc)
WINDOW_DAYS = 365
RECENT_DAYS = 90
LARGE_PR_LINES = 500  # additions + deletions above which an open PR counts as large
CI_SAMPLES = 10  # successful runs per workflow used for the median duration


# --------------------------------------------------------------------------- shell / git


def sh(cmd: str, cwd: str | None = None) -> str:
    r = subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True, text=True)
    return r.stdout


def ok(cmd: str, cwd: str | None = None) -> bool:
    return subprocess.run(cmd, cwd=cwd, shell=True, capture_output=True).returncode == 0


def clone(owner: str, name: str, workdir: str, develop: str) -> str:
    path = os.path.join(workdir, name)
    since = (NOW - dt.timedelta(days=WINDOW_DAYS + 31)).date().isoformat()
    url = f'https://github.com/{owner}/{name}'
    if not os.path.isdir(os.path.join(path, '.git')):
        os.makedirs(workdir, exist_ok=True)
        if not ok(f'git clone -q --shallow-since={since} --no-single-branch {url} {path}'):
            sh(f'git clone -q --depth 50 --no-single-branch {url} {path}')
    else:
        sh('git fetch -q --prune origin', cwd=path)
    sh('git fetch -q --tags origin', cwd=path)
    return path


def default_branch(path: str) -> str:
    ref = sh('git symbolic-ref --short refs/remotes/origin/HEAD', cwd=path).strip()
    return ref.split('/', 1)[1] if '/' in ref else 'master'


def worktree(path: str, ref: str, dest: str) -> str:
    if os.path.isdir(dest):
        sh(f'git worktree remove --force {dest}', cwd=path)
    sh(f'git worktree add -f --detach {dest} {ref}', cwd=path)
    return dest


# --------------------------------------------------------------------------- code metrics


def code_metrics(tree: str, sources: list[str]) -> dict | None:
    dirs = [os.path.join(tree, s) for s in sources if os.path.isdir(os.path.join(tree, s))]
    if not dirs:
        return None
    d = ' '.join(dirs)
    raw = json.loads(sh(f'radon raw -j {d}') or '{}')
    cc = json.loads(sh(f'radon cc -j {d}') or '{}')
    mi = json.loads(sh(f'radon mi -j {d}') or '{}')

    t = collections.Counter()
    for v in raw.values():
        if isinstance(v, dict) and 'sloc' in v:
            for k in ('loc', 'lloc', 'sloc', 'comments', 'multi', 'blank'):
                t[k] += v[k]
            t['files'] += 1

    blocks = []
    for f, items in cc.items():
        if not isinstance(items, list):
            continue
        for b in items:
            if b.get('type') == 'class':
                continue
            name = f"{b['classname']}.{b['name']}" if b.get('classname') else b['name']
            blocks.append({'file': os.path.relpath(f, tree), 'name': name, 'cc': b['complexity'],
                           'rank': b['rank'], 'line': b['lineno']})
    grades = collections.Counter(b['rank'] for b in blocks)
    mis = [v['mi'] for v in mi.values() if isinstance(v, dict) and 'mi' in v]

    cfg = os.path.join(tree, 'pyproject.toml')
    cfg_arg = f'-c {cfg}' if os.path.exists(cfg) else ''
    out = sh(f'interrogate {cfg_arg} --fail-under=0 {d} 2>&1')
    m = re.search(r'actual:\s*([\d.]+)%', out)

    tests = 0
    for tf in glob.glob(os.path.join(tree, 'tests', '**', '*.py'), recursive=True):
        tests += len(re.findall(r'^\s*(?:async\s+)?def test_', open(tf, errors='ignore').read(), re.M))
    qml = 0
    for q in glob.glob(os.path.join(tree, '**', '*.qml'), recursive=True):
        if 'src_qt5' in q:
            continue
        qml += sum(1 for line in open(q, errors='ignore') if line.strip() and not line.strip().startswith('//'))

    return {
        'py_files': t['files'], 'sloc': t['sloc'], 'qml_sloc': qml,
        'functions': len(blocks),
        'avg_cc': round(sum(b['cc'] for b in blocks) / len(blocks), 2) if blocks else None,
        'complex_functions': sum(v for k, v in grades.items() if k in 'CDEF'),
        'cc_grades': dict(grades),
        'mi_avg': round(sum(mis) / len(mis), 1) if mis else None,
        'doc_coverage': float(m.group(1)) if m else None,
        'tests': tests,
        'hotspots': sorted(blocks, key=lambda b: -b['cc'])[:5],
    }


def git_activity(path: str, ref: str) -> dict:
    since = (NOW - dt.timedelta(days=WINDOW_DAYS)).date().isoformat()
    log = sh(f"git log {ref} --since={since} --no-merges --format='%aI|%aN'", cwd=path).strip().splitlines()
    months = collections.Counter()
    authors = set()
    recent = 0
    for line in log:
        d, a = line.split('|', 1)
        t = dt.datetime.fromisoformat(d)
        months[t.strftime('%Y-%m')] += 1
        if '[bot]' not in a:
            authors.add(a)
        if (NOW - t).days <= RECENT_DAYS:
            recent += 1
    keys = []
    y, m = NOW.year, NOW.month
    for _ in range(12):
        keys.append(f'{y}-{m:02d}')
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    keys.reverse()
    return {
        'commits_12m': len(log), 'commits_90d': recent, 'authors_12m': len(authors),
        'monthly': [{'month': k, 'commits': months.get(k, 0)} for k in keys],
        'last_commit': sh(f'git log -1 {ref} --format=%cI', cwd=path).strip()[:10],
    }


def drift(path: str, base: str, head: str, sources: list[str]) -> dict:
    paths = ' '.join(sources + ['tests']) if sources else ''
    s = sh(f'git diff --shortstat {base} {head} -- {paths}', cwd=path)
    n = lambda k: int((re.search(rf'(\d+) {k}', s) or [0, 0])[1])  # noqa: E731
    return {'files': n('file'), 'lines': n('insertion') + n('deletion')}


def since_release(path: str, tag: str, ref: str) -> dict:
    """Non-merge commits on ref that are not in tag.

    The clone is shallow, so when the tag's history does not meet ref's inside the
    fetched window the count is only a lower bound (complete=False).
    """
    tag_ref = f'refs/tags/{tag}'
    if not ok(f'git rev-parse -q --verify {tag_ref}', cwd=path):
        return {'tag': tag, 'commits': None, 'complete': False}
    count = sh(f'git rev-list --count --no-merges {tag_ref}..{ref}', cwd=path).strip()
    connected = bool(sh(f'git merge-base {tag_ref} {ref}', cwd=path).strip())
    return {'tag': tag, 'commits': int(count) if count.isdigit() else None, 'complete': connected}


# --------------------------------------------------------------------------- GitHub API


class GitHub:
    def __init__(self, token: str | None):
        self.token = token
        self.calls = 0

    def get(self, path: str, params: dict | None = None):
        q = '&'.join(f'{k}={v}' for k, v in (params or {}).items())
        url = f'{API}{path}' + (f'?{q}' if q else '')
        req = urllib.request.Request(url, headers={
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'easyscience-org-health',
            **({'Authorization': f'Bearer {self.token}'} if self.token else {}),
        })
        for attempt in range(4):
            try:
                self.calls += 1
                with urllib.request.urlopen(req, timeout=30) as r:
                    return json.loads(r.read() or 'null')
            except urllib.error.HTTPError as e:
                if e.code in (403, 429) and e.headers.get('x-ratelimit-remaining') == '0':
                    wait = max(1, int(e.headers.get('x-ratelimit-reset', time.time() + 60)) - int(time.time()))
                    print(f'rate limited, sleeping {wait}s', file=sys.stderr)
                    time.sleep(min(wait, 900))
                    continue
                if e.code in (404, 409):
                    return None
                if e.code >= 500 and attempt < 3:
                    time.sleep(2 ** attempt)
                    continue
                raise

    def pages(self, path: str, params: dict | None = None, stop=None, limit: int = 10):
        params = {'per_page': 100, **(params or {})}
        for page in range(1, limit + 1):
            items = self.get(path, {**params, 'page': page}) or []
            for it in items:
                if stop and stop(it):
                    return
                yield it
            if len(items) < params['per_page']:
                return


def days_since(iso: str | None) -> float | None:
    if not iso:
        return None
    return round((NOW - dt.datetime.fromisoformat(iso.replace('Z', '+00:00'))).total_seconds() / 86400, 1)


def run_minutes(run: dict) -> float | None:
    """Wall-clock minutes of a completed workflow run (latest attempt)."""
    a, b = run.get('run_started_at'), run.get('updated_at')
    if run.get('status') != 'completed' or not a or not b:
        return None
    t = lambda s: dt.datetime.fromisoformat(s.replace('Z', '+00:00'))  # noqa: E731
    return round(max(0.0, (t(b) - t(a)).total_seconds() / 60), 1)


def github_metrics(gh: GitHub, owner: str, name: str, branches: list[str]) -> dict:
    base = f'/repos/{owner}/{name}'
    cutoff = NOW - dt.timedelta(days=RECENT_DAYS)
    cutoff_iso = cutoff.strftime('%Y-%m-%dT%H:%M:%SZ')
    repo = gh.get(base) or {}

    open_issues, open_prs = [], []
    for it in gh.pages(f'{base}/issues', {'state': 'open'}):
        (open_prs if 'pull_request' in it else open_issues).append(it)
    bug = lambda i: any('bug' in (lb.get('name') or '').lower() for lb in i.get('labels', []))  # noqa: E731

    closed_90d = opened_90d = 0
    for it in gh.pages(f'{base}/issues', {'state': 'all', 'since': cutoff_iso}):
        if 'pull_request' in it:
            continue
        if it.get('closed_at') and it['closed_at'] >= cutoff_iso:
            closed_90d += 1
        if it['created_at'] >= cutoff_iso:
            opened_90d += 1

    pr_details = [gh.get(f"{base}/pulls/{p['number']}") or {} for p in open_prs]
    merged = []
    for p in gh.pages(f'{base}/pulls', {'state': 'closed', 'sort': 'updated', 'direction': 'desc'},
                      stop=lambda p: p['updated_at'] < cutoff_iso):
        if p.get('merged_at') and p['merged_at'] >= cutoff_iso:
            merged.append(days_since(p['created_at']) - days_since(p['merged_at']))

    ci = {}
    for br in branches:
        runs = (gh.get(f'{base}/actions/runs', {'branch': br, 'per_page': 100}) or {}).get('workflow_runs', [])
        by_wf = collections.defaultdict(list)
        for r in runs:  # newest first
            if r['event'] in ('pull_request', 'pull_request_target'):
                continue
            by_wf[r['name']].append(r)
        ci[br] = []
        for w, rs in sorted(by_wf.items()):
            r = rs[0]
            ok_mins = [m for m in (run_minutes(x) for x in rs if x['conclusion'] == 'success') if m is not None][:CI_SAMPLES]
            ci[br].append({
                'workflow': w, 'file': os.path.basename(r.get('path') or ''),
                'status': r['status'], 'conclusion': r['conclusion'],
                'at': r['updated_at'], 'url': r['html_url'],
                'minutes': run_minutes(r),
                'median_minutes': round(statistics.median(ok_mins), 1) if ok_mins else None,
                'samples': len(ok_mins),
            })

    rel = gh.get(f'{base}/releases/latest') or {}
    return {
        'stars': repo.get('stargazers_count'), 'default_branch': repo.get('default_branch'),
        'issues': {
            'open': len(open_issues), 'bugs': sum(map(bug, open_issues)),
            'unlabelled': sum(1 for i in open_issues if not i.get('labels')),
            'oldest_days': max((days_since(i['created_at']) for i in open_issues), default=None),
            'opened_90d': opened_90d, 'closed_90d': closed_90d,
        },
        'prs': {
            'open': len(open_prs),
            'draft': sum(1 for p in pr_details if p.get('draft')),
            'awaiting_review': sum(1 for p in pr_details if not p.get('draft') and p.get('requested_reviewers')),
            'oldest_days': max((days_since(p['created_at']) for p in open_prs), default=None),
            'merged_90d': len(merged),
            'median_days_to_merge': round(statistics.median(merged), 1) if merged else None,
            'large': sum(1 for p in pr_details if not p.get('draft')
                         and (p.get('additions') or 0) + (p.get('deletions') or 0) > LARGE_PR_LINES),
            'list': [{'number': p.get('number'), 'title': p.get('title'), 'draft': p.get('draft'),
                      'base': (p.get('base') or {}).get('ref'), 'author': (p.get('user') or {}).get('login'),
                      'age_days': days_since(p.get('created_at')), 'url': p.get('html_url'),
                      'additions': p.get('additions'), 'deletions': p.get('deletions'),
                      'files': p.get('changed_files')} for p in pr_details],
        },
        'ci': ci,
        'release': {'tag': rel.get('tag_name'), 'date': (rel.get('published_at') or '')[:10]} if rel else None,
    }


def codecov(owner: str, name: str, branch: str) -> float | None:
    url = f'https://api.codecov.io/api/v2/github/{owner}/repos/{name}/branches/{branch}'
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'easyscience-org-health'}), timeout=20) as r:
            data = json.loads(r.read())
        return (data.get('head_commit') or {}).get('totals', {}).get('coverage')
    except Exception:  # codecov is optional
        return None


# --------------------------------------------------------------------------- main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', default='repos.yml')
    ap.add_argument('--workdir', default='.cache')
    ap.add_argument('--out', default='site/data')
    ap.add_argument('--no-api', action='store_true')
    args = ap.parse_args()

    cfg = yaml.safe_load(open(args.config))
    owner, develop = cfg['owner'], cfg.get('develop_branch', 'develop')
    gh = None if args.no_api else GitHub(os.environ.get('GITHUB_TOKEN'))
    trees = os.path.abspath(os.path.join(args.workdir, '_trees'))
    out = {'generated': NOW.isoformat(timespec='seconds'), 'owner': owner,
           'docstring_gate': cfg.get('docstring_gate', 45), 'repos': []}

    for spec in cfg['repos']:
        name, sources = spec['name'], spec.get('source') or []
        print(f'== {name}', file=sys.stderr)
        path = clone(owner, name, os.path.abspath(args.workdir), develop)
        default = default_branch(path)
        branches = [default] + ([develop] if ok(f'git rev-parse -q --verify origin/{develop}', cwd=path) and develop != default else [])
        main_branch = branches[-1]
        rec = {k: spec.get(k) for k in ('name', 'family', 'kind')}
        rec.update(default_branch=default, main_branch=main_branch, code={}, url=f'https://github.com/{owner}/{name}')
        for br in branches:
            tree = worktree(path, f'origin/{br}', os.path.join(trees, f'{name}-{br}'))
            rec['code'][br] = code_metrics(tree, sources)
            rec['code'][br] and rec['code'][br].update(sha=sh('git rev-parse --short HEAD', cwd=tree).strip())
        rec['git'] = git_activity(path, f'origin/{main_branch}')
        rec['unreleased'] = drift(path, f'origin/{default}', f'origin/{develop}', sources) if len(branches) > 1 else None
        wt = os.path.join(trees, f'{name}-{main_branch}')
        rec['workflows'] = sorted(os.path.basename(p) for p in glob.glob(os.path.join(wt, '.github/workflows/*.y*ml')))
        tags = sh("git for-each-ref refs/tags --sort=-creatordate --format='%(refname:short)|%(creatordate:short)'", cwd=path).split()
        rec['latest_tag'] = dict(zip(('tag', 'date'), tags[0].split('|'))) if tags else None
        if gh:
            rec['github'] = github_metrics(gh, owner, name, branches)
            rec['coverage'] = {br: codecov(owner, name, br) for br in branches}
        # same tag the page shows as the release: the GitHub release, else the newest git tag
        tag = ((rec.get('github') or {}).get('release') or {}).get('tag') or (rec['latest_tag'] or {}).get('tag')
        rec['since_release'] = since_release(path, tag, f'origin/{main_branch}') if tag else None
        out['repos'].append(rec)

    os.makedirs(args.out, exist_ok=True)
    json.dump(out, open(os.path.join(args.out, 'latest.json'), 'w'), indent=1)
    write_history(out, args.out)
    if gh:
        print(f'GitHub API calls: {gh.calls}', file=sys.stderr)


def history_row(r: dict) -> dict:
    code = r['code'].get(r['main_branch']) or {}
    g = r.get('github') or {}
    ci = (g.get('ci') or {}).get(r['main_branch'], [])
    return {
        'repo': r['name'], 'sloc': code.get('sloc'), 'doc_coverage': code.get('doc_coverage'),
        'complex_functions': code.get('complex_functions'), 'tests': code.get('tests'),
        'open_issues': (g.get('issues') or {}).get('open'), 'open_prs': (g.get('prs') or {}).get('open'),
        'ci_failing': sum(1 for c in ci if c['conclusion'] == 'failure') if ci else None,
        'coverage': (r.get('coverage') or {}).get(r['main_branch']),
        'ci_slowest_min': max((c['median_minutes'] for c in ci if c.get('median_minutes') is not None), default=None),
        'commits_since_release': (r.get('since_release') or {}).get('commits'),
    }


def write_history(out: dict, outdir: str) -> None:
    """Append today's numbers to history.json, starting from the published copy if HISTORY_URL is set."""
    hist = []
    url = os.environ.get('HISTORY_URL')
    if url:
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                hist = json.loads(r.read())
        except Exception as e:
            print(f'no previous history ({e}); starting fresh', file=sys.stderr)
    today = out['generated'][:10]
    hist = [h for h in hist if h.get('date') != today]
    hist += [{'date': today, **history_row(r)} for r in out['repos']]
    json.dump(hist, open(os.path.join(outdir, 'history.json'), 'w'))


if __name__ == '__main__':
    main()
