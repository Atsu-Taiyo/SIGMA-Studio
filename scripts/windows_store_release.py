#!/usr/bin/env python3
"""Read-only CD planning. Never persist Store responses or credentials."""

import os
import re
import sys

import windows_store as store


def published_release(env):
    repository = store.require(env, "GITHUB_REPOSITORY", r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
    requested = env.get("STORE_RELEASE_TAG", "").strip()
    if requested and not re.fullmatch(r"v\d+\.\d+\.\d+", requested):
        raise store.StoreError("Select a stable release tag.")
    endpoint = f"tags/{requested}" if requested else "latest"
    release = store.github_json(["api", f"repos/{repository}/releases/{endpoint}"])
    tag = release.get("tag_name", "")
    if (not isinstance(tag, str) or not re.fullmatch(r"v\d+\.\d+\.\d+", tag)
            or (requested and requested != tag) or release.get("draft") is not False
            or release.get("prerelease") is not False or not release.get("published_at")):
        raise store.StoreError("Select an existing published stable release.")
    store.version_tuple(f"{tag[1:]}.0", uploading=True)
    return tag


def plan(client, env, tag):
    """Return whether a new submission is needed; this function only uses GET."""
    target = store.version_tuple(f"{tag[1:]}.0", uploading=True)
    app = store.checked_application(client, env)
    pending = app.get("pendingApplicationSubmission")
    if pending:
        state = store.read_status(client, pending.get("id"))
        if state not in store.ACCEPTED | {"CommitStarted"}:
            raise store.StoreError("An unfinished draft requires manual recovery; CD will not edit or retry it.")
        store.report("Deferred", message="A submission is already in progress. The scheduled CD run will check again.")
        return "deferred"
    previous = store.check_ready(client, env)
    if any(store.version_tuple(package.get("version")) >= target
           for package in previous["applicationPackages"]):
        store.report("Current", message="The selected version or a newer version is already published; no submission needed.")
        return "current"
    store.report("Ready", message="The published release needs a Store update; packaging may proceed.")
    return "ready"


def main():
    env = os.environ
    if env.get("GITHUB_REF") != "refs/heads/main" or env.get("GITHUB_EVENT_NAME") not in {"workflow_dispatch", "schedule"}:
        raise store.StoreError("CD planning must run on main via dispatch or schedule.")
    tag = published_release(env)
    result = plan(store.StoreClient(env), env, tag)
    verify_only = env.get("STORE_VERIFY_ONLY", "false") == "true"
    with open(store.require(env, "GITHUB_OUTPUT"), "a", encoding="utf-8") as output:
        output.write(f"release_tag={tag}\n")
        output.write(f"build={'true' if result == 'ready' or verify_only else 'false'}\n")
        output.write(f"submit={'true' if result == 'ready' and not verify_only else 'false'}\n")


if __name__ == "__main__":
    try:
        main()
    except store.StoreError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Store CD planning failed; diagnostic payloads are intentionally withheld.", file=sys.stderr)
        sys.exit(1)
