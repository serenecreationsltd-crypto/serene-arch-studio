#!/usr/bin/env python3
"""Compare a Worker's wrangler.toml with the live Worker before deploying.

`wrangler deploy` makes the live Worker match the config: a KV/D1/R2/service
binding missing from wrangler.toml is removed, workers.dev is switched on or off,
and compatibility settings change. This check stops the deploy when that would
remove or silently change something that's live, and prints the live values as
a ready-to-paste wrangler.toml block.

Not compared, because wrangler leaves them alone: secrets, dashboard variables
(with keep_vars = true), cron schedules when the config has no [triggers]
block, and routes when the config lists none.

Usage (CI):  CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
               python3 scripts/cf-worker-drift.py workers/<folder>
Testing:     python3 scripts/cf-worker-drift.py workers/<folder> --live-json live.json
             (live.json = {"settings": {...}, "subdomain": {...}, "schedules": [...]},
              or {"missing": true} for a Worker that doesn't exist yet)
Set ALLOW_DRIFT=true to report differences as warnings and let the deploy go
ahead (for intentional changes such as a compatibility_date bump).
Exit codes: 0 = ok to deploy, 1 = drift found, 2 = usage or API error.
"""
import json
import os
import sys
import tomllib
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
GH = os.environ.get("GITHUB_ACTIONS") == "true"

# Live binding types that deploys keep (keep_vars / secrets) or that hold no
# resource, so they aren't compared.
KEPT_TYPES = {"plain_text", "json", "secret_text", "secret_key"}

# Live binding type -> field naming the resource it points at.
LIVE_IDENT = {
    "kv_namespace": "namespace_id",
    "d1": "id",
    "r2_bucket": "bucket_name",
    "service": "service",
    "queue": "queue_name",
    "analytics_engine": "dataset",
    "hyperdrive": "id",
    "vectorize": "index_name",
    "durable_object_namespace": "class_name",
    "dispatch_namespace": "namespace",
    "mtls_certificate": "certificate_id",
    "ai": None,
    "browser": None,
    "version_metadata": None,
    "images": None,
}

# How each live binding type is written in wrangler.toml.
TOML_SNIPPET = {
    "kv_namespace": lambda b: f'[[kv_namespaces]]\nbinding = "{b["name"]}"\nid = "{b.get("namespace_id", "")}"',
    "d1": lambda b: f'[[d1_databases]]\nbinding = "{b["name"]}"\ndatabase_id = "{b.get("id", "")}"',
    "r2_bucket": lambda b: f'[[r2_buckets]]\nbinding = "{b["name"]}"\nbucket_name = "{b.get("bucket_name", "")}"',
    "service": lambda b: f'[[services]]\nbinding = "{b["name"]}"\nservice = "{b.get("service", "")}"',
    "queue": lambda b: f'[[queues.producers]]\nbinding = "{b["name"]}"\nqueue = "{b.get("queue_name", "")}"',
    "analytics_engine": lambda b: f'[[analytics_engine_datasets]]\nbinding = "{b["name"]}"\ndataset = "{b.get("dataset", "")}"',
    "hyperdrive": lambda b: f'[[hyperdrive]]\nbinding = "{b["name"]}"\nid = "{b.get("id", "")}"',
    "vectorize": lambda b: f'[[vectorize]]\nbinding = "{b["name"]}"\nindex_name = "{b.get("index_name", "")}"',
    "durable_object_namespace": lambda b: (
        f'[[durable_objects.bindings]]\nname = "{b["name"]}"\nclass_name = "{b.get("class_name", "")}"'
        + (f'\nscript_name = "{b["script_name"]}"' if b.get("script_name") else "")),
    "ai": lambda b: f'[ai]\nbinding = "{b["name"]}"',
    "browser": lambda b: f'[browser]\nbinding = "{b["name"]}"',
    "version_metadata": lambda b: f'[version_metadata]\nbinding = "{b["name"]}"',
}


def config_bindings(cfg):
    """(type, name) -> ident for every resource binding declared in wrangler.toml."""
    out = {}

    def add(kind, name, ident=None):
        if name:
            out[(kind, name)] = ident

    for b in cfg.get("kv_namespaces", []):
        add("kv_namespace", b.get("binding"), b.get("id"))
    for b in cfg.get("d1_databases", []):
        add("d1", b.get("binding"), b.get("database_id"))
    for b in cfg.get("r2_buckets", []):
        add("r2_bucket", b.get("binding"), b.get("bucket_name"))
    for b in cfg.get("services", []):
        add("service", b.get("binding"), b.get("service"))
    for b in cfg.get("queues", {}).get("producers", []):
        add("queue", b.get("binding"), b.get("queue"))
    for b in cfg.get("analytics_engine_datasets", []):
        add("analytics_engine", b.get("binding"), b.get("dataset"))
    for b in cfg.get("hyperdrive", []):
        add("hyperdrive", b.get("binding"), b.get("id"))
    for b in cfg.get("vectorize", []):
        add("vectorize", b.get("binding"), b.get("index_name"))
    for b in cfg.get("durable_objects", {}).get("bindings", []):
        add("durable_object_namespace", b.get("name"), b.get("class_name"))
    for key, kind in (("ai", "ai"), ("browser", "browser"), ("version_metadata", "version_metadata")):
        if isinstance(cfg.get(key), dict):
            add(kind, cfg[key].get("binding"))
    return out


def api_get(path, token):
    req = urllib.request.Request(API + path, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r)["result"]
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:300]
        if e.code == 404 or '"code":10007' in body:   # 10007 = Worker not found
            return None
        raise RuntimeError(f"Cloudflare API {e.code} on {path}: {body}")
    except urllib.error.URLError as e:
        raise RuntimeError(f"Cloudflare API unreachable ({e.reason})")


def fetch_live(name):
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "")
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "")
    if not token or not account:
        raise RuntimeError("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required")
    base = f"/accounts/{account}/workers/scripts/{name}"
    settings = api_get(base + "/settings", token)
    if settings is None:
        return {"missing": True}
    schedules = api_get(base + "/schedules", token) or {}
    return {
        "settings": settings,
        "subdomain": api_get(base + "/subdomain", token) or {},
        "schedules": schedules.get("schedules", []) if isinstance(schedules, dict) else schedules,
    }


def emit(level, title, msg):
    if GH:
        def esc(v, prop=False):
            v = v.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
            return v.replace(":", "%3A").replace(",", "%2C") if prop else v
        print(f"::{level} title={esc(title, True)}::{esc(msg)}")
    else:
        print(f"[{level.upper()}] {title}: {msg}")


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    folder = argv[1].rstrip("/")
    path = os.path.join(folder, "wrangler.toml")
    try:
        with open(path, "rb") as f:
            cfg = tomllib.load(f)
    except FileNotFoundError:
        emit("error", "Drift check", f"{path} not found (only wrangler.toml is supported)")
        return 2
    name = cfg.get("name")
    if not name:
        emit("error", "Drift check", f"{path} has no name")
        return 2

    if "--live-json" in argv:
        with open(argv[argv.index("--live-json") + 1]) as f:
            live = json.load(f)
    else:
        try:
            live = fetch_live(name)
        except RuntimeError as e:
            emit("error", f"{name}: drift check", str(e))
            return 2

    if live.get("missing"):
        emit("notice", f"{name}: new Worker", "No live Worker with this name yet; the deploy will create it.")
        return 0

    s = live.get("settings") or {}
    allow = os.environ.get("ALLOW_DRIFT", "").lower() in ("1", "true", "yes")
    problems, notes, snippet = [], [], []

    # 1. Compatibility date and flags (change runtime behaviour).
    live_date, cfg_date = s.get("compatibility_date"), cfg.get("compatibility_date")
    if live_date and str(cfg_date) != str(live_date):
        problems.append(f"compatibility_date is {cfg_date} here but {live_date} live.")
    if live_date:
        snippet.append(f'compatibility_date = "{live_date}"')
    live_flags = sorted(s.get("compatibility_flags") or [])
    cfg_flags = sorted(cfg.get("compatibility_flags") or [])
    if live_flags != cfg_flags:
        problems.append(f"compatibility_flags are {cfg_flags} here but {live_flags} live.")
    if live_flags:
        snippet.append("compatibility_flags = " + json.dumps(live_flags))

    # 2. workers.dev URL (wrangler switches it on or off every deploy).
    sub = live.get("subdomain") or {}
    if "enabled" in sub:
        has_routes = bool(cfg.get("routes") or cfg.get("route"))
        want = cfg.get("workers_dev", not has_routes)
        if bool(want) != bool(sub["enabled"]):
            problems.append(f"workers_dev would be {str(want).lower()}, live it's {str(sub['enabled']).lower()}.")
        snippet.append(f"workers_dev = {str(bool(sub['enabled'])).lower()}")

    # 3. Resource bindings (a binding missing here is deleted by the deploy).
    want = config_bindings(cfg)
    for b in s.get("bindings") or []:
        kind, bname = b.get("type"), b.get("name")
        if kind in KEPT_TYPES:
            continue
        if kind not in LIVE_IDENT:
            problems.append(f"live binding {bname} has type '{kind}', which this check can't map; add it to wrangler.toml by hand.")
            continue
        field = LIVE_IDENT[kind]
        ident = b.get(field) if field else None
        if kind in TOML_SNIPPET:
            snippet.append(TOML_SNIPPET[kind](b))
        if (kind, bname) not in want:
            problems.append(f"live {kind} binding {bname}" + (f" -> {ident}" if ident else "")
                            + " is missing here, so the deploy would remove it.")
        elif field and want[(kind, bname)] != ident:
            problems.append(f"{kind} binding {bname} points to {want[(kind, bname)]} here but {ident} live.")
        want.pop((kind, bname), None)
    for (kind, bname), ident in want.items():
        notes.append(f"adds {kind} binding {bname}" + (f" -> {ident}" if ident else "") + " (not on the live Worker).")

    # 4. Cron schedules: only compared when wrangler.toml declares them.
    live_crons = sorted(x.get("cron") for x in (live.get("schedules") or []) if x.get("cron"))
    cfg_crons = (cfg.get("triggers") or {}).get("crons")
    if cfg_crons is None:
        if live_crons:
            notes.append(f"cron schedules {live_crons} stay as set in the dashboard (no [triggers] block here).")
    elif sorted(cfg_crons) != live_crons:
        problems.append(f"crons are {sorted(cfg_crons)} here but {live_crons} live.")
    if live_crons:
        snippet.append("[triggers]\ncrons = " + json.dumps(live_crons))

    # 5. Settings sent only when present in the config.
    obs = s.get("observability") or {}
    if obs.get("enabled") and "observability" not in cfg:
        problems.append("Workers Logs (observability) is on live but not set here.")
        snippet.append("[observability]\nenabled = true"
                       + (f"\nhead_sampling_rate = {obs['head_sampling_rate']}" if "head_sampling_rate" in obs else ""))
    if s.get("logpush") and "logpush" not in cfg:
        problems.append("logpush is on live but not set here.")
        snippet.append("logpush = true")
    mode = (s.get("placement") or {}).get("mode") or s.get("placement_mode")
    if mode and mode != "off" and "placement" not in cfg:
        problems.append(f"placement mode '{mode}' is set live but not here.")
        snippet.append(f'[placement]\nmode = "{mode}"')
    tails = s.get("tail_consumers") or []
    if tails and "tail_consumers" not in cfg:
        problems.append("tail consumers are set live but not here.")
        snippet.append("\n".join(f'[[tail_consumers]]\nservice = "{t.get("service", "")}"' for t in tails))
    cpu = (s.get("limits") or {}).get("cpu_ms")
    if cpu and "limits" not in cfg:
        problems.append(f"CPU limit {cpu} ms is set live but not here.")
        snippet.append(f"[limits]\ncpu_ms = {cpu}")

    # Top-level keys must come before any [table] in TOML.
    ordered = [x for x in snippet if not x.startswith("[")] + [x for x in snippet if x.startswith("[")]
    live_block = "\n".join(ordered) if ordered else "(no settings to copy)"
    for n in notes:
        emit("notice", f"{name}: drift check", n)
    if not problems:
        emit("notice", f"{name}: drift check", "wrangler.toml matches the live Worker; safe to deploy.")
        return 0

    msg = (" ".join(problems) + "\nLive values for wrangler.toml:\n" + live_block)
    if allow:
        emit("warning", f"{name}: deploying with config changes", msg)
        return 0
    emit("error", f"{name}: wrangler.toml differs from the live Worker", msg)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a") as f:
            f.write(f"### {name}: deploy stopped by drift check\n\n"
                    + "".join(f"- {p}\n" for p in problems)
                    + "\nLive values to put in `wrangler.toml`:\n\n```toml\n" + live_block + "\n```\n\n"
                    + "To deploy anyway (an intentional change), run the workflow by hand with "
                      "**Allow config changes** ticked.\n")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
