"""Offline tests: no credentials or requests to Microsoft/GitHub."""

from contextlib import redirect_stdout
import copy
import hashlib
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import windows_store as store


ENV = {
    "WINDOWS_STORE_TENANT_ID": "00000000-0000-0000-0000-000000000001",
    "WINDOWS_STORE_CLIENT_ID": "00000000-0000-0000-0000-000000000002",
    "WINDOWS_STORE_CLIENT_SECRET": "test-credential-never-log",
    "WINDOWS_STORE_APPLICATION_ID": "9TESTAPP0001",
    "WINDOWS_STORE_IDENTITY_NAME": "Test.SigmaStudio",
    "WINDOWS_STORE_PUBLISHER": "CN=Test",
    "WINDOWS_STORE_CERTIFICATION_NOTES": "private-review-notes-never-log",
    "STORE_RELEASE_TAG": "v1.2.3",
}
PRIVATE_URL = "https://test.blob.core.windows.net/ingestion/upload?sig=test-sas-never-log"


def published():
    return {
        "id": "1", "status": "Published", "targetPublishMode": "Immediate",
        "applicationPackages": [{"id": "10", "fileName": "old.appx", "fileStatus": "Uploaded",
                                 "version": "1.2.2.0", "architecture": "x64"}],
        "listings": {"ja-jp": {"baseListing": {"description": "公開説明", "images": ["keep"]}}},
        "pricing": {"priceId": "Free"}, "notesForCertification": "old-private-notes",
        "packageDeliveryOptions": {"isMandatoryUpdate": False, "packageRollout": {"isPackageRollout": False}},
    }


class FakeClient:
    app_id = ENV["WINDOWS_STORE_APPLICATION_ID"]

    def __init__(self, states=None):
        self.app = {"id": self.app_id, "packageIdentityName": ENV["WINDOWS_STORE_IDENTITY_NAME"],
                    "publisherName": ENV["WINDOWS_STORE_PUBLISHER"],
                    "lastPublishedApplicationSubmission": {"id": "1"}}
        self.previous = published()
        self.states = iter(states or ["CommitStarted", "PreProcessing"])
        self.calls = []
        self.updated = None
        self.draft_changes = {}

    def call(self, suffix="", *, method="GET", data=None, expect_json=True):
        self.calls.append((method, suffix))
        if not suffix:
            return copy.deepcopy(self.app)
        if suffix == "/submissions/1" and method == "GET":
            return copy.deepcopy(self.previous)
        if method == "POST" and suffix == "/submissions":
            return {**copy.deepcopy(self.previous), "id": "2", "status": "PendingCommit",
                    "fileUploadUrl": PRIVATE_URL, **self.draft_changes}
        if method == "PUT":
            self.updated = data
            return data
        if suffix.endswith("/commit"):
            return None
        if suffix.endswith("/status"):
            value = next(self.states)
            return {"status": value} if isinstance(value, str) else value
        raise AssertionError("Unexpected test request")


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "Sigma-Studio-Store-1.2.3-x64.appx"
        self.env = dict(ENV)
        self.write_package()

    def write_package(self, *, name="Test.SigmaStudio", publisher="CN=Test", version="1.2.3.0", arch="x64"):
        with zipfile.ZipFile(self.path, "w") as archive:
            archive.writestr("AppxManifest.xml", (
                '<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">'
                f'<Identity Name="{name}" Publisher="{publisher}" Version="{version}" '
                f'ProcessorArchitecture="{arch}"/></Package>'
            ))
            archive.writestr("app.exe", b"test-only-binary")
        self.env["STORE_PACKAGE_SHA256"] = hashlib.sha256(self.path.read_bytes()).hexdigest()

    def test_submit_uploads_only_package_and_preserves_public_metadata(self):
        client = FakeClient()
        before = copy.deepcopy(client.previous)
        uploaded = []

        def upload(url, **options):
            self.assertEqual(url, PRIVATE_URL)
            self.assertNotIn("Authorization", options["headers"])
            self.assertEqual(options["headers"]["x-ms-blob-type"], "BlockBlob")
            with zipfile.ZipFile(io.BytesIO(options["body"].read())) as archive:
                self.assertEqual(archive.namelist(), [self.path.name])
                self.assertEqual(archive.read(self.path.name), self.path.read_bytes())
            uploaded.append(True)

        output = io.StringIO()
        with patch.dict("os.environ", {}, clear=True), redirect_stdout(output):
            result = store.submit(client, self.env, self.path, sleep=lambda _: None, transport=upload)
        self.assertEqual(result, "PreProcessing")
        self.assertEqual(uploaded, [True])
        self.assertEqual(client.previous, before)
        self.assertEqual(client.updated["listings"], before["listings"])
        self.assertEqual(client.updated["pricing"], before["pricing"])
        self.assertEqual(client.updated["targetPublishMode"], "Manual")
        self.assertEqual(client.updated["notesForCertification"], ENV["WINDOWS_STORE_CERTIFICATION_NOTES"])
        self.assertEqual([p["fileStatus"] for p in client.updated["applicationPackages"]], ["PendingDelete", "PendingUpload"])
        self.assertEqual(client.calls.count(("POST", "/submissions/2/commit")), 1)
        for private in [PRIVATE_URL, ENV["WINDOWS_STORE_CLIENT_SECRET"], ENV["WINDOWS_STORE_CERTIFICATION_NOTES"]]:
            self.assertNotIn(private, output.getvalue())

    def test_pending_submission_blocks_all_mutations(self):
        client = FakeClient()
        client.app["pendingApplicationSubmission"] = {"id": "99"}
        with self.assertRaisesRegex(store.StoreError, "existing submission"):
            store.submit(client, self.env, self.path)
        self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_first_submission_and_wrong_application_blocked(self):
        for change in [{"lastPublishedApplicationSubmission": None}, {"id": "OTHER"},
                       {"publisherName": "CN=Other"}, {"packageIdentityName": "Other"}]:
            client = FakeClient()
            client.app.update(change)
            with self.assertRaises(store.StoreError):
                store.check_ready(client, self.env)
            self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_changed_architecture_version_and_rollout_blocked(self):
        for kind in ["arch", "version", "rollout", "mandatory"]:
            client = FakeClient()
            if kind == "arch":
                client.previous["applicationPackages"][0]["architecture"] = "ARM64"
            elif kind == "version":
                client.previous["applicationPackages"][0]["version"] = "1.2.3.0"
            elif kind == "rollout":
                client.previous["packageDeliveryOptions"]["packageRollout"]["isPackageRollout"] = True
            else:
                client.previous["packageDeliveryOptions"]["isMandatoryUpdate"] = True
            with self.assertRaises(store.StoreError):
                store.submit(client, self.env, self.path)
            self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_bad_package_stops_before_network(self):
        for overrides in [{"name": "Other"}, {"publisher": "CN=Other"}, {"version": "1.2.3.1"},
                          {"version": "1.2.4.0"}, {"arch": "arm64"}]:
            self.write_package(**overrides)
            client = FakeClient()
            with self.assertRaises(store.StoreError):
                store.submit(client, self.env, self.path)
            self.assertEqual(client.calls, [])
        self.write_package()
        self.env["STORE_PACKAGE_SHA256"] = "0" * 64
        with self.assertRaisesRegex(store.StoreError, "SHA-256"):
            store.package_details(self.path, self.env)

    def test_store_version_rules_allow_store_assigned_revision_only_on_baseline(self):
        self.assertEqual(store.version_tuple("1.2.2.42"), (1, 2, 2, 42))
        for version in ["0.500.0.0", "1.2.3.1", "1.65536.0.0", "1.2.3", "1.2.3.0x"]:
            with self.assertRaises(store.StoreError):
                store.version_tuple(version, uploading=True)

    def test_multiversion_baseline_is_not_silently_removed(self):
        client = FakeClient()
        client.previous["applicationPackages"].append({**client.previous["applicationPackages"][0], "id": "11"})
        with self.assertRaisesRegex(store.StoreError, "single x64"):
            store.submit(client, self.env, self.path)
        self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_upload_failure_does_not_commit_retry_or_delete(self):
        client = FakeClient()
        temporary_archives = []

        def fail(*args, **kwargs):
            temporary_archives.append(Path(kwargs["body"].name))
            raise RuntimeError(PRIVATE_URL)

        with self.assertRaises(store.StoreError) as raised:
            store.submit(client, self.env, self.path, transport=fail)
        self.assertNotIn(PRIVATE_URL, str(raised.exception))
        self.assertIn("may remain", str(raised.exception))
        self.assertFalse(any(method == "DELETE" or suffix.endswith("/commit") for method, suffix in client.calls))
        self.assertEqual(client.calls.count(("POST", "/submissions")), 1)
        self.assertEqual(len(temporary_archives), 1)
        self.assertFalse(temporary_archives[0].exists())
        self.assertFalse(temporary_archives[0].parent.exists())

    def test_concurrent_baseline_change_stops_before_upload(self):
        client = FakeClient()
        client.draft_changes["applicationPackages"] = []
        with self.assertRaises(store.StoreError):
            store.submit(client, self.env, self.path)
        self.assertFalse(any(method == "PUT" or suffix.endswith("/commit") for method, suffix in client.calls))

    def test_unknown_failure_status_and_provider_details_are_not_printed(self):
        for state in ["CertificationFailed", "Canceled", "not-a-status-private-detail", "Published"]:
            client = FakeClient([{"status": state, "statusDetails": {
                "errors": [{"message": PRIVATE_URL}], "warnings": [ENV["WINDOWS_STORE_CLIENT_SECRET"]],
                "certificationReports": [ENV["WINDOWS_STORE_CERTIFICATION_NOTES"]],
            }}])
            output = io.StringIO()
            with patch.dict("os.environ", {}, clear=True), redirect_stdout(output):
                with self.assertRaises(store.StoreError) as raised:
                    store.read_status(client, "2")
            combined = output.getvalue() + str(raised.exception)
            self.assertNotIn(PRIVATE_URL, combined)
            self.assertNotIn(ENV["WINDOWS_STORE_CLIENT_SECRET"], combined)
            self.assertNotIn(ENV["WINDOWS_STORE_CERTIFICATION_NOTES"], combined)

    def test_status_prefers_current_submission_and_never_writes(self):
        client = FakeClient(["PendingPublication"])
        client.app["pendingApplicationSubmission"] = {"id": "2"}
        with patch.dict("os.environ", {}, clear=True), redirect_stdout(io.StringIO()):
            self.assertEqual(store.status(client), "PendingPublication")
        self.assertEqual(client.calls, [("GET", ""), ("GET", "/submissions/2/status")])

    def test_commit_timeout_is_not_certification_success(self):
        client = FakeClient(["CommitStarted"])
        with patch.dict("os.environ", {}, clear=True), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(store.StoreError, "still unconfirmed"):
                store.submit(client, self.env, self.path, transport=lambda *a, **kw: None, polls=1)

    def test_upload_url_rejects_other_hosts_and_credentials(self):
        self.assertEqual(store.validate_upload_url(PRIVATE_URL), PRIVATE_URL)
        for url in ["http://test.blob.core.windows.net/ingestion/x?sig=x",
                    "https://test.blob.core.windows.net.evil.test/ingestion/x?sig=x",
                    "https://user@test.blob.core.windows.net/ingestion/x?sig=x",
                    "https://test.blob.core.windows.net:443/ingestion/x?sig=x",
                    "https://test.blob.core.windows.net/other/x?sig=x", PRIVATE_URL + "#x"]:
            with self.assertRaises(store.StoreError):
                store.validate_upload_url(url)

    def test_authentication_is_memory_only_and_uses_fixed_destinations(self):
        calls = []

        def transport(url, **kwargs):
            calls.append((url, kwargs))
            return {"access_token": "test-token"} if len(calls) == 1 else {"id": ENV["WINDOWS_STORE_APPLICATION_ID"]}

        client = store.StoreClient(self.env, transport=transport)
        client.call()
        client.call()
        self.assertEqual(len(calls), 3)
        self.assertTrue(calls[0][0].startswith("https://login.microsoftonline.com/"))
        self.assertIn(b"grant_type=client_credentials", calls[0][1]["body"])
        self.assertNotIn("Authorization", calls[0][1]["headers"])
        self.assertEqual(calls[1][1]["headers"]["Authorization"], "Bearer test-token")
        self.assertTrue(calls[1][0].startswith(store.API + "/"))

    def test_http_errors_and_redirects_never_expose_payload_or_destination(self):
        for status in [302, 400, 401, 403, 409, 500]:
            with patch.object(store.http.client, "HTTPSConnection") as factory:
                response = factory.return_value.getresponse.return_value
                response.status = status
                response.read.return_value = PRIVATE_URL.encode()
                with self.assertRaises(store.StoreError) as raised:
                    store.request(PRIVATE_URL)
                self.assertNotIn(PRIVATE_URL, str(raised.exception))
                self.assertIn(str(status), str(raised.exception))
                response.read.assert_not_called()
                factory.return_value.close.assert_called_once()

    def test_network_exception_and_json_errors_are_redacted(self):
        with patch.object(store.http.client, "HTTPSConnection") as factory:
            factory.return_value.request.side_effect = RuntimeError(PRIVATE_URL)
            with self.assertRaises(store.StoreError) as raised:
                store.request(PRIVATE_URL)
            self.assertNotIn(PRIVATE_URL, str(raised.exception))
        with patch.object(store.http.client, "HTTPSConnection") as factory:
            response = factory.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = PRIVATE_URL.encode()
            with self.assertRaises(store.StoreError) as raised:
                store.request(PRIVATE_URL)
            self.assertNotIn(PRIVATE_URL, str(raised.exception))

    def test_download_requires_appx_and_manual_digest(self):
        release = {"tag_name": "v1.2.3", "assets": [{"name": self.path.name, "size": 300}]}
        env = {**self.env, "GITHUB_REPOSITORY": "owner/repo"}
        for changes in [{"assets": []}, {"prerelease": True}]:
            with patch.object(store, "github_json", return_value={**release, **changes}):
                with self.assertRaises(store.StoreError):
                    store.download(env, Path(self.temp.name) / "download")
        env.pop("STORE_PACKAGE_SHA256")
        with patch.object(store, "github_json", return_value=release):
            with self.assertRaisesRegex(store.StoreError, "SHA-256 is required"):
                store.download(env, Path(self.temp.name) / "download")

    def test_automatic_download_uses_asset_digest_and_persists_only_public_hash(self):
        release = {"tag_name": "v1.2.3", "assets": [{"name": self.path.name, "size": self.path.stat().st_size,
                   "digest": "sha256:" + self.env["STORE_PACKAGE_SHA256"]}]}
        env = {**self.env, "GITHUB_REPOSITORY": "owner/repo", "GITHUB_EVENT_NAME": "release"}
        env.pop("STORE_PACKAGE_SHA256")
        destination = Path(self.temp.name) / "download"

        def run(args, **kwargs):
            self.assertNotIn(ENV["WINDOWS_STORE_CLIENT_SECRET"], args)
            (destination / self.path.name).write_bytes(self.path.read_bytes())
            return store.subprocess.CompletedProcess(args, 0)

        with patch.object(store, "github_json", return_value=release), patch.object(store.subprocess, "run", side_effect=run), \
                patch.dict("os.environ", {}, clear=True), redirect_stdout(io.StringIO()):
            store.download(env, destination)
        self.assertEqual((destination / "sha256").read_text(), self.env["STORE_PACKAGE_SHA256"])
        self.assertEqual(sorted(p.name for p in destination.iterdir()), sorted([self.path.name, "sha256"]))

    def test_private_provider_details_do_not_reach_saved_actions_summary(self):
        summary = Path(self.temp.name) / "summary.md"
        client = FakeClient([{"status": "Certification", "statusDetails": {
            "warnings": [{"message": PRIVATE_URL}], "certificationReports": [ENV["WINDOWS_STORE_CERTIFICATION_NOTES"]],
        }}])
        with patch.dict("os.environ", {"GITHUB_STEP_SUMMARY": str(summary)}, clear=True), redirect_stdout(io.StringIO()):
            store.read_status(client, "2")
        persisted = summary.read_text()
        self.assertIn("Certification", persisted)
        self.assertIn("warnings=1", persisted)
        self.assertNotIn(PRIVATE_URL, persisted)
        self.assertNotIn(ENV["WINDOWS_STORE_CERTIFICATION_NOTES"], persisted)

    def test_creation_timeout_does_not_retry_or_delete(self):
        client = FakeClient()
        original_call = client.call

        def call(suffix="", **kwargs):
            if suffix == "/submissions":
                client.calls.append(("POST", suffix))
                raise RuntimeError(PRIVATE_URL)
            return original_call(suffix, **kwargs)

        client.call = call
        with self.assertRaisesRegex(store.StoreError, "may remain") as raised:
            store.submit(client, self.env, self.path)
        self.assertNotIn(PRIVATE_URL, str(raised.exception))
        self.assertEqual(client.calls.count(("POST", "/submissions")), 1)
        self.assertFalse(any(method == "DELETE" for method, _ in client.calls))


if __name__ == "__main__":
    unittest.main()
