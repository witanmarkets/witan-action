// node --test integrations/github-action/test.mjs  (no dependencies, no network: GitHub and WITAN are stubbed)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MARKER, github, inputs, matchesFor, pullNumber, report, run, upsertComment } from "./index.mjs";
import { failingStep, logLines, signaturesInLog } from "./log.mjs";

const here = new URL(".", import.meta.url).pathname;

// a failed job's log as GitHub keeps it: time stamps, groups per step, the runner's annotation at the end
const JOB_LOG = [
  "2026-10-25T08:00:00.0000000Z ##[group]Run actions/checkout@v5",
  "2026-10-25T08:00:01.0000000Z Syncing repository: acme/billing",
  "2026-10-25T08:00:01.1000000Z Error: this line is in another step and must not be read",
  "2026-10-25T08:00:02.0000000Z ##[endgroup]",
  "2026-10-25T08:00:03.0000000Z ##[group]Run npm test",
  "2026-10-25T08:00:03.1000000Z npm test",
  "2026-10-25T08:00:03.2000000Z shell: /usr/bin/bash -e {0}",
  "2026-10-25T08:00:03.3000000Z env:",
  "2026-10-25T08:00:03.4000000Z   DATABASE_URL: ***",
  "2026-10-25T08:00:03.5000000Z ##[endgroup]",
  "2026-10-25T08:00:04.0000000Z (node:2190) DeprecationWarning: Buffer() is deprecated",
  "2026-10-25T08:00:05.0000000Z \u001b[31m●\u001b[39m pool › connects",
  "2026-10-25T08:00:05.1000000Z     Error: connect ECONNREFUSED 10.1.0.12:5432",
  "2026-10-25T08:00:05.2000000Z         at TCPConnectWrap.afterConnect [as oncomplete] (node:net:1555:16)",
  "2026-10-25T08:00:05.3000000Z         at /home/runner/work/billing/billing/src/db.js:12:9",
  "2026-10-25T08:00:06.0000000Z Tests: 1 failed, 41 passed, 42 total",
  "2026-10-25T08:00:06.1000000Z npm error code ELIFECYCLE",
  "2026-10-25T08:00:06.2000000Z Error: connect ECONNREFUSED 10.1.0.13:5432",
  "2026-10-25T08:00:07.0000000Z ##[error]Process completed with exit code 1.",
  "2026-10-25T08:00:08.0000000Z Post job cleanup.",
].join("\n");

test("the failing step only, without stamps, colours or the runner's own words", () => {
  const step = failingStep(logLines(JOB_LOG));
  assert.equal(step[0], "##[group]Run npm test");
  assert.equal(step.at(-1), "##[error]Process completed with exit code 1.");
  assert.deepEqual(signaturesInLog(JOB_LOG), ["Error: connect ECONNREFUSED <addr>", "npm error code ELIFECYCLE"]);
});

test("an error a tool annotated comes first; secrets and paths never survive", () => {
  const log = [
    "##[group]Run ./deploy.sh",
    "Uploading with token=ghp_abcdefABCDEF1234567890abcdefABCDEF12",
    "Error: unauthorized: authentication required for https://ghcr.io/v2/acme/app/blobs/sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    "##[error]Error: EACCES: permission denied, open '/home/runner/work/app/.env.production'",
    "##[error]Process completed with exit code 1.",
  ].join("\n");
  const sigs = signaturesInLog(log);
  assert.deepEqual(sigs, ["Error: EACCES: permission denied, open '<path>'", "Error: unauthorized: authentication required for <url>"]);
  assert.ok(!JSON.stringify(sigs).match(/ghp_|acme|runner|sha256|production/));
});

test("a Python traceback's last line; no error line, nothing", () => {
  const log = "##[group]Run pytest\nTraceback (most recent call last):\n  File \"/srv/x.py\", line 3, in <module>\nModuleNotFoundError: No module named 'anthropic'\n##[error]Process completed with exit code 1.";
  assert.deepEqual(signaturesInLog(log), ["ModuleNotFoundError: No module named 'anthropic'"]);
  assert.deepEqual(signaturesInLog("##[group]Run make\nall good\n##[error]Process completed with exit code 2."), []);
});

test("inputs: the floor never under 0.6, at most 3, comment only when true", () => {
  const c = inputs({ "INPUT_MIN-CONFIDENCE": "0.1", "INPUT_MAX-MATCHES": "7", INPUT_COMMENT: "yes" });
  assert.equal(c.minConfidence, 0.6);
  assert.equal(c.maxMatches, 3);
  assert.equal(c.comment, false);
  assert.equal(inputs({ INPUT_COMMENT: "true" }).comment, true);
  assert.equal(inputs({}).witanUrl, "https://witan.markets");
});

const answer = (sig, matches) => ({ ok: true, status: 200, json: async () => ({ signature: sig, threshold: 0.8, matches }) });
const unit = (id, confidence, title = `Unit ${id}`) => ({ id, title, url: `https://witan.markets/market/knowledge/${id}?utm_source=github_actions`, confidence, match: { kind: confidence === 1 ? "exact" : "similar" }, checks: { worked: 2, failed: 0 }, free: true });

test("matches: only the signature and the source are sent; each unit once, the surest first", async () => {
  const sent = [];
  const fake = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return sent.length === 1 ? answer("A", [unit("u1", 0.85), unit("u2", 1)]) : answer("B", [unit("u1", 1)]);
  };
  const m = await matchesFor(["A", "B"], inputs({ "INPUT_WITAN-URL": "https://w.example/" }), fake);
  assert.deepEqual(sent.map((s) => s.url), ["https://w.example/integrations/error-match", "https://w.example/integrations/error-match"]);
  assert.deepEqual(sent[0].body, { error: "A", source: "github_actions", min_confidence: 0.8, limit: 3 });
  assert.deepEqual(m.map((x) => [x.id, x.confidence, x.error]), [["u1", 1, "B"], ["u2", 1, "A"]]);
});

test("the report: nothing without a match; titles as plain text, https links only", () => {
  assert.equal(report([]), null);
  const r = report([{ ...unit("u1", 1, "<img src=x onerror=alert(1)> | [x](https://evil.example)"), error: "Error: connect ECONNREFUSED <addr>" },
    { ...unit("u2", 0.9), url: "javascript:alert(1)", error: "E" }]);
  assert.ok(r.startsWith(MARKER));
  assert.ok(!/(?<!\\)<img/.test(r) && !r.includes("javascript:") && !r.includes("](https://evil"));
  assert.ok(r.includes("| Error: connect ECONNREFUSED \\<addr\\> | [\\<img src=x onerror=alert\\(1\\)\\> \\| \\[x\\]\\(https://evil.example\\)](https://witan.markets/market/knowledge/u1?utm_source=github_actions) | exact, 1.00 | 2 worked / 0 failed | free |"));
});

test("GitHub: a log's redirect is followed without the token", async () => {
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, auth: init?.headers?.authorization });
    if (url.endsWith("/logs")) return { ok: false, status: 302, headers: new Map([["location", "https://blob.example/log?sig=1"]]) };
    return { ok: true, status: 200, text: async () => JOB_LOG, headers: new Map() };
  };
  const text = await github("tok", "https://api.example", fake)("/repos/o/r/actions/jobs/1/logs", { raw: true });
  assert.equal(text, JOB_LOG);
  assert.deepEqual(calls, [{ url: "https://api.example/repos/o/r/actions/jobs/1/logs", auth: "Bearer tok" }, { url: "https://blob.example/log?sig=1", auth: undefined }]);
});

test("one comment, updated the next time", async () => {
  const done = [];
  const gh = async (path, opts = {}) => {
    done.push(`${opts.method ?? "GET"} ${path}`);
    if (path.includes("?per_page")) return done.length > 2 ? [{ id: 9, body: `${MARKER}\nold` }] : [{ id: 1, body: "unrelated" }];
    return {};
  };
  assert.equal(await upsertComment(gh, "o/r", 5, "x"), "created");
  assert.equal(await upsertComment(gh, "o/r", 5, "y"), "updated");
  assert.deepEqual(done, ["GET /repos/o/r/issues/5/comments?per_page=100", "POST /repos/o/r/issues/5/comments", "GET /repos/o/r/issues/5/comments?per_page=100", "PATCH /repos/o/r/issues/comments/9"]);
});

test("run: reads this run's failed jobs, writes the summary and the comment, never the token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "witan-action-"));
  const ev = join(dir, "event.json");
  writeFileSync(ev, JSON.stringify({ pull_request: { number: 12 } }));
  const env = {
    INPUT_COMMENT: "true", "INPUT_GITHUB-TOKEN": "ghs_secret_token_value", "INPUT_WITAN-URL": "https://w.example",
    GITHUB_REPOSITORY: "acme/billing", GITHUB_RUN_ID: "77", GITHUB_RUN_ATTEMPT: "1", GITHUB_EVENT_PATH: ev,
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"), GITHUB_OUTPUT: join(dir, "out.txt"), GITHUB_API_URL: "https://api.example",
  };
  const seen = [];
  const fake = async (url, init = {}) => {
    seen.push({ url, method: init.method ?? "GET", body: init.body });
    if (url.includes("/attempts/1/jobs")) return { ok: true, status: 200, json: async () => ({ jobs: [{ id: 1, conclusion: "success" }, { id: 2, conclusion: "failure" }] }) };
    if (url.endsWith("/jobs/2/logs")) return { ok: true, status: 200, text: async () => JOB_LOG, headers: new Map() };
    if (url.includes("/integrations/error-match")) return answer(JSON.parse(init.body).error, JSON.parse(init.body).error.includes("ECONNREFUSED") ? [unit("u1", 1)] : []);
    if (url.includes("comments?per_page")) return { ok: true, status: 200, json: async () => [] };
    return { ok: true, status: 201, json: async () => ({}) };
  };
  const logs = [];
  const orig = console.log;
  console.log = (l) => logs.push(String(l));
  try { await run(env, fake); } finally { console.log = orig; }
  const summary = readFileSync(env.GITHUB_STEP_SUMMARY, "utf8");
  assert.ok(summary.includes("[Unit u1](https://witan.markets/market/knowledge/u1?utm_source=github_actions)"));
  assert.equal(readFileSync(env.GITHUB_OUTPUT, "utf8"), "signatures=2\nmatches=1\n");
  const posted = seen.find((s) => s.method === "POST" && s.url.endsWith("/issues/12/comments"));
  assert.ok(posted && JSON.parse(posted.body).body.startsWith(MARKER));
  const toWitan = seen.filter((s) => s.url.includes("w.example")).map((s) => s.body).join("\n");
  assert.ok(!toWitan.includes("10.1.0") && !toWitan.includes("acme") && !toWitan.includes("runner"));
  assert.ok(!logs.join("\n").includes("ghs_secret") && !summary.includes("ghs_secret"));
});

test("run: no confident match writes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "witan-action-"));
  const env = { INPUT_ERROR: "Error: connect ECONNREFUSED 10.0.0.1:5432", GITHUB_STEP_SUMMARY: join(dir, "summary.md") };
  const orig = console.log;
  console.log = () => {};
  try { await run(env, async () => answer("x", [])); } finally { console.log = orig; }
  assert.equal(existsSync(env.GITHUB_STEP_SUMMARY), false);
  assert.equal(pullNumber({ GITHUB_EVENT_PATH: join(dir, "none.json") }), null);
});

// in this repository; a published copy of the action stands alone
test("the scrub is the Sentry receiver's, byte for byte", { skip: !existsSync(join(here, "../sentry/scrub.mjs")) }, () => {
  assert.equal(readFileSync(join(here, "scrub.mjs"), "utf8"), readFileSync(join(here, "../sentry/scrub.mjs"), "utf8"));
});
