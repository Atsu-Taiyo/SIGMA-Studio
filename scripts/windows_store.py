#!/usr/bin/env python3
"""Microsoft Store AppX submission. Stdlib only; never log provider payloads."""

import copy
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlencode, urlsplit
import xml.etree.ElementTree as ET
import zipfile


API = "https://manage.devcenter.microsoft.com"
STATES = {
    "None", "Canceled", "PendingCommit", "CommitStarted", "CommitFailed",
    "PendingPublication", "Publishing", "Published", "PublishFailed",
    "PreProcessing", "PreProcessingFailed", "Certification", "CertificationFailed",
    "Release", "ReleaseFailed",
}
FAILED = {"Canceled", "CommitFailed", "PublishFailed", "PreProcessingFailed",
          "CertificationFailed", "ReleaseFailed"}
ACCEPTED = {"PreProcessing", "Certification", "PendingPublication", "Publishing",
            "Published", "Release"}
MAX_PACKAGE_BYTES = 2 * 1024**3
MAX_JSON_BYTES = 16 * 1024**2


class StoreError(Exception):
    """Only static, intentionally public messages may be constructed here."""


def require(env, name, pattern=None):
    value = env.get(name, "").strip()
    if not value or (pattern and not re.fullmatch(pattern, value)):
        raise StoreError(f"Missing or invalid configuration: {name}")
    return value


def numeric_id(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]{1,32}", value):
        raise StoreError("Store returned an invalid submission identifier.")
    return value


def report(state, *, message="", errors=0, warnings=0):
    # Do not render arbitrary provider strings, IDs, URLs, notes or error bodies.
    if state not in STATES | {"Ready", "PackageVerified", "NoSubmission"}:
        raise StoreError("Store returned an unknown status; inspect Partner Center privately.")
    line = f"Microsoft Store: {state}; errors={int(errors)}, warnings={int(warnings)}. {message}".strip()
    print(line, flush=True)
    summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary:
        with open(summary, "a", encoding="utf-8") as output:
            output.write(line + "\n\n")


def request(url, *, method="GET", headers=None, body=None, expect_json=True, timeout=60):
    """No redirects, cookies, debug output or exception messages from HTTP libraries."""
    connection = None
    try:
        target = urlsplit(url)
        if target.scheme != "https" or target.username or target.password or target.port or target.fragment:
            raise StoreError("Invalid HTTPS destination.")
        connection = http.client.HTTPSConnection(target.hostname, timeout=timeout)
        path = target.path + ("?" + target.query if target.query else "")
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        if not 200 <= response.status < 300:
            raise StoreError(f"Remote request failed (HTTP {response.status}); inspect the service privately.")
        if not expect_json:
            return None
        data = response.read(MAX_JSON_BYTES + 1)
        if len(data) > MAX_JSON_BYTES:
            raise StoreError("Remote JSON response exceeded the size limit.")
        result = json.loads(data)
        if not isinstance(result, dict):
            raise StoreError("Remote response was not a JSON object.")
        return result
    except StoreError:
        raise
    except Exception:
        raise StoreError("Remote request failed; response details are intentionally withheld.") from None
    finally:
        if connection:
            connection.close()


def validate_upload_url(value):
    try:
        target = urlsplit(value)
        if (target.scheme != "https" or target.username or target.password or target.port
                or target.fragment or not re.fullmatch(r"[a-z0-9]+\.blob\.core\.windows\.net", target.hostname or "")
                or not target.path.startswith("/ingestion/") or not target.query):
            raise ValueError()
    except Exception:
        raise StoreError("Store returned an invalid upload destination.") from None
    return value


class StoreClient:
    def __init__(self, env, transport=request):
        self.env = env
        self.transport = transport
        guid = r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}"
        self.tenant = require(env, "WINDOWS_STORE_TENANT_ID", guid)
        self.client_id = require(env, "WINDOWS_STORE_CLIENT_ID", guid)
        self.secret = require(env, "WINDOWS_STORE_CLIENT_SECRET")
        self.app_id = require(env, "WINDOWS_STORE_APPLICATION_ID", r"[A-Z0-9]{12}")
        self.token = None
        self.token_until = 0

    def call(self, suffix="", *, method="GET", data=None, expect_json=True):
        if time.monotonic() >= self.token_until:
            auth = self.transport(
                f"https://login.microsoftonline.com/{self.tenant}/oauth2/token",
                method="POST", headers={"Content-Type": "application/x-www-form-urlencoded"},
                body=urlencode({"grant_type": "client_credentials", "client_id": self.client_id,
                                "client_secret": self.secret, "resource": API}).encode(),
            )
            token = auth.get("access_token")
            if not isinstance(token, str) or not token or "\n" in token or "\r" in token:
                raise StoreError("Authentication did not return a valid access token.")
            self.token = token
            self.token_until = time.monotonic() + 45 * 60
        return self.transport(
            f"{API}/v1.0/my/applications/{self.app_id}{suffix}", method=method,
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            body=json.dumps(data).encode() if data is not None else None, expect_json=expect_json,
        )


def read_status(client, submission_id):
    result = client.call(f"/submissions/{numeric_id(submission_id)}/status")
    state = result.get("status")
    if state not in STATES:
        raise StoreError("Store returned an unknown status; inspect Partner Center privately.")
    details = result.get("statusDetails") or {}
    errors = len(details.get("errors") or [])
    warnings = len(details.get("warnings") or [])
    meaning = {
        "Published": "Publication complete.",
        "PendingPublication": "Certification complete; publication is held.",
        "Certification": "Under certification; approval is not yet confirmed.",
        "PreProcessing": "Submission accepted; certification is not yet complete.",
        "PendingCommit": "Draft only; not submitted for certification.",
    }.get(state, "Certification/publication is not confirmed.")
    report(state, message=meaning, errors=errors, warnings=warnings)
    if state in FAILED or errors:
        raise StoreError("Submission needs attention; inspect error details in Partner Center privately.")
    return state


def check_ready(client, env):
    app = client.call()
    if (app.get("id") != client.app_id
            or app.get("packageIdentityName") != require(env, "WINDOWS_STORE_IDENTITY_NAME")
            or app.get("publisherName") != require(env, "WINDOWS_STORE_PUBLISHER")):
        raise StoreError("Partner Center identity does not match the configured application.")
    if app.get("pendingApplicationSubmission"):
        raise StoreError("An existing submission is present. It will not be deleted, overwritten or resubmitted.")
    published = app.get("lastPublishedApplicationSubmission") or {}
    if not published.get("id"):
        raise StoreError("Complete the initial Partner Center submission, age ratings and publication first.")
    previous = client.call(f"/submissions/{numeric_id(published['id'])}")
    if previous.get("status") != "Published":
        raise StoreError("The previous submission is not published.")
    if (previous.get("packageDeliveryOptions", {}).get("isMandatoryUpdate")
            or previous.get("packageDeliveryOptions", {}).get("packageRollout", {}).get("isPackageRollout")):
        raise StoreError("Mandatory updates or staged rollout require separate handling in Partner Center.")
    packages = previous.get("applicationPackages")
    if not isinstance(packages, list) or not packages:
        raise StoreError("No published package baseline was returned.")
    # This deployment targets the existing single x64 AppX build only. Do not drop
    # ARM/x86 or special device-family packages during an automated replacement.
    if len(packages) != 1 or packages[0].get("architecture", "").lower() != "x64":
        raise StoreError("The published package set is not a single x64 package; automatic replacement is disabled.")
    return previous


def version_tuple(value, *, uploading=False):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+\.\d+", value):
        raise StoreError("Invalid package version.")
    parts = tuple(int(part) for part in value.split("."))
    if any(part > 65535 for part in parts) or parts[0] == 0 or (uploading and parts[3] != 0):
        raise StoreError("Store package versions need a nonzero major and four 16-bit parts; uploads must end in zero.")
    return parts


def package_details(path, env):
    path = Path(path)
    tag = require(env, "STORE_RELEASE_TAG", r"v\d+\.\d+\.\d+")
    expected_name = f"Sigma-Studio-Store-{tag[1:]}-x64.appx"
    if path.name != expected_name or path.is_symlink() or not path.is_file():
        raise StoreError("Expected the release's x64 Store AppX package.")
    if not 0 < path.stat().st_size <= MAX_PACKAGE_BYTES:
        raise StoreError("Package is empty or exceeds the upload limit.")
    expected_hash = require(env, "STORE_PACKAGE_SHA256", r"[a-fA-F0-9]{64}").lower()
    with path.open("rb") as file:
        if hashlib.file_digest(file, "sha256").hexdigest() != expected_hash:
            raise StoreError("Package SHA-256 does not match; no submission was created.")
    try:
        with zipfile.ZipFile(path) as archive:
            entries = [item for item in archive.infolist() if item.filename == "AppxManifest.xml"]
            if len(entries) != 1 or entries[0].file_size > 1024**2:
                raise StoreError("AppX must contain one bounded AppxManifest.xml.")
            manifest = archive.read(entries[0])
            declarations = manifest.replace(b"\x00", b"").upper()
            if b"<!DOCTYPE" in declarations or b"<!ENTITY" in declarations:
                raise StoreError("AppX manifest contains unsupported XML declarations.")
            root = ET.fromstring(manifest)
    except StoreError:
        raise
    except Exception:
        raise StoreError("Cannot read the AppX manifest.") from None
    namespace = "{http://schemas.microsoft.com/appx/manifest/foundation/windows10}"
    identities = root.findall(f"{namespace}Identity")
    if root.tag != f"{namespace}Package" or len(identities) != 1:
        raise StoreError("Unexpected AppX manifest structure.")
    identity = identities[0].attrib
    version = identity.get("Version", "")
    version_tuple(version, uploading=True)
    if (identity.get("Name") != require(env, "WINDOWS_STORE_IDENTITY_NAME")
            or identity.get("Publisher") != require(env, "WINDOWS_STORE_PUBLISHER")
            or identity.get("ProcessorArchitecture") != "x64" or version != f"{tag[1:]}.0"):
        raise StoreError("AppX identity, publisher, architecture or version does not match.")
    return {"fileName": path.name, "version": version, "architecture": "x64"}


def prepare_submission(draft, package, mode, notes):
    if mode not in {"Manual", "Immediate"}:
        raise StoreError("Invalid publication mode.")
    if draft.get("status") != "PendingCommit":
        raise StoreError("New submission is not an editable API draft.")
    result = copy.deepcopy(draft)
    result["targetPublishMode"] = mode
    result["applicationPackages"] = [
        {**item, "fileStatus": "PendingDelete"} for item in draft["applicationPackages"]
    ] + [{"fileName": package["fileName"], "fileStatus": "PendingUpload"}]
    if notes:
        result["notesForCertification"] = notes
    # Listings, screenshots, pricing, declarations and other metadata stay as
    # returned by the API. Never copy certification notes into public listings.
    return result


def submit(client, env, path, *, sleep=time.sleep, transport=request, polls=40):
    package = package_details(path, env)
    mode = env.get("STORE_PUBLISH_MODE", "Manual")
    if mode not in {"Manual", "Immediate"}:
        raise StoreError("Invalid publication mode.")
    previous = check_ready(client, env)
    if any(version_tuple(p.get("version")) >= version_tuple(package["version"])
           for p in previous["applicationPackages"]):
        raise StoreError("Package version must exceed every published package; duplicate/rollback blocked.")
    # Finish all local work before the first mutation. Only packages enter this ZIP.
    with tempfile.TemporaryDirectory(prefix="sigma-store-") as directory:
        archive_path = Path(directory) / "submission.zip"
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_STORED) as archive:
            archive.write(path, package["fileName"])
        try:
            draft = client.call("/submissions", method="POST")
            submission_id = numeric_id(draft.get("id"))
            upload_url = validate_upload_url(draft.get("fileUploadUrl"))
            # A concurrent publisher must not change the baseline between checks.
            if draft.get("applicationPackages") != previous["applicationPackages"]:
                raise StoreError("Published packages changed during preparation.")
            updated = prepare_submission(draft, package, mode, env.get("WINDOWS_STORE_CERTIFICATION_NOTES"))
            client.call(f"/submissions/{submission_id}", method="PUT", data=updated)
            with archive_path.open("rb") as archive:
                transport(upload_url, method="PUT", headers={
                    "x-ms-blob-type": "BlockBlob", "x-ms-version": "2023-11-03",
                    "Content-Type": "application/zip", "Content-Length": str(archive_path.stat().st_size),
                }, body=archive, expect_json=False, timeout=600)
            client.call(f"/submissions/{submission_id}/commit", method="POST", expect_json=False)
        except Exception:
            # Do not retry POST or delete the draft: timeout may mean it committed.
            raise StoreError("Submission preparation/commit did not complete with confirmation. "
                             "A draft or committed submission may remain; run status before recovery. "
                             "Nothing was automatically deleted.") from None
    for attempt in range(polls):
        state = read_status(client, submission_id)
        if state in ACCEPTED:
            return state
        if attempt + 1 < polls:
            sleep(30)
    raise StoreError("Commit acceptance is still unconfirmed. Run status; do not create another submission.")


def status(client):
    app = client.call()
    submission = app.get("pendingApplicationSubmission") or app.get("lastPublishedApplicationSubmission")
    if not submission:
        report("NoSubmission", message="No draft or published submission was returned.")
        return
    return read_status(client, submission.get("id"))


def github_json(args):
    result = subprocess.run(["gh", *args], capture_output=True, check=False)
    if result.returncode:
        raise StoreError("GitHub release lookup/download failed; output is intentionally withheld.")
    try:
        return json.loads(result.stdout)
    except Exception:
        raise StoreError("GitHub returned an invalid response.") from None


def download(env, destination):
    tag = require(env, "STORE_RELEASE_TAG", r"v\d+\.\d+\.\d+")
    repository = require(env, "GITHUB_REPOSITORY", r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")
    release = github_json(["api", f"repos/{repository}/releases/tags/{tag}"])
    if release.get("tag_name") != tag or release.get("prerelease"):
        raise StoreError("Select an existing stable release tag.")
    filename = f"Sigma-Studio-Store-{tag[1:]}-x64.appx"
    assets = [asset for asset in release.get("assets", []) if asset.get("name") == filename]
    if len(assets) != 1 or not 0 < assets[0].get("size", 0) <= MAX_PACKAGE_BYTES:
        raise StoreError("The release has no valid x64 Store AppX asset. An NSIS EXE cannot be submitted here.")
    expected = env.get("STORE_PACKAGE_SHA256", "").lower()
    if not expected and env.get("GITHUB_EVENT_NAME") == "release":
        digest = assets[0].get("digest") or ""
        expected = digest.removeprefix("sha256:") if digest.startswith("sha256:") else ""
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise StoreError("A SHA-256 is required; automatic release submission needs GitHub's asset digest.")
    directory = Path(destination)
    directory.mkdir(parents=True, exist_ok=False, mode=0o700)
    result = subprocess.run(["gh", "release", "download", tag, "--repo", repository,
                             "--pattern", filename, "--dir", str(directory)], capture_output=True, check=False)
    if result.returncode:
        raise StoreError("GitHub package download failed; output is intentionally withheld.")
    path = directory / filename
    with path.open("rb") as package:
        if hashlib.file_digest(package, "sha256").hexdigest() != expected:
            raise StoreError("Downloaded package SHA-256 does not match.")
    # Only a public binary digest is persisted between Actions steps.
    (directory / "sha256").write_text(expected, encoding="ascii")
    report("PackageVerified", message="Existing Store package downloaded and hash verified; no build was run.")


def main():
    env = os.environ
    action = sys.argv[1] if len(sys.argv) > 1 else "preflight"
    if action == "download" and len(sys.argv) == 3:
        download(env, sys.argv[2])
        return
    client = StoreClient(env)
    if action == "preflight":
        check_ready(client, env)
        report("Ready", message="API access and published baseline verified; no submission was created.")
    elif action == "status":
        status(client)
    elif action == "submit" and len(sys.argv) == 3:
        submit(client, env, Path(sys.argv[2]))
    else:
        raise StoreError("Usage: windows_store.py preflight|status|submit <appx>|download <directory>")


if __name__ == "__main__":
    try:
        main()
    except StoreError as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
    except Exception:
        print("Store operation failed; diagnostic payloads are intentionally withheld.", file=sys.stderr)
        sys.exit(1)
