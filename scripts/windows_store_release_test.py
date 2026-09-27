"""CD selection/deferral tests. Fake services only; no credentials or network."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import windows_store as store
import windows_store_release as cd
from windows_store_test import ENV, FakeClient, PRIVATE_URL


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.release = {"tag_name": "v1.2.3", "draft": False, "prerelease": False,
                        "published_at": "2026-09-27T00:00:00Z"}
        self.env = {**ENV, "GITHUB_REPOSITORY": "owner/repo", "GITHUB_REF": "refs/heads/main",
                    "GITHUB_EVENT_NAME": "workflow_dispatch"}
        self.output = io.StringIO()
        self.enterContext(redirect_stdout(self.output))
        self.enterContext(patch.dict("os.environ", {}, clear=True))

    def test_latest_or_explicit_published_release_only(self):
        for tag, endpoint in [("", "latest"), ("v1.2.3", "tags/v1.2.3")]:
            with patch.object(store, "github_json", return_value=self.release) as lookup:
                self.assertEqual(cd.published_release({**self.env, "STORE_RELEASE_TAG": tag}), "v1.2.3")
                lookup.assert_called_once_with(["api", f"repos/owner/repo/releases/{endpoint}"])

    def test_draft_prerelease_deleted_or_mismatched_release_never_plans(self):
        for changes in [{"draft": True}, {"prerelease": True}, {"published_at": None},
                        {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3-rc.1"},
                        {"tag_name": "v1.2.3\nsubmit=true"}, {"tag_name": None}]:
            with self.subTest(changes=changes), patch.object(store, "github_json", return_value={**self.release, **changes}):
                with self.assertRaises(store.StoreError):
                    cd.published_release(self.env)
        for tag in ["main", "v1.2.3-rc.1", "v1.2.3\nsubmit=true", "../latest"]:
            with patch.object(store, "github_json") as lookup, self.assertRaises(store.StoreError):
                cd.published_release({**self.env, "STORE_RELEASE_TAG": tag})
            lookup.assert_not_called()

    def test_new_version_is_ready_without_mutations(self):
        client = FakeClient()
        self.assertEqual(cd.plan(client, self.env, "v1.2.3"), "ready")
        self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_same_or_older_published_version_is_noop(self):
        for version in ["1.2.3.0", "1.2.4.0", "2.0.0.0"]:
            client = FakeClient()
            client.previous["applicationPackages"][0]["version"] = version
            self.assertEqual(cd.plan(client, self.env, "v1.2.3"), "current")
            self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_in_progress_submission_is_deferred_without_recommit_or_delete(self):
        for state in store.ACCEPTED | {"CommitStarted"}:
            client = FakeClient([state])
            client.app["pendingApplicationSubmission"] = {"id": "2"}
            self.assertEqual(cd.plan(client, self.env, "v1.2.3"), "deferred")
            self.assertEqual(client.calls, [("GET", ""), ("GET", "/submissions/2/status")])

    def test_failed_or_uncommitted_submission_requires_recovery(self):
        for state in store.FAILED | {"PendingCommit", "None"}:
            client = FakeClient([state])
            client.app["pendingApplicationSubmission"] = {"id": "2"}
            with self.assertRaises(store.StoreError):
                cd.plan(client, self.env, "v1.2.3")
            self.assertTrue(all(method == "GET" for method, _ in client.calls))

    def test_wrong_application_and_unsupported_baseline_fail_closed(self):
        client = FakeClient()
        client.app["publisherName"] = "CN=Other"
        with self.assertRaises(store.StoreError):
            cd.plan(client, self.env, "v1.2.3")
        for change in [{"architecture": "arm64"}, {"version": "invalid-private-response"}]:
            client = FakeClient()
            client.previous["applicationPackages"][0].update(change)
            with self.assertRaises(store.StoreError):
                cd.plan(client, self.env, "v1.2.3")

    def test_private_status_details_do_not_enter_logs(self):
        client = FakeClient([{"status": "Certification", "statusDetails": {
            "warnings": [{"message": PRIVATE_URL}], "notes": ENV["WINDOWS_STORE_CLIENT_SECRET"]}}])
        client.app["pendingApplicationSubmission"] = {"id": "2"}
        cd.plan(client, self.env, "v1.2.3")
        for private in [PRIVATE_URL, ENV["WINDOWS_STORE_CLIENT_SECRET"], ENV["WINDOWS_STORE_PUBLISHER"]]:
            self.assertNotIn(private, self.output.getvalue())

    def test_workflow_outputs_only_build_or_submit_when_safe(self):
        for mode, state, expected in [
            ("false", "ready", ("true", "true")),
            ("false", "current", ("false", "false")),
            ("false", "deferred", ("false", "false")),
            ("true", "ready", ("true", "false")),
            ("true", "current", ("true", "false")),
            ("true", "deferred", ("true", "false")),
        ]:
            with self.subTest(mode=mode, state=state), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "outputs"
                with patch.dict("os.environ", {**self.env, "STORE_VERIFY_ONLY": mode, "GITHUB_OUTPUT": str(path)}), \
                        patch.object(cd, "published_release", return_value="v1.2.3"), \
                        patch.object(store, "StoreClient"), patch.object(cd, "plan", return_value=state):
                    cd.main()
                self.assertEqual(path.read_text(), f"release_tag=v1.2.3\nbuild={expected[0]}\nsubmit={expected[1]}\n")

    def test_only_main_dispatch_and_schedule_can_plan(self):
        for change in [{"GITHUB_REF": "refs/tags/v1.2.3"}, {"GITHUB_REF": "refs/heads/feature"},
                       {"GITHUB_EVENT_NAME": "pull_request"}, {"GITHUB_EVENT_NAME": "release"}]:
            with patch.dict("os.environ", {**self.env, **change}), patch.object(store, "StoreClient") as client:
                with self.assertRaises(store.StoreError):
                    cd.main()
                client.assert_not_called()


if __name__ == "__main__":
    unittest.main()
