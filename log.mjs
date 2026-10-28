// The errors a failed job printed: its failing step's output, as GitHub keeps a job's log, reduced to the lines that
// name an error. Each is then scrubbed to its signature (scrub.mjs) before anything leaves the runner.

import { signatureOf } from "./scrub.mjs";

export const TAIL_LINES = 400;     // how far back from the failure a step's output is read
export const MAX_SIGNATURES = 3;   // how many distinct errors one job is looked up by

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
// a job log's line: the time GitHub stamps it with, then what was printed
const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
// the runner's own words when a step fails: not the error
const RUNNER_NOISE = /^(?:Process completed with exit code \d+\.?|The process '.*' failed with exit code \d+|The operation was canceled\.?|Error: Process completed with exit code \d+\.?)$/;
// The head of an error, as api/src/error-signature.ts reads one in a text (HEAD_IN_TEXT), and a Python traceback's last
// line (its PY_LAST without warnings: a DeprecationWarning in a log is not why the job failed)
const HEAD_RE = /^(?:[A-Za-z_][\w.$]*(?:Error|Exception|Fault|Panic|Failure)(?: ?\[[\w-]+\])?:\s*\S|(?:error|ERROR|Error|fatal|FATAL|Fatal|panic|PANIC)(?: ?\[[\w-]+\])?:\s*\S|npm (?:ERR!|error)\s+\S|E[A-Z]{3,}(?::|\s)\s*\S|[\w.-]+(?::[^\s:]+)*:\s+(?:error|ERROR|Error|fatal|FATAL|Fatal):\s*\S|Uncaught\s+\w*(?:Error|Exception)\b)/;
const PY_LAST = /^[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Fault)\b(?::|$)/;

/** A job log's lines as printed: no time stamps, no colours. */
export function logLines(text) {
  return String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.replace(STAMP_RE, "").replace(ANSI_RE, "").trimEnd());
}

/** The failing step's output: from the start of the last step that reported an error up to that error, at most
 *  TAIL_LINES lines; the whole tail when the log marks no step. */
export function failingStep(lines) {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i].startsWith("##[error]")) { end = i; break; }
  if (end < 0) end = lines.length - 1;
  let start = Math.max(0, end - TAIL_LINES);
  for (let i = end; i >= start; i--) if (/^##\[group\]Run /.test(lines[i])) { start = i; break; }
  return lines.slice(start, end + 1);
}

/** The signatures of the errors in a job's log, at most MAX_SIGNATURES, each once: what the runner annotated as an
 *  error first (a tool's ::error::), then the lines that start the way an error does, in the order printed. */
export function signaturesInLog(text, max = MAX_SIGNATURES) {
  const step = failingStep(logLines(text));
  const annotated = [];
  const heads = [];
  for (const raw of step) {
    if (raw.startsWith("##[error]")) {
      const said = raw.slice("##[error]".length).trim();
      if (said && !RUNNER_NOISE.test(said)) annotated.push(said);
      continue;
    }
    if (raw.startsWith("##[")) continue;
    // a list mark or a prompt before it, as a test runner prints one
    const line = raw.trim().replace(/^(?:[●✕×✗✖>|]\s*|\[[\w -]+\]\s+)+/, "");
    if (HEAD_RE.test(line) || PY_LAST.test(line)) heads.push(line);
  }
  const out = [];
  for (const c of [...annotated, ...heads]) {
    const sig = signatureOf(c);
    if (sig && !out.includes(sig)) out.push(sig);
    if (out.length >= max) break;
  }
  return out;
}
