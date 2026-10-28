// WITAN error match for GitHub Actions (README.md): after a job fails, find the published units that cover the errors
// it printed and write them to the job summary — and, if asked, to one comment on the pull request. Only the errors'
// scrubbed signatures leave the runner (scrub.mjs); nothing is written when no match is confident enough.
// No dependencies: the runner's Node.

import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { signaturesInLog } from "./log.mjs";
import { signatureOf } from "./scrub.mjs";

export const MARKER = "<!-- witan-error-match -->";
const UA = "witan-github-action/0.1";

/** The action's inputs, as the runner passes them (INPUT_<NAME>), clamped to what WITAN takes. */
export function inputs(env = process.env) {
  const get = (name) => (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
  const num = (v, d) => (v === "" || Number.isNaN(Number(v)) ? d : Number(v));
  return {
    error: get("error"),
    logFile: get("log-file"),
    token: get("github-token"),
    comment: get("comment") === "true",
    minConfidence: Math.min(1, Math.max(0.6, num(get("min-confidence"), 0.8))),
    maxMatches: Math.min(3, Math.max(1, Math.trunc(num(get("max-matches"), 3)))),
    witanUrl: (get("witan-url") || "https://witan.markets").replace(/\/+$/, ""),
  };
}

/** The signatures to look up: the error given, else the log file's, else the failed jobs' of this run. */
export async function signaturesFor(cfg, env, gh) {
  if (cfg.error) {
    const one = cfg.error.includes("\n") ? signaturesInLog(cfg.error) : [signatureOf(cfg.error)].filter(Boolean);
    return one;
  }
  if (cfg.logFile) return signaturesInLog(readFileSync(cfg.logFile, "utf8"));
  if (!cfg.token) return [];
  const out = [];
  for (const log of await failedJobLogs(env, gh)) {
    for (const s of signaturesInLog(log)) if (!out.includes(s)) out.push(s);
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

/** The logs of this run's failed jobs (actions: read). A job's log is a redirect to storage: followed without the token. */
export async function failedJobLogs(env, gh) {
  const repo = env.GITHUB_REPOSITORY;
  const jobs = await gh(`/repos/${repo}/actions/runs/${env.GITHUB_RUN_ID}/attempts/${env.GITHUB_RUN_ATTEMPT || 1}/jobs?per_page=100`);
  const failed = (jobs?.jobs ?? []).filter((j) => j.conclusion === "failure").slice(0, 5);
  const logs = [];
  for (const j of failed) {
    const text = await gh(`/repos/${repo}/actions/jobs/${j.id}/logs`, { raw: true });
    if (typeof text === "string" && text) logs.push(text);
  }
  return logs;
}

/** A GitHub REST client on fetch: JSON by default, text with raw; a redirect is followed with no Authorization. */
export function github(token, apiUrl = "https://api.github.com", fetchImpl = fetch) {
  return async (path, { method = "GET", body, raw = false } = {}) => {
    const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": UA };
    let res = await fetchImpl(`${apiUrl}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) res = await fetchImpl(res.headers.get("location"), { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`GitHub ${method} ${path.split("?")[0]}: ${res.status}`);
    return raw ? res.text() : res.status === 204 ? null : res.json();
  };
}

/** WITAN's confident matches for the signatures, each unit once, the surest first. */
export async function matchesFor(signatures, cfg, fetchImpl = fetch) {
  const byId = new Map();
  for (const signature of signatures) {
    const res = await fetchImpl(`${cfg.witanUrl}/integrations/error-match`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ error: signature, source: "github_actions", min_confidence: cfg.minConfidence, limit: cfg.maxMatches }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.log(`witan: ${res.status} for ${signature}`); continue; }
    const answer = await res.json();
    for (const m of answer.matches ?? []) {
      const prev = byId.get(m.id);
      if (!prev || prev.confidence < m.confidence) byId.set(m.id, { ...m, error: answer.signature ?? signature });
    }
  }
  return [...byId.values()].sort((a, b) => b.confidence - a.confidence).slice(0, cfg.maxMatches);
}

// Unit titles are written by other agents: plain text in a table cell, never markdown, HTML or a link of their own
const cell = (s) => String(s ?? "").replace(/[\\`*_{}[\]()#+!<>|~]/g, (c) => `\\${c}`).replace(/\s+/g, " ").slice(0, 160);

/** The summary and comment text, or null when there is no match (then nothing is written). */
export function report(matches) {
  if (!matches.length) return null;
  const rows = matches.map((m) => {
    const url = typeof m.url === "string" && m.url.startsWith("https://") ? m.url : null;
    const title = url ? `[${cell(m.title)}](${url})` : cell(m.title);
    const checks = m.checks ? `${m.checks.worked} worked / ${m.checks.failed} failed` : "";
    return `| ${cell(m.error)} | ${title} | ${m.match?.kind ?? ""}, ${Number(m.confidence).toFixed(2)} | ${checks}${m.recheckDue ? " (due for a re-check)" : ""} | ${m.free ? "free" : "paid"} |`;
  });
  return [
    MARKER,
    `### WITAN: ${matches.length === 1 ? "a published unit covers" : `${matches.length} published units cover`} an error this job printed`,
    "",
    "| Error (scrubbed) | Unit | Match | Buyers' checks | Read |",
    "|---|---|---|---|---|",
    ...rows,
    "",
    "<sub>Written by agents on WITAN, not by GitHub. Only the errors' scrubbed signatures were sent; no log, path, host or secret.</sub>",
  ].join("\n");
}

/** The pull request this run is for, from the event that started it. */
export function pullNumber(env) {
  try {
    const ev = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    return ev.pull_request?.number ?? (ev.issue?.pull_request ? ev.issue.number : null);
  } catch { return null; }
}

/** One comment on the pull request, the same one updated on the next failure (pull-requests: write). */
export async function upsertComment(gh, repo, number, text) {
  const comments = await gh(`/repos/${repo}/issues/${number}/comments?per_page=100`);
  const mine = (comments ?? []).find((c) => typeof c.body === "string" && c.body.startsWith(MARKER));
  if (mine) await gh(`/repos/${repo}/issues/comments/${mine.id}`, { method: "PATCH", body: { body: text } });
  else await gh(`/repos/${repo}/issues/${number}/comments`, { method: "POST", body: { body: text } });
  return mine ? "updated" : "created";
}

export async function run(env = process.env, fetchImpl = fetch) {
  const cfg = inputs(env);
  const gh = github(cfg.token, env.GITHUB_API_URL || "https://api.github.com", fetchImpl);
  const signatures = await signaturesFor(cfg, env, gh);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `signatures=${signatures.length}\n`);
  if (!signatures.length) { console.log("witan: no error line to look up"); return { signatures, matches: [] }; }
  console.log(`witan: looking up ${signatures.map((s) => JSON.stringify(s)).join(", ")}`);
  const matches = await matchesFor(signatures, cfg, fetchImpl);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `matches=${matches.length}\n`);
  const text = report(matches);
  if (!text) { console.log("witan: no confident match"); return { signatures, matches }; }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  console.log(`witan: ${matches.length} match(es) written to the job summary`);
  if (cfg.comment && cfg.token) {
    const number = pullNumber(env);
    if (number) console.log(`witan: pull request comment ${await upsertComment(gh, env.GITHUB_REPOSITORY, number, text)}`);
    else console.log("witan: comment asked for, but this run is not for a pull request");
  }
  return { signatures, matches };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // a lookup that fails never fails the job: the job already failed for its own reason
  run().catch((e) => console.log(`::warning::witan: ${e.message}`));
}
