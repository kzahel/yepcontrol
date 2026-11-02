#!/usr/bin/env python3
"""Upload a verified CI bundle through a transactional Google Play edit."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen

from release_metadata import read_version


PACKAGE = "com.yepcontrol.app"
API = "https://androidpublisher.googleapis.com"


def safe_play_error(raw):
    """Expose fixed diagnostic labels, never Google's arbitrary response text."""
    try:
        error = json.loads(raw).get("error", {})
        message = error.get("message", "")
        status = error.get("status", "")
        if not isinstance(message, str):
            return "unclassified"
        labels = []
        if status in {"INVALID_ARGUMENT", "FAILED_PRECONDITION", "PERMISSION_DENIED",
                      "UNAUTHENTICATED", "NOT_FOUND", "ALREADY_EXISTS", "ABORTED",
                      "RESOURCE_EXHAUSTED", "INTERNAL", "UNAVAILABLE"}:
            labels.append(status)
        if "changesNotSentForReview" in message:
            labels.append("review_deferral_parameter")
        if "changesInReviewBehavior" in message:
            labels.append("review_behavior_parameter")
        if message.startswith("You already have changes in review."):
            labels.append("changes_already_in_review")
        return "; ".join(labels) or "unclassified"
    except (ValueError, AttributeError, TypeError):
        return "unclassified"


def verify_candidate(directory, source, run_id, version_code, version_name):
    read_version(f"VERSION_NAME={version_name}\nVERSION_CODE={version_code}\n")
    receipt = json.loads((directory / "build.json").read_text())
    if not re.fullmatch(r"[a-f0-9]{40}", source):
        raise ValueError("Invalid source revision")
    if not 1 <= int(version_code) <= 2100000000:
        raise ValueError("Invalid version code")
    for key, expected in (("GITHUB_SHA", source), ("GITHUB_RUN_ID", run_id),
                          ("RELEASE_CODE", version_code), ("RELEASE_NAME", version_name)):
        if receipt.get(key) != str(expected):
            raise ValueError(f"Candidate receipt differs: {key}")
    bundle = (directory / "yepcontrol.aab").read_bytes()
    digest = hashlib.sha256(bundle).hexdigest()
    if (directory / "yepcontrol.aab.sha256").read_text().split() != [digest, "yepcontrol.aab"]:
        raise ValueError("Candidate checksum differs")
    return bundle, digest, receipt["RELEASE_NAME"]


class Play:
    def __init__(self, token):
        if not token:
            raise ValueError("PLAY_ACCESS_TOKEN is required")
        self.token = token

    def call(self, method, path, body=None, upload=False):
        prefix = "/upload" if upload else ""
        url = f"{API}{prefix}/androidpublisher/v3/applications/{PACKAGE}/edits{path}"
        data = body if upload else (None if body is None else json.dumps(body).encode())
        request = Request(url, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/octet-stream" if upload else "application/json",
        })
        try:
            with urlopen(request, timeout=180 if upload else 30) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except HTTPError as error:
            # Never print arbitrary response bodies or authentication headers.
            detail = safe_play_error(error.read(65536))
            raise RuntimeError(f"Play API {method} {path}: HTTP {error.code} ({detail})") from None


def publish(play, bundle, digest, version, name, track, status, notes):
    if track != "internal" or status not in ("check", "draft", "completed"):
        raise ValueError("Unsupported track or release status")
    if not notes.strip() or len(notes) > 500:
        raise ValueError("Release notes must contain 1–500 characters")
    edit = play.call("POST", "", {})
    path = "/" + quote(edit["id"], safe="")
    commit_attempted = False
    try:
        tracks = play.call("GET", f"{path}/tracks").get("tracks", [])
        if status == "check":
            play.call("GET", f"{path}/bundles")
            return {"status": "access_verified", "track": track, "versionCode": version}
        current = next((entry for entry in tracks if entry["track"] == track), {})
        releases = current.get("releases", [])
        exact = next((r for r in releases if r.get("versionCodes") == [str(version)]
                      and r.get("status") == status), None)
        bundles = play.call("GET", f"{path}/bundles").get("bundles", [])
        uploaded = next((b for b in bundles if str(b["versionCode"]) == str(version)), None)
        if uploaded is None:
            uploaded = play.call("POST", f"{path}/bundles?uploadType=media", bundle, upload=True)
        if str(uploaded["versionCode"]) != str(version) or uploaded["sha256"] != digest:
            raise ValueError("Play bundle version/checksum differs from candidate")
        if exact:
            return {"status": "unchanged", "track": track, "versionCode": version}
        own_draft = [r for r in releases if r.get("status") == "draft"
                     and r.get("versionCodes") == [str(version)]]
        if any(r.get("status") in ("inProgress", "halted") or
               (r.get("status") == "draft" and r not in own_draft) for r in releases):
            raise ValueError("Resolve the existing rollout or draft in Play Console first")
        latest = max([0] + [int(code) for r in releases for code in r.get("versionCodes", [])])
        if version < latest or (version == latest and not own_draft):
            raise ValueError("Refusing to replace a newer or equal release")
        play.call("PUT", f"{path}/tracks/{track}", {"track": track, "releases": [{
            "name": name, "versionCodes": [str(version)], "status": status,
            "releaseNotes": [{"language": "en-US", "text": notes}],
        }]})
        play.call("POST", f"{path}:validate", {})
        # Commits are app-wide: requesting review can also send production
        # changes already staged in Console. This publisher owns only internal
        # delivery. Keep review separate and fail rather than cancel a review.
        # A timeout has an unknown outcome; reconcile before retrying.
        commit_attempted = True
        play.call("POST", f"{path}:commit?changesNotSentForReview=true"
                  "&changesInReviewBehavior=ERROR_IF_IN_REVIEW", {})
        return {"status": "draft_saved" if status == "draft" else "internal_committed",
                "track": track, "versionCode": version, "sha256": digest,
                "editId": edit["id"], "reviewRequested": False}
    finally:
        if not commit_attempted:
            try:
                play.call("DELETE", path)
            except Exception:
                print("Could not discard uncommitted edit; reconcile in Console", file=sys.stderr)


def request_accepted_code14_review(play, digest, source, run_id, listing):
    """One-time review of the physically accepted, Console-promoted artifact.

    No upload, track write, country change, or review cancellation is allowed.
    Remove this entry point after reconciling this particular release.
    """
    if (digest != "39f449794070cb336bbb31d2fa3d9941ae32f090582d7dfc3814882fb305d65f"
            or source != "b7473f0e946f6a9d858f6872d824c8f2fc495789"
            or str(run_id) != "41354475580"):
        raise ValueError("Review is restricted to the accepted code-14 candidate")
    edit = play.call("POST", "", {})
    path = "/" + quote(edit["id"], safe="")
    commit_attempted = False
    try:
        bundles = play.call("GET", path + "/bundles").get("bundles", [])
        candidate = [b for b in bundles if str(b.get("versionCode")) == "14"]
        if len(candidate) != 1 or candidate[0].get("sha256") != digest:
            raise ValueError("Staged bundle differs from the accepted code-14 bytes")
        tracks = play.call("GET", path + "/tracks").get("tracks", [])
        by_name = {t["track"]: t.get("releases", []) for t in tracks}
        if len(by_name) != len(tracks):
            raise ValueError("Duplicate tracks")
        for track in ("internal", "production"):
            releases = by_name.get(track, [])
            if (len(releases) != 1 or releases[0].get("versionCodes") != ["14"]
                    or releases[0].get("status") != "completed"
                    or releases[0].get("name") != "0.12.0"
                    or "countryTargeting" in releases[0]
                    or "userFraction" in releases[0]):
                raise ValueError("Review requires completed internal and production 14")
        if any(r for t, r in by_name.items() if t not in {"internal", "production"}):
            raise ValueError("Other track releases require separate reconciliation")
        countries = play.call("GET", path + "/countryAvailability/production")
        codes = [c.get("countryCode") for c in countries.get("countries", [])]
        # Console's 178 regions are 177 explicit countries plus Rest of world.
        if (len(codes) != 177 or len(set(codes)) != 177
                or countries.get("restOfWorld") is not True):
            raise ValueError(f"Production region count differs: {len(codes)} countries, "
                             f"restOfWorld={countries.get('restOfWorld') is True}")
        listings = play.call("GET", path + "/listings").get("listings", [])
        if (len(listings) != 1 or listings[0].get("language") != "en-US"
                or listings[0].get("title") != "YepControl – Remote Phone"
                or listings[0].get("fullDescription", "").strip() != listing.strip()):
            raise ValueError("Review listing differs from the saved release copy")
        play.call("POST", path + ":validate", {})
        if (play.call("GET", path + "/tracks").get("tracks", []) != tracks
                or play.call("GET", path + "/countryAvailability/production") != countries
                or play.call("GET", path + "/listings").get("listings", []) != listings):
            raise ValueError("Staged release changed during review reconciliation")
        commit_attempted = True
        play.call("POST", path + ":commit?changesNotSentForReview=false"
                  "&changesInReviewBehavior=ERROR_IF_IN_REVIEW")
        return {"status": "accepted_code14_review_requested", "track": "production",
                "versionCode": 14, "sha256": digest, "reviewRequested": True,
                "rollout": 100, "countries": 178}
    finally:
        if not commit_attempted:
            play.call("DELETE", path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("--source", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--version-code", required=True)
    parser.add_argument("--version-name", required=True)
    parser.add_argument("--track", choices=["internal"], required=True)
    parser.add_argument("--status", choices=["check", "draft", "completed"], default="check")
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument("--request-accepted-code14-review", action="store_true")
    args = parser.parse_args()
    bundle, digest, name = verify_candidate(args.directory, args.source, args.run_id,
                                          args.version_code, args.version_name)
    play = Play(os.environ.get("PLAY_ACCESS_TOKEN"))
    if args.request_accepted_code14_review:
        if args.status != "completed" or args.version_code != "14" or name != "0.12.0":
            raise ValueError("Invalid one-time code-14 review request")
        listing = Path("docs/distribution/listing.en-US.txt").read_text().split("Full description:\n\n", 1)[1]
        result = request_accepted_code14_review(play, digest, args.source, args.run_id, listing)
    else:
        result = publish(play, bundle, digest, int(args.version_code), name, args.track,
                         args.status, args.notes_file.read_text().strip())
    result.update(source=args.source, buildRunId=args.run_id, versionName=args.version_name)
    (args.directory / "publication.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    print("Verify delivery/review state in Console; API acceptance is not Google approval.")


if __name__ == "__main__":
    main()
