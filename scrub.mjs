// What leaves the customer: the error's signature, scrubbed here before anything is sent
// (docs/design/2026-10-25-error-tracker-integration-design.md). The rules are a port of placeholders() in
// api/src/error-signature.ts — the server applies them again — plus credential assignments, which the server's
// key rule (20+ characters with letters and digits) does not catch: password=hunter2, Authorization: Bearer x; and
// a private network's host names (db.internal, *.svc.cluster.local), which the server keeps.
// scripts/test-error-match.sh runs both over the same corpus, so the two cannot drift apart unseen.

export const MAX_SIGNATURE = 300;
export const MAX_INPUT = 4000;

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

// a credential written as an assignment or a header, whatever its length; the name is kept, the value goes
const CREDENTIAL_RES = [
  /\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic|token)?\s*[^\s,;'"]+/gi,
  /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b(password|passwd|pwd|secret|client_secret|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|token|auth|session[_-]?id|cookie|dsn)\s*([:=]\s*)(?:'[^']*'|"[^"]*"|[^\s,;&'"]+)/gi,
];
const JWT_RE = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const AWS_KEY_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
const USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"]+@/gi;   // scheme://user:pass@host
// a host name on a private network, with its port: the server keeps host names (registry.npmjs.org says what failed),
// a customer's own says where it runs. Replaced by the server's placeholder for an address, so it still matches; one in a URL goes with the URL.
const PRIVATE_HOST_RE = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:internal|local|localdomain|lan|home|corp|intranet|private|svc|cluster\.local)(?::\d{1,5})?(?![\w.-])/gi;

// The server's rules, in its order (api/src/error-signature.ts)
const URL_RE = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s'"`<>()]+/gi;
const EMAIL_RE = /[^\s@<>()[\]"'`,;:]+@[^\s@<>()[\]"'`,;:]+\.[A-Za-z]{2,}/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TIME_RE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b|\b\d{2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g;
const IPV6_RE = /\[[0-9a-f:]*:[0-9a-f:]*\](?::\d{1,5})?|(?<![\w:])(?:[0-9a-f]{1,4}:){2,7}[0-9a-f]{1,4}(?![\w:])|(?<![\w:])::1(?::\d{1,5})?(?![\w:])/gi;
const HOSTPORT_RE = /\blocalhost:\d{1,5}\b/gi;
const WIN_PATH_RE = /\b[A-Za-z]:\\[^\s'"`<>|:*?]+/g;
const ABS_PATH_RE = /(?<![\w@.>-])(?:~|\.{1,2})?\/[^\s'"`<>(),;:]+/g;
const REL_FILE_RE = /(?<![\w@/.-])[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z]{1,5}(?=:\d)/g;
const PATH_POS_RE = /<path>(?::\d+){1,2}/g;
const LINE_RE = /\b(line|ln|col|column|character|char|position|offset|pos)\s+\d+/gi;
const HEX_0X_RE = /\b0x[0-9a-f]+\b/gi;
const HEX_RE = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi;
const TOKEN_RE = /[A-Za-z0-9_\-+/=.]{20,}/g;
const looksLikeToken = (s) => /[A-Za-z]/.test(s) && /[0-9]/.test(s) && /[A-Za-z0-9]{16,}/.test(s);
const LONG_NUM_RE = /(?<![\w.-])\d{5,}(?=[a-z]{0,3}\b)(?!\.\d)/gi;

/** The credentials in a line replaced by <token>, a private network's host names by <addr>. */
export function scrubCredentials(line) {
  let s = line.replace(USERINFO_RE, "$1").replace(PRIVATE_HOST_RE, "<addr>");
  s = s.replace(JWT_RE, "<token>").replace(AWS_KEY_RE, "<token>");
  s = s.replace(CREDENTIAL_RES[0], "$1: <token>");
  s = s.replace(CREDENTIAL_RES[1], "$1 <token>");
  s = s.replace(CREDENTIAL_RES[2], "$1$2<token>");
  return s;
}

/** The server's placeholders, as api/src/error-signature.ts applies them. */
export function placeholders(line) {
  let s = line;
  s = s.replace(/^\[?\d{4}-\d{2}-\d{2}[T ][\d:.,]+(?:Z|[+-]\d{2}:?\d{2})?\]?\s*/, "");
  s = s.replace(URL_RE, "<url>");
  s = s.replace(EMAIL_RE, "<email>");
  s = s.replace(UUID_RE, "<uuid>");
  s = s.replace(TIME_RE, "<time>");
  s = s.replace(IPV4_RE, "<addr>").replace(IPV6_RE, "<addr>").replace(HOSTPORT_RE, "<addr>");
  s = s.replace(WIN_PATH_RE, "<path>").replace(ABS_PATH_RE, "<path>").replace(REL_FILE_RE, "<path>");
  s = s.replace(PATH_POS_RE, "<path>");
  s = s.replace(LINE_RE, "$1 <n>");
  s = s.replace(HEX_0X_RE, "<hex>").replace(HEX_RE, "<hex>");
  s = s.replace(TOKEN_RE, (m) => (looksLikeToken(m) ? "<token>" : m));
  s = s.replace(LONG_NUM_RE, "<n>");
  s = s.replace(/\s+/g, " ").trim();
  if (s.length > MAX_SIGNATURE) {
    const cut = s.slice(0, MAX_SIGNATURE);
    s = (cut.lastIndexOf(" ") > MAX_SIGNATURE * 0.6 ? cut.slice(0, cut.lastIndexOf(" ")) : cut).trim();
  }
  return s;
}

/** The signature of "type: message" as it may leave: its first line, credentials and what varies replaced; null
 *  when fewer than three letters are left outside placeholders (nothing worth sending). */
export function signatureOf(text) {
  const first = String(text ?? "").normalize("NFKC").slice(0, MAX_INPUT).replace(ANSI_RE, "").replace(/\r/g, "")
    .split("\n").map((l) => l.trim()).find(Boolean);
  if (!first) return null;
  const sig = placeholders(scrubCredentials(first));
  const letters = sig.replace(/<(?:url|email|uuid|time|addr|path|hex|token|n)>/g, "").match(/\p{L}/gu) ?? [];
  return letters.length >= 3 ? sig : null;
}

/** "type: message" from a Sentry webhook, from the fields that name the error and nothing else: an issue's
 *  metadata type and value (else its title), an error event's last exception. Never frames, request, user,
 *  tags, contexts, breadcrumbs, culprit, release, environment or host. */
export function errorTextFromSentry(resource, payload) {
  const data = payload?.data ?? {};
  if (resource === "issue") {
    const issue = data.issue ?? {};
    const meta = issue.metadata ?? {};
    if (typeof meta.type === "string" && meta.type) return typeof meta.value === "string" && meta.value ? `${meta.type}: ${meta.value}` : meta.type;
    // Sentry's own stand-in for an issue with no message names no error
    return typeof issue.title === "string" && !/^<(?:unknown|unlabeled|no title)[^>]*>$/i.test(issue.title.trim()) ? issue.title : null;
  }
  if (resource === "error") {
    const values = data.error?.exception?.values;
    const last = Array.isArray(values) && values.length ? values[values.length - 1] : null;
    if (last && typeof last.type === "string") return typeof last.value === "string" && last.value ? `${last.type}: ${last.value}` : last.type;
    return typeof data.error?.title === "string" ? data.error.title : null;
  }
  return null;
}
