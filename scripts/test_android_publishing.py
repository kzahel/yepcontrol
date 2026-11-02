#!/usr/bin/env python3
"""Release transaction regressions; no credentials or network required."""

import hashlib
import copy
import json
from pathlib import Path
import tempfile
import unittest

from publish_android_bundle import publish, verify_candidate, safe_play_error, request_accepted_code14_review
from verify_android_release import verify_build, has_source_checks


BUNDLE = b"signed candidate fixture"
DIGEST = hashlib.sha256(BUNDLE).hexdigest()


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


class PublishingTest(unittest.TestCase):
    def test_accepted_review_is_bounded_to_exact_bytes_tracks_countries_and_copy(self):
        class ReviewPlay(FakePlay):
            def __init__(self):
                super().__init__()
                self.tracks = [{"track": t, "releases": [{"versionCodes": ["14"],
                    "status": "completed", "name": "0.12.0"}]} for t in ["internal", "production"]]
                self.countries = {"countries": [{"countryCode": str(n)} for n in range(178)]}
                self.listings = [{"language": "en-US", "title": "YepControl – Remote Phone",
                                  "fullDescription": "Accepted copy"}]
                self.bundle_hash = "39f449794070cb336bbb31d2fa3d9941ae32f090582d7dfc3814882fb305d65f"
                self.change = False
                self.timeout = False

            def call(self, method, path, body=None, upload=False):
                self.calls.append((method, path, body))
                if path == "":
                    return {"id": "edit-1"}
                if path.endswith("/bundles"):
                    return {"bundles": [{"versionCode": 14, "sha256": self.bundle_hash}]}
                if path.endswith("/tracks"):
                    return {"tracks": copy.deepcopy(self.tracks)}
                if path.endswith("/countryAvailability/production"):
                    return copy.deepcopy(self.countries)
                if path.endswith("/listings"):
                    return {"listings": copy.deepcopy(self.listings)}
                if path.endswith(":validate") and self.change:
                    self.tracks[1]["releases"][0]["versionCodes"] = ["15"]
                if ":commit" in path and self.timeout:
                    raise TimeoutError("unknown remote outcome")
                return {}

        args = ("39f449794070cb336bbb31d2fa3d9941ae32f090582d7dfc3814882fb305d65f",
                "b7473f0e946f6a9d858f6872d824c8f2fc495789", "41354475580", "Accepted copy")
        play = ReviewPlay()
        result = request_accepted_code14_review(play, *args)
        self.assertTrue(result["reviewRequested"])
        self.assertEqual(result["rollout"], 100)
        self.assertFalse(any(m == "PUT" or "uploadType" in p for m, p, _ in play.calls))
        self.assertEqual(play.calls[-1][:2], ("POST", "/edit-1:commit?changesNotSentForReview=false"
                                            "&changesInReviewBehavior=ERROR_IF_IN_REVIEW"))
        for field in range(3):
            wrong = list(args)
            wrong[field] = "wrong"
            play = ReviewPlay()
            with self.assertRaises(ValueError):
                request_accepted_code14_review(play, *wrong)
            self.assertEqual(play.calls, [])
        for scenario in ["hash", "production", "fraction", "targeting", "other", "country", "listing", "concurrent"]:
            with self.subTest(scenario=scenario):
                play = ReviewPlay()
                if scenario == "hash": play.bundle_hash = "wrong"
                elif scenario == "production": play.tracks[1]["releases"][0]["versionCodes"] = ["13"]
                elif scenario == "fraction": play.tracks[1]["releases"][0]["userFraction"] = 0.5
                elif scenario == "targeting": play.tracks[1]["releases"][0]["countryTargeting"] = {}
                elif scenario == "other": play.tracks.append({"track": "beta", "releases": [{}]})
                elif scenario == "country": play.countries["countries"].pop()
                elif scenario == "listing": play.listings[0]["fullDescription"] = "Other copy"
                elif scenario == "concurrent": play.change = True
                with self.assertRaises(ValueError):
                    request_accepted_code14_review(play, *args)
                self.assertFalse(any(m == "PUT" or ":commit" in p for m, p, _ in play.calls))
                self.assertEqual(play.calls[-1][:2], ("DELETE", "/edit-1"))
        play = ReviewPlay()
        play.timeout = True
        with self.assertRaises(TimeoutError):
            request_accepted_code14_review(play, *args)
        self.assertEqual(sum(":commit" in p for _, p, _ in play.calls), 1)
        self.assertFalse(any(m == "DELETE" for m, _, _ in play.calls))

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
