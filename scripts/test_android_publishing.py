#!/usr/bin/env python3
"""Release transaction regressions; no credentials or network required."""

import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from publish_android_bundle import publish, verify_candidate, safe_play_error, reconcile_code14
from verify_android_release import verify_build, has_source_checks


BUNDLE = b"signed candidate fixture"
DIGEST = hashlib.sha256(BUNDLE).hexdigest()
CODE14_DIGEST = "39f449794070cb336bbb31d2fa3d9941ae32f090582d7dfc3814882fb305d65f"
CODE14_SOURCE = "b7473f0e946f6a9d858f6872d824c8f2fc495789"


class FakePlay:
    def __init__(self, releases=None, uploaded=None, failure=None, other_tracks=None):
        self.releases = releases or []
        self.uploaded = uploaded or []
        self.failure = failure
        self.calls = []
        self.other_tracks = other_tracks or []

    def call(self, method, path, body=None, upload=False):
        self.calls.append((method, path, body))
        if self.failure and self.failure in path:
            raise TimeoutError("unknown remote outcome")
        if path == "":
            return {"id": "edit-1"}
        if path.endswith("/tracks"):
            return {"tracks": [{"track": "internal", "releases": self.releases}] + self.other_tracks}
        if path.endswith("/bundles"):
            return {"bundles": self.uploaded}
        if upload:
            return {"versionCode": 2, "sha256": DIGEST}
        return {}


class RecoveryPlay(FakePlay):
    def __init__(self):
        super().__init__(releases=[{"versionCodes": ["14"], "status": "completed"}],
                         uploaded=[{"versionCode": 14, "sha256": CODE14_DIGEST}],
                         other_tracks=[{"track": "production", "releases": [
                             {"versionCodes": ["13"], "status": "completed"}]}])

    def call(self, method, path, body=None, upload=False):
        if method == "GET" and path == "/123":
            self.calls.append((method, path, body))
            return {"id": "123"}
        return super().call(method, path, body, upload)


class PublishingTest(unittest.TestCase):
    def recover14(self, play, digest=CODE14_DIGEST, source=CODE14_SOURCE, run_id="41354475580"):
        return reconcile_code14(play, "123", digest, source, run_id)

    def test_recovery_commits_existing_bytes_without_track_write_or_upload(self):
        play = RecoveryPlay()
        result = self.recover14(play)
        self.assertEqual(result["versionCode"], 14)
        self.assertEqual(result["existingProductionVersionCode"], 13)
        self.assertTrue(result["reviewRequested"])
        self.assertEqual([(m, p) for m, p, _ in play.calls if m != "GET"], [
            ("POST", "/123:validate"), ("POST", "/123:commit?changesNotSentForReview=false"
             "&changesInReviewBehavior=ERROR_IF_IN_REVIEW")])

    def test_recovery_refuses_other_artifacts_before_access(self):
        for values in [{"digest": "a" * 64}, {"source": "a" * 40}, {"run_id": "1"}]:
            play = RecoveryPlay()
            with self.assertRaises(ValueError):
                self.recover14(play, **values)
            self.assertEqual(play.calls, [])

    def test_recovery_refuses_other_server_state_without_mutation(self):
        for kind in ["different-bytes", "new-production", "draft-production", "other-track"]:
            play = RecoveryPlay()
            if kind == "different-bytes": play.uploaded[0]["sha256"] = "a" * 64
            if kind == "new-production": play.other_tracks[0]["releases"][0]["versionCodes"] = ["14"]
            if kind == "draft-production": play.other_tracks[0]["releases"][0]["status"] = "draft"
            if kind == "other-track": play.other_tracks.append({"track": "beta", "releases": [{"versionCodes": ["13"]}]})
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.recover14(play)
            self.assertTrue(all(m == "GET" for m, _, _ in play.calls))

    def test_recovery_preserves_edit_after_unknown_commit_outcome(self):
        play = RecoveryPlay()
        play.failure = ":commit?"
        with self.assertRaises(TimeoutError): self.recover14(play)
        self.assertFalse(any(m in {"DELETE", "PUT"} for m, _, _ in play.calls))

    def test_api_diagnostics_exclude_arbitrary_response_text(self):
        raw = json.dumps({"error": {"status": "INVALID_ARGUMENT", "message":
            "It is not allowed to set the query parameter changesNotSentForReview to true. Please remove the query parameter."}})
        self.assertEqual(safe_play_error(raw), "INVALID_ARGUMENT; review_deferral_parameter")
        raw = json.dumps({"error": {"status": "FAILED_PRECONDITION", "message":
            "You already have changes in review. private@example.invalid bearer-fixture"}})
        self.assertEqual(safe_play_error(raw), "FAILED_PRECONDITION; changes_already_in_review")
        for raw in ['not JSON', '[]', '{"error":null}',
                    json.dumps({"error": {"status": "private@example.invalid", "message": "bearer-fixture"}})]:
            self.assertEqual(safe_play_error(raw), "unclassified")

    def run_publish(self, play, status="completed"):
        return publish(play, BUNDLE, DIGEST, 2, "0.1.1", "internal", status, "Tracking improvements.")

    def test_validate_precedes_internal_commit_without_review_request(self):
        play = FakePlay()
        result = self.run_publish(play)
        self.assertEqual(result["status"], "internal_committed")
        self.assertFalse(result["reviewRequested"])
        self.assertEqual([p for m, p, _ in play.calls if m == "POST"][-2:],
                         ["/edit-1:validate", "/edit-1:commit?changesNotSentForReview=true"
                          "&changesInReviewBehavior=ERROR_IF_IN_REVIEW"])
        self.assertFalse(any(m == "DELETE" for m, _, _ in play.calls))

    def test_pending_production_is_not_written_or_requested_for_review(self):
        play = FakePlay(other_tracks=[{"track": "production", "releases": [
            {"status": "completed", "versionCodes": ["9"]}]}])
        self.run_publish(play)
        self.assertEqual([p for m, p, _ in play.calls if m == "PUT"],
                         ["/edit-1/tracks/internal"])
        self.assertEqual([p for m, p, _ in play.calls if ":commit" in p],
                         ["/edit-1:commit?changesNotSentForReview=true"
                          "&changesInReviewBehavior=ERROR_IF_IN_REVIEW"])

    def test_reject_mismatched_existing_bytes_without_track_write(self):
        play = FakePlay(uploaded=[{"versionCode": 2, "sha256": "bad"}])
        with self.assertRaisesRegex(ValueError, "checksum"):
            self.run_publish(play)
        self.assertFalse(any(m == "PUT" for m, _, _ in play.calls))
        self.assertEqual(play.calls[-1][:2], ("DELETE", "/edit-1"))

    def test_refuse_downgrade_and_existing_unrelated_draft(self):
        for release in ({"status": "completed", "versionCodes": ["3"]},
                        {"status": "draft", "versionCodes": ["1"]},
                        {"status": "inProgress", "versionCodes": ["1"]}):
            with self.subTest(release=release):
                play = FakePlay(releases=[release])
                with self.assertRaises(ValueError):
                    self.run_publish(play)
                self.assertFalse(any(m == "PUT" for m, _, _ in play.calls))

    def test_promote_the_same_verified_draft(self):
        play = FakePlay(releases=[{"status": "draft", "versionCodes": ["2"]}],
                        uploaded=[{"versionCode": 2, "sha256": DIGEST}])
        self.assertEqual(self.run_publish(play)["status"], "internal_committed")
        self.assertFalse(any("uploadType" in p for _, p, _ in play.calls))

    def test_retry_same_release_checks_bytes_and_does_not_commit(self):
        play = FakePlay(releases=[{"status": "completed", "versionCodes": ["2"]}],
                        uploaded=[{"versionCode": 2, "sha256": DIGEST}])
        self.assertEqual(self.run_publish(play)["status"], "unchanged")
        self.assertFalse(any(m == "PUT" or ":commit" in p for m, p, _ in play.calls))

    def test_validation_failure_discards_edit_without_draft_fallback(self):
        play = FakePlay(failure=":validate")
        with self.assertRaises(TimeoutError):
            self.run_publish(play)
        self.assertEqual(play.calls[-1][:2], ("DELETE", "/edit-1"))
        self.assertFalse(any(":commit" in p for _, p, _ in play.calls))

    def test_unknown_commit_does_not_retry_or_delete(self):
        play = FakePlay(failure=":commit")
        with self.assertRaises(TimeoutError):
            self.run_publish(play)
        self.assertEqual(sum(":commit" in p for _, p, _ in play.calls), 1)
        self.assertFalse(any(m == "DELETE" for m, _, _ in play.calls))

    def test_draft_is_not_reported_as_published(self):
        self.assertEqual(self.run_publish(FakePlay(), status="draft")["status"], "draft_saved")

    def test_check_authentication_does_not_upload_or_change_a_track(self):
        play = FakePlay()
        self.assertEqual(self.run_publish(play, status="check")["status"], "access_verified")
        self.assertFalse(any(m == "PUT" or "uploadType" in p or ":commit" in p
                             for m, p, _ in play.calls))
        self.assertEqual(play.calls[-1][:2], ("DELETE", "/edit-1"))

    def test_release_provenance_refuses_other_sources_and_workflows(self):
        run = {"head_repository": {"full_name": "owner/repo"}, "event": "workflow_dispatch", "head_branch": "main", "head_sha": "a" * 40, "path": ".github/workflows/android-release.yml", "status": "completed", "conclusion": "success"}
        verify_build(run, "owner/repo", "a" * 40)
        for field, value in (("head_sha", "b" * 40), ("head_branch", "other"), ("event", "pull_request"), ("path", ".github/workflows/other.yml"), ("conclusion", "failure")):
            with self.subTest(field=field), self.assertRaises(ValueError):
                verify_build(run | {field: value}, "owner/repo", "a" * 40)
        checks = run | {"event": "push", "path": ".github/workflows/checks.yml"}
        self.assertTrue(has_source_checks([checks], "owner/repo", "a" * 40))
        self.assertFalse(has_source_checks([checks], "owner/repo", "b" * 40))
        self.assertFalse(has_source_checks([checks], "other/repo", "a" * 40))

    def test_production_is_outside_beta_publisher_authority(self):
        play = FakePlay()
        with self.assertRaises(ValueError):
            publish(play, BUNDLE, DIGEST, 2, "0.1.1", "production", "completed", "Notes")
        self.assertEqual(play.calls, [])

    def test_receipt_and_bytes_must_match_the_requested_ci_run(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            receipt = {"GITHUB_SHA": "a" * 40, "GITHUB_RUN_ID": "123",
                       "RELEASE_CODE": "2", "RELEASE_NAME": "0.1.1"}
            (root / "build.json").write_text(json.dumps(receipt))
            (root / "yepcontrol.aab").write_bytes(BUNDLE)
            (root / "yepcontrol.aab.sha256").write_text(f"{DIGEST}  yepcontrol.aab\n")
            self.assertEqual(verify_candidate(root, "a" * 40, "123", "2", "0.1.1")[1], DIGEST)
            with self.assertRaisesRegex(ValueError, "GITHUB_RUN_ID"):
                verify_candidate(root, "a" * 40, "124", "2", "0.1.1")
            with self.assertRaisesRegex(ValueError, "RELEASE_NAME"):
                verify_candidate(root, "a" * 40, "123", "2", "0.1.2")
            for change in ({"RELEASE_CODE": "3"}, {"RELEASE_NAME": "0.1.2"}):
                (root / "build.json").write_text(json.dumps(receipt | change))
                with self.assertRaisesRegex(ValueError, "RELEASE_"):
                    verify_candidate(root, "a" * 40, "123", "2", "0.1.1")
            (root / "build.json").write_text(json.dumps(receipt))
            (root / "yepcontrol.aab").write_bytes(b"tampered")
            with self.assertRaisesRegex(ValueError, "checksum"):
                verify_candidate(root, "a" * 40, "123", "2", "0.1.1")


if __name__ == "__main__":
    unittest.main()
