import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Advisories that the dependency gate tolerates for a limited time.
//
// Both entries are approved by the repository owner and are time-limited:
// - Both packages are development/build dependencies only (lint, test and
//   packaging tools). Neither is part of the distributed app, and
//   `npm audit --omit=dev` reports no vulnerabilities. That audit runs below
//   with no exceptions at all, so an entry here can never cover a shipped
//   dependency.
// - picomatch: every published release (up to 4.0.7, the latest) is in the
//   advisory range. There is no patched version to move to yet.
// - minimatch: fixed in 11.0.1, but every consumer here (eslint,
//   @eslint/config-array, @typescript-eslint/typescript-estree,
//   app-builder-lib, @electron/universal) declares minimatch ^10 or ^9, and
//   minimatch 11 changed matching semantics (empty path portions, patterns
//   with several `**`, Windows drive and UNC paths). app-builder-lib and
//   @electron/universal use it to decide which files go into the released
//   macOS and Windows apps, so forcing 11 through `overrides` could change the
//   shipped file set. That was not compared build against build on both
//   platforms, so minimatch stays on the versions its consumers declare.
//
// `expires` is the last day (UTC) on which an entry applies. From the next day
// on the entry is ignored and the gate fails again by itself; remove the entry
// or renew it deliberately. An entry matches one advisory id of one package and
// nothing else, so any other advisory is reported exactly as before.
export const AUDIT_EXCEPTIONS = Object.freeze([
  Object.freeze({
    id: "GHSA-fc5q-39xc-vjpf",
    package: "picomatch",
    reason: "Development/build dependency only; no patched release exists (latest 4.0.7 is affected).",
    expires: "2026-12-31",
  }),
  Object.freeze({
    id: "GHSA-g3hv-75wg-m249",
    package: "minimatch",
    reason: "Development/build dependency only; the fix needs minimatch 11, outside every consumer's declared range.",
    expires: "2026-12-31",
  }),
]);

const SEVERITIES = ["info", "low", "moderate", "high", "critical"];
const BLOCKING_SEVERITIES = new Set(["high", "critical"]);
const ADVISORY_URL = /^https:\/\/github\.com\/advisories\/(GHSA(?:-[0-9a-z]{4}){3})$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function isIsoDate(value) {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

// Returns the advisories of an `npm audit --json` report, or throws when the
// report is not the shape this gate understands. Callers treat a throw as a
// failure: an unreadable report must never pass.
export function collectAdvisories(report) {
  if (!isRecord(report)) throw new Error("The audit report is not an object");
  if ("error" in report) throw new Error("npm audit reported an error instead of a result");
  if (report.auditReportVersion !== 2) throw new Error("Unsupported audit report version");
  const { vulnerabilities, metadata } = report;
  if (!isRecord(vulnerabilities)) throw new Error("The audit report has no vulnerability map");
  const counts = metadata?.vulnerabilities;
  if (!isRecord(counts)) throw new Error("The audit report has no vulnerability counts");

  const advisories = new Map();
  const perSeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0]));
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (!isRecord(entry) || entry.name !== name) throw new Error(`Unexpected audit entry for ${name}`);
    if (!SEVERITIES.includes(entry.severity)) throw new Error(`Unknown severity for ${name}`);
    if (!Array.isArray(entry.via) || entry.via.length === 0) throw new Error(`No cause listed for ${name}`);
    perSeverity[entry.severity]++;
    for (const cause of entry.via) {
      if (typeof cause === "string") {
        if (!Object.hasOwn(vulnerabilities, cause)) throw new Error(`${name} is affected through unlisted ${cause}`);
        continue;
      }
      if (!isRecord(cause)) throw new Error(`Unexpected cause for ${name}`);
      const id = typeof cause.url === "string" ? ADVISORY_URL.exec(cause.url)?.[1] : undefined;
      if (!id) throw new Error(`Advisory without a recognised id for ${name}`);
      if (cause.name !== name) throw new Error(`Advisory ${id} names another package than ${name}`);
      if (!SEVERITIES.includes(cause.severity)) throw new Error(`Unknown severity for ${id}`);
      const key = `${id} ${name}`;
      const known = advisories.get(key);
      if (!known || SEVERITIES.indexOf(cause.severity) > SEVERITIES.indexOf(known.severity)) {
        advisories.set(key, {
          id, package: name, severity: cause.severity, url: cause.url,
          title: typeof cause.title === "string" ? cause.title : "",
          range: typeof cause.range === "string" ? cause.range : "",
        });
      }
    }
  }
  for (const severity of SEVERITIES) {
    if (counts[severity] !== perSeverity[severity]) throw new Error(`The ${severity} count differs from the listed packages`);
  }
  if (counts.total !== Object.keys(vulnerabilities).length) throw new Error("The total count differs from the listed packages");

  // Every package npm rates high or critical must lead, through its causes, to
  // an advisory of that level. Otherwise something blocking is not represented
  // by an advisory this gate can judge.
  const reaches = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return vulnerabilities[name].via.some((cause) => typeof cause === "string"
      ? reaches(cause, seen)
      : BLOCKING_SEVERITIES.has(cause.severity));
  };
  for (const [name, entry] of Object.entries(vulnerabilities)) {
    if (BLOCKING_SEVERITIES.has(entry.severity) && !reaches(name)) {
      throw new Error(`${name} is rated ${entry.severity} without a matching advisory`);
    }
  }
  return [...advisories.values()];
}

function affectedPackages(report, advisory) {
  const { vulnerabilities } = report;
  const affected = new Set([advisory.package]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, entry] of Object.entries(vulnerabilities)) {
      if (!affected.has(name) && entry.via.some((cause) => typeof cause === "string" && affected.has(cause))) {
        affected.add(name);
        grew = true;
      }
    }
  }
  affected.delete(advisory.package);
  return [...affected].sort();
}

// The whole decision, without I/O:
// - `fullReport` is `npm audit --json` for every dependency. High and critical
//   advisories fail unless an exception that is still valid on `today` covers
//   them. Lower severities are reported by npm but do not fail, as before.
// - `shippedReport` is `npm audit --omit=dev --json`. Anything in it fails; the
//   exceptions are not consulted.
// `today` is a UTC date as YYYY-MM-DD.
export function evaluateAudit({ fullReport, shippedReport, exceptions, today }) {
  const failures = [];
  const warnings = [];
  const accepted = [];
  const fail = (message) => { failures.push(message); };

  if (!isIsoDate(today)) fail("The current date is not a valid YYYY-MM-DD date");
  const usable = [];
  if (!Array.isArray(exceptions)) {
    fail("The exception list is not an array");
  } else {
    for (const exception of exceptions) {
      const valid = isRecord(exception)
        && typeof exception.id === "string" && /^GHSA(?:-[0-9a-z]{4}){3}$/.test(exception.id)
        && typeof exception.package === "string" && exception.package.length > 0
        && typeof exception.reason === "string" && exception.reason.trim().length > 0
        && isIsoDate(exception.expires);
      if (valid) usable.push(exception);
      else fail(`Malformed audit exception: ${JSON.stringify(exception)}`);
    }
  }

  let advisories = [];
  try {
    advisories = collectAdvisories(fullReport);
  } catch (error) {
    fail(`Cannot read the audit of all dependencies: ${error.message}`);
  }
  try {
    const shipped = collectAdvisories(shippedReport);
    for (const advisory of shipped) {
      fail(`Shipped dependency ${advisory.package} has ${advisory.severity} advisory ${advisory.id} (${advisory.url}); exceptions never apply to shipped dependencies`);
    }
    const names = Object.keys(shippedReport.vulnerabilities);
    if (shipped.length === 0 && names.length > 0) fail(`Shipped dependencies are reported vulnerable: ${names.join(", ")}`);
  } catch (error) {
    fail(`Cannot read the audit of shipped dependencies: ${error.message}`);
  }

  const dateKnown = isIsoDate(today);
  const reported = new Set();
  for (const advisory of advisories) {
    const exception = usable.find((entry) => entry.id === advisory.id && entry.package === advisory.package);
    if (exception) reported.add(exception);
    if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
    const through = affectedPackages(fullReport, advisory);
    const label = `${advisory.severity} advisory ${advisory.id} in ${advisory.package} ${advisory.range}`.trimEnd()
      + ` (${advisory.url})${through.length > 0 ? `; reaches ${through.join(", ")}` : ""}`;
    if (!exception) {
      fail(`Unaccepted ${label}`);
    } else if (!dateKnown || today > exception.expires) {
      fail(`The exception for ${advisory.id} expired on ${exception.expires}: ${label}`);
    } else {
      accepted.push(`Accepted until ${exception.expires}: ${label}. ${exception.reason}`);
    }
  }
  for (const exception of usable) {
    if (reported.has(exception)) continue;
    warnings.push(`The exception for ${exception.id} (${exception.package}) no longer matches a reported advisory; remove it from AUDIT_EXCEPTIONS.`);
  }
  return { ok: failures.length === 0, failures, warnings, accepted };
}

function runAudit(extraArguments) {
  const result = spawnSync("npm", ["audit", "--json", ...extraArguments], {
    encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "inherit"],
  });
  // npm exits 1 when it found something; the report decides. Anything else
  // (a spawn failure, a signal, a registry error) is not a result.
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) return undefined;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
}

function main() {
  const { ok, failures, warnings, accepted } = evaluateAudit({
    fullReport: runAudit([]),
    shippedReport: runAudit(["--omit=dev"]),
    exceptions: AUDIT_EXCEPTIONS,
    today: new Date().toISOString().slice(0, 10),
  });
  for (const line of accepted) console.log(line);
  for (const line of warnings) console.warn(`Warning: ${line}`);
  for (const line of failures) console.error(`Error: ${line}`);
  if (!ok) {
    console.error("Dependency audit failed. Run `npm audit` for details.");
    process.exit(1);
  }
  console.log("Dependency audit passed: no unaccepted high or critical advisory, and shipped dependencies are clean.");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
