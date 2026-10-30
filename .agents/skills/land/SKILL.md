---
name: land
description: >-
  Land and release changes for zixiao-labs/Nasti through reviewed pull requests,
  verified CI, version tags, and GitHub Releases. Invoke only when the user
  explicitly requests landing, merging, or running this skill, never merely
  for review, preparation, passing checks, or skill installation.
disable-model-invocation: true
metadata:
  delta-action: land
---

# Land and release Nasti

## Scope and authorization

This workflow applies only to `zixiao-labs/Nasti`, whose root package is
`@nasti-toolchain/nasti`. An explicit invocation requests execution of this
workflow, including preparing commits, publishing the scoped branch, merging,
pushing the version tag, and creating the GitHub Release. Proceed without asking
for the same landing permission again. Do not treat review approval, successful
checks, or installation of this skill alone as a landing request.

The configured conflict preference is **automatic resolution when the intended
result is clear**. Preserve unrelated work. Stop on ambiguous intent, unsafe
changes, missing authorization for unrelated changes, or failed verification.
Never force-push, rewrite shared history, overwrite tags, bypass required reviews,
or approve the npm publication environment on the user's behalf.

Repository-relative source references below establish the current commands and
contracts. Re-read their current definitions and applicable contribution policies
when executing; do not assume hosting settings or commands remain unchanged.

## 1. Establish the exact change and destination

1. Read applicable `AGENT.md` / `AGENTS.md`, contribution policies, PR templates,
   and relevant instructions. Preserve conditional signing, authorship, agreement,
   review, documentation, and submission requirements if introduced. Act only on
   applicable unmet requirements; never invent an approval or human-authored text.
2. Inspect working-tree status, branch, recent history, remotes, current PR, and
   remote `main`. Use explicit repository arguments for GitHub operations.
   The publishing remote must resolve to `zixiao-labs/Nasti`; the `local` remote
   is a checkout backlink and must never be used for publication.
3. Identify the commits and uncommitted files belonging to the requested change.
   Include only those files. Do not discard, reset, or silently stash other work.
   If safe branch preparation is obstructed, report the blocker.
4. Check whether the requested implementation is already merged. If so, verify
   its destination commit and continue with release preparation instead of
   merging it again.
5. Inspect the repository's live settings, `main` protection, rulesets, required
   reviews/checks, and `npm-publish` environment using `gh api`. The researched
   baseline requires one PR approval and up-to-date `build`, `test (20)`,
   `test (22)`, and `test (24)` checks. Settings at execution time are authoritative;
   administrator bypass is not permission to skip them.

Use the installed `git` and `gh` directly, not an assumed wrapper. Authentication
must have the required repository/workflow access. Check authentication status
without printing tokens. If tool flags have changed, consult the installed
command's `--help`; do not install or upgrade global tools without permission.

## 2. Prepare a coherent release change

1. Read the root package version, remote version tags, GitHub Releases, and the
   changes since the previous release. Use a version explicitly requested by the
   user; otherwise choose a patch for compatible fixes or a minor for compatible
   features. Ask only if the version or release scope is genuinely ambiguous.
   Never reuse a published version.
2. Update the root `package.json` version and promote the relevant `Unreleased`
   notes in `CHANGELOG.md` to that version. Keep notes accurate about limitations
   and actual validation. Check the workspace lockfile for corresponding changes;
   do not manufacture a lockfile diff when the root version is not recorded.
   Do not change independently versioned workspace packages without a reason.
3. Prepare a scoped feature/release branch rather than committing on `main`.
   If a scoped branch already exists, reuse it without rewriting shared history.
   Resolve clear conflicts automatically, inspect the combined result, and rerun
   affected checks. Pause on ambiguous conflicts.
4. Review the diff, run `git diff --check`, and stage explicit paths. Use a
   descriptive commit subject consistent with recent history, such as
   `chore: prepare vX.Y.Z release`. Supply commit messages non-interactively:
   `GIT_EDITOR=true git commit -m "<subject>"`.
5. Push only the scoped branch to the verified publishing remote and create or
   update its PR against `main`, with a non-interactive title and body describing
   scope, tests, and release intent. Obey any current PR template.

Version and packaging sources: `package.json:1-5,25-34,54-65`;
changelog structure: `CHANGELOG.md`; workspace resolution:
`pnpm-workspace.yaml` and `pnpm-lock.yaml`.

## 3. Verify the final PR version

Use Node 24 at a version satisfying the actual build toolchain and the package's
declared pnpm version. The researched baseline is Node >=24.11.0 and
`pnpm@11.22.0`; do not raise the published package's runtime requirement just to
run the build. The application runtime still includes Node 20.
Sources: `package.json:25-34`; `.github/workflows/ci.yml:13-38,59-99`.

For implementation, dependency, packaging, or version changes, the normal local
verification is:

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm exec tsc --noEmit
```

Sources for these exact invocations: `package.json:59-65` defines `pnpm test`;
`.github/workflows/ci.yml:31-38` defines installation and the root typecheck.
`pnpm test` builds before running the offline test suite.

For dependency/compiler changes or release preparation that needs consumer
installation evidence, also run:

```sh
pnpm test:install
```

Source: `package.json:64` defines the build plus
`scripts/npm-install-smoke.mjs`. It installs the packed package outside the
workspace and checks ordinary React plus both supported compiler versions.
The CI matrix independently covers npm 10 and 11
(`.github/workflows/ci.yml:101-121`).

Keep local checks proportional. Documentation-only changes need not repeat all
runtime checks locally. A toolchain or platform unavailable locally may be
covered by successful CI on the exact final changes; state the omission.
Local checks never substitute for required remote checks. If an essential check
has neither local nor applicable remote evidence, stop rather than assume success.

Before merging:

1. Record the final PR head SHA. Confirm its base is current enough to satisfy
   strict branch protection. If updating the branch creates a new head, repeat
   affected validation and reevaluate checks and review requirements.
2. Inspect `gh pr checks <PR> --repo zixiao-labs/Nasti --required` and the full
   PR check/review state. Every required check must be present, completed, and
   successful for the final changes. Pending, missing, failing, cancelled, skipped,
   or unverifiable required checks are blockers, not successful completion.
3. Also require the applicable repository CI jobs to succeed: Node 20/22/24
   tests, build/typechecks/playgrounds, npm 10/11 installation checks, native
   TanStack Chromium checks, platform watcher jobs, and Electron packager jobs.
   Do not demand success from an advisory neutral check unless current policy
   makes it required.
   Source: `.github/workflows/ci.yml:17-211`.
4. Verify required approvals, unresolved review requests, and applicable policy
   obligations. Do not approve one's own PR to satisfy an independent review.
5. A bounded `gh pr checks --watch` may be used, but inspect the final state and
   head again. Never equate enabling auto-merge or queueing work with landing.

## 4. Merge and verify the destination

Default to a merge commit, matching repository practice while preserving the
reviewed commits. Recheck that the live repository permits it. If a merge queue
or different mandatory strategy is introduced, follow that mechanism without
bypassing its checks; ask only if a real unresolved strategy choice remains.

For the ordinary PR flow:

```sh
gh pr merge <PR> --repo zixiao-labs/Nasti --merge --match-head-commit <VERIFIED_HEAD_SHA>
```

Do not use `--admin`, do not directly push to `main`, and do not delete shared
branches as an incidental cleanup step. If the merge command is blocked, report
the actual blocker rather than weakening protection.

Confirm the PR is `MERGED`, record its merge SHA, and verify the requested
commits are present at the remote destination. Fetch without overwriting local
work if needed. Before making a tag, require the complete `CI` workflow on the
exact merged release commit to finish successfully. Locate runs with `gh run
list`, then inspect `gh run view <RUN_ID> --json headSha,status,conclusion,jobs,url`.
Require both `status=completed` and `conclusion=success`, plus the expected jobs;
do not rely on `--exit-status` alone for a run that may still be pending.

CI is triggered on PRs and pushes to `main`, not by a release tag:
`.github/workflows/ci.yml:6-10`. An earlier implementation or PR run is not
verification of a later version-preparation/merge commit.

## 5. Push the tag and publish the GitHub Release

1. Read the version and changelog from the verified release commit, not from
   unrelated local edits. Ensure `v<VERSION>` is unused remotely and the release
   commit contains the requested changes. If `main` advances, keep the tag pinned
   to the verified release commit rather than silently tagging the new tip.
2. Create an annotated tag with an explicit commit and message, then push only
   that tag to the verified publishing remote:

   ```sh
   GIT_EDITOR=true git tag -a "v<VERSION>" <VERIFIED_RELEASE_SHA> -m "v<VERSION>"
   git push <PUBLISH_REMOTE> "refs/tags/v<VERSION>"
   ```

   Honor any applicable signing policy and existing signing configuration.
   Never replace, delete, force-push, or move an existing release tag. If a tag
   already exists, verify its peeled commit before resuming an interrupted run;
   a conflicting tag is a blocker.
3. Extract the matching version's changelog notes into a temporary notes file.
   Add the included PR and exact successful main-CI link, and a comparison link
   from the previous version. Do not copy another release's validation claims.
4. Create the public GitHub Release without implicitly creating another tag:

   ```sh
   gh release create "v<VERSION>" --repo zixiao-labs/Nasti --verify-tag --title "v<VERSION>" --notes-file <NOTES_FILE>
   ```

   Use prerelease status for a prerelease version. Check for an existing release
   first; verify and resume matching completed work instead of duplicating it.
   Stop on conflicting release content rather than overwriting it silently.
5. Verify the remote tag's peeled SHA, version, published release URL, and release
   notes. GitHub Release creation is not evidence of npm publication.

The repository's established release notes use the versioned changelog, included
PR, exact merged-main CI evidence, and a full comparison link. Sources:
`CHANGELOG.md` and the published `v2.8.0` GitHub Release. The package version
contract comes from `package.json:1-5`.

## 6. Report and preserve the human publication gate

Pushing a `v*` tag triggers `Publish to npm`; the publish job uses the
`npm-publish` environment and OIDC provenance. Do not run `npm publish` locally,
add a token, disable the gate, dispatch a duplicate publication, or approve the
environment automatically. Source: `.github/workflows/publish.yml:3-17,24-36,51-70`.

Find the publication run for the exact tag and release SHA. Inspect its state
and pending deployment approval, and provide its actual URL. Remind the user to
open the run, choose **Review deployments**, select **npm-publish**, and approve.
If the run is absent or has failed, report that problem instead of presenting it
as waiting for approval. Do not wait indefinitely on a human approval.

Report the merge commit, version tag, GitHub Release link, verification evidence,
and publication-run link. Distinguish these outcomes:

- Changes landed and the GitHub Release is published, but npm is awaiting approval.
- Publication completed successfully and the expected version is available.
- Landing or release is incomplete because of a specific blocker.

After publication, a successful publish run and registry availability of the
expected package version are needed before claiming npm publication succeeded.
Never report queued checks, an unmerged PR, an approval request, or installation
of this skill as a successful landing.
