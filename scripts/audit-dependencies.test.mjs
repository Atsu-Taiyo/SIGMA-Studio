import assert from "node:assert/strict";
import test from "node:test";
import { AUDIT_EXCEPTIONS, collectAdvisories, evaluateAudit } from "./audit-dependencies.mjs";

const advisory = (name, id, severity, range = "<=1.0.0") => ({
  source: 1, name, dependency: name, title: `${name} fixture advisory`,
  url: `https://github.com/advisories/${id}`, severity, cwe: [], cvss: { score: 0, vectorString: null }, range,
});

// Builds a report in the shape of `npm audit --json` (auditReportVersion 2).
function report(packages) {
  const vulnerabilities = {};
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, { severity, via }] of Object.entries(packages)) {
    vulnerabilities[name] = {
      name, severity, isDirect: false, via, effects: [], range: "*", nodes: [`node_modules/${name}`], fixAvailable: false,
    };
    counts[severity]++;
    counts.total++;
  }
  return {
    auditReportVersion: 2, vulnerabilities,
    metadata: { vulnerabilities: counts, dependencies: { prod: 1, dev: 1, optional: 0, peer: 0, peerOptional: 0, total: 2 } },
  };
}

const PICOMATCH = "GHSA-fc5q-39xc-vjpf";
const MINIMATCH = "GHSA-g3hv-75wg-m249";
const OTHER = "GHSA-aaaa-bbbb-cccc";
const clean = report({});
// The situation this gate was introduced for, reduced to its shape.
const current = report({
  picomatch: { severity: "high", via: [advisory("picomatch", PICOMATCH, "high", "<=4.0.7")] },
  fdir: { severity: "high", via: ["picomatch"] },
  tinyglobby: { severity: "high", via: ["fdir", "picomatch"] },
  vite: { severity: "high", via: ["picomatch", "tinyglobby"] },
  minimatch: { severity: "moderate", via: [advisory("minimatch", MINIMATCH, "moderate", ">=7.0.0 <11.0.1")] },
  eslint: { severity: "moderate", via: ["minimatch"] },
});
const evaluate = (overrides = {}) => evaluateAudit({
  fullReport: current, shippedReport: clean, exceptions: AUDIT_EXCEPTIONS, today: "2026-11-18", ...overrides,
});

test("the exception list is exactly the two approved advisories and both end in 2026", () => {
  assert.deepEqual(AUDIT_EXCEPTIONS.map(({ id, package: name, expires }) => ({ id, name, expires })), [
    { id: PICOMATCH, name: "picomatch", expires: "2026-12-31" },
    { id: MINIMATCH, name: "minimatch", expires: "2026-12-31" },
  ]);
  for (const exception of AUDIT_EXCEPTIONS) {
    assert.deepEqual(Object.keys(exception).sort(), ["expires", "id", "package", "reason"]);
    assert.ok(exception.reason.trim().length > 20);
  }
});

test("an excepted advisory passes until its last day", () => {
  for (const today of ["2026-11-18", "2026-12-30", "2026-12-31"]) {
    const result = evaluate({ today });
    assert.deepEqual(result.failures, [], today);
    assert.equal(result.ok, true, today);
    assert.equal(result.accepted.length, 1, "Only the high advisory needs acceptance");
    assert.match(result.accepted[0], /GHSA-fc5q-39xc-vjpf.*reaches fdir, tinyglobby, vite/);
    assert.deepEqual(result.warnings, []);
  }
});

test("an excepted advisory fails again after its last day", () => {
  for (const today of ["2027-01-01", "2027-06-15", "2030-01-01"]) {
    const result = evaluate({ today });
    assert.equal(result.ok, false, today);
    assert.equal(result.failures.length, 1, today);
    assert.match(result.failures[0], /GHSA-fc5q-39xc-vjpf expired on 2026-12-31/);
  }
});

test("an exception applies through the day it names and not the day after", () => {
  const exceptions = [{ id: PICOMATCH, package: "picomatch", reason: "Fixture reason", expires: "2026-11-17" }];
  assert.equal(evaluate({ exceptions }).ok, false);
  assert.equal(evaluate({ exceptions, today: "2026-11-17" }).ok, true);
});

test("a different high or critical advisory still fails", () => {
  for (const severity of ["high", "critical"]) {
    const result = evaluate({
      fullReport: report({
        picomatch: { severity: "high", via: [advisory("picomatch", PICOMATCH, "high")] },
        leftpad: { severity, via: [advisory("leftpad", OTHER, severity)] },
      }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0], new RegExp(`Unaccepted ${severity} advisory ${OTHER} in leftpad`));
  }
});

test("a second advisory in an excepted package is not covered", () => {
  const result = evaluate({
    fullReport: report({
      picomatch: { severity: "high", via: [advisory("picomatch", PICOMATCH, "high"), advisory("picomatch", OTHER, "high")] },
    }),
  });
  assert.equal(result.ok, false);
  assert.match(result.failures.join("\n"), new RegExp(`Unaccepted high advisory ${OTHER} in picomatch`));
});

test("an excepted id reported for another package is not covered", () => {
  const result = evaluate({
    fullReport: report({ leftpad: { severity: "high", via: [advisory("leftpad", PICOMATCH, "high")] } }),
  });
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /Unaccepted high advisory GHSA-fc5q-39xc-vjpf in leftpad/);
});

test("an advisory that reaches a package only through other packages is judged by its source", () => {
  const through = (id) => report({
    leftpad: { severity: "high", via: [advisory("leftpad", id, "high")] },
    middle: { severity: "high", via: ["leftpad"] },
    top: { severity: "high", via: ["middle"] },
  });
  const failing = evaluate({ fullReport: through(OTHER) });
  assert.equal(failing.ok, false);
  assert.match(failing.failures[0], /in leftpad .*reaches middle, top/);
  const exceptions = [{ id: OTHER, package: "leftpad", reason: "Fixture reason", expires: "2026-12-31" }];
  assert.equal(evaluate({ fullReport: through(OTHER), exceptions }).ok, true);
  assert.equal(evaluate({ fullReport: through(OTHER), exceptions, today: "2027-01-01" }).ok, false);
});

test("moderate and low advisories do not fail, with or without an exception", () => {
  const fullReport = report({
    minimatch: { severity: "moderate", via: [advisory("minimatch", MINIMATCH, "moderate")] },
    leftpad: { severity: "moderate", via: [advisory("leftpad", OTHER, "moderate")] },
    rightpad: { severity: "low", via: [advisory("rightpad", "GHSA-dddd-eeee-ffff", "low")] },
    eslint: { severity: "moderate", via: ["minimatch", "leftpad"] },
  });
  assert.equal(evaluate({ fullReport }).ok, true);
  assert.equal(evaluate({ fullReport, exceptions: [] }).ok, true);
  assert.equal(evaluate({ fullReport, today: "2027-01-01" }).ok, true);
});

test("an excepted advisory that became critical is still bound by its expiry only", () => {
  const fullReport = report({ picomatch: { severity: "critical", via: [advisory("picomatch", PICOMATCH, "critical")] } });
  assert.equal(evaluate({ fullReport }).ok, true);
  assert.equal(evaluate({ fullReport, today: "2027-01-01" }).ok, false);
});

test("an exception whose advisory is no longer reported warns without failing", () => {
  const result = evaluate({ fullReport: clean });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /GHSA-fc5q-39xc-vjpf \(picomatch\) no longer matches/);
});

test("anything in shipped dependencies fails, including an excepted advisory", () => {
  for (const [id, name, severity] of [
    [PICOMATCH, "picomatch", "high"], [MINIMATCH, "minimatch", "moderate"], [OTHER, "leftpad", "low"],
  ]) {
    const result = evaluate({ shippedReport: report({ [name]: { severity, via: [advisory(name, id, severity)] } }) });
    assert.equal(result.ok, false, id);
    assert.match(result.failures.join("\n"), new RegExp(`Shipped dependency ${name} has ${severity} advisory ${id}`));
  }
});

test("an unreadable or unexpected report fails closed", () => {
  const broken = [
    undefined, null, "", "not json", 0, [], {},
    { error: { code: "ENOTFOUND", summary: "request failed" } },
    { message: "request to the registry failed" },
    { ...clean, auditReportVersion: 3 },
    { ...clean, error: { code: "EAUDITNOLOCK" } },
    { ...clean, vulnerabilities: undefined },
    { ...clean, vulnerabilities: [] },
    { ...clean, metadata: undefined },
    { ...clean, metadata: {} },
    { ...clean, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, high: 1 } } },
    { ...clean, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, total: 1 } } },
    { ...clean, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, high: undefined } } },
    report({ leftpad: { severity: "high", via: [] } }),
    report({ leftpad: { severity: "high", via: ["missing"] } }),
    report({ leftpad: { severity: "high", via: [42] } }),
    report({ leftpad: { severity: "high", via: [{ ...advisory("leftpad", OTHER, "high"), url: "https://example.invalid/x" }] } }),
    report({ leftpad: { severity: "high", via: [{ ...advisory("leftpad", OTHER, "high"), url: undefined }] } }),
    report({ leftpad: { severity: "high", via: [{ ...advisory("leftpad", OTHER, "high"), severity: "urgent" }] } }),
    report({ leftpad: { severity: "high", via: [advisory("rightpad", OTHER, "high")] } }),
    // Rated high with nothing of that level behind it.
    report({ leftpad: { severity: "high", via: [advisory("leftpad", OTHER, "moderate")] } }),
    report({ leftpad: { severity: "high", via: ["rightpad"] }, rightpad: { severity: "high", via: ["leftpad"] } }),
    { ...clean, vulnerabilities: { leftpad: "high" }, metadata: { vulnerabilities: { ...clean.metadata.vulnerabilities, high: 1, total: 1 } } },
  ];
  for (const [index, value] of broken.entries()) {
    assert.throws(() => collectAdvisories(value), Error, `fixture ${index}`);
    const asFull = evaluate({ fullReport: value });
    assert.equal(asFull.ok, false, `full fixture ${index}`);
    assert.match(asFull.failures.join("\n"), /Cannot read the audit of all dependencies/);
    const asShipped = evaluate({ shippedReport: value });
    assert.equal(asShipped.ok, false, `shipped fixture ${index}`);
    assert.match(asShipped.failures.join("\n"), /Cannot read the audit of shipped dependencies/);
  }
});

test("a malformed exception or date fails instead of being ignored", () => {
  const base = { id: PICOMATCH, package: "picomatch", reason: "Fixture reason", expires: "2026-12-31" };
  for (const exception of [
    { ...base, expires: undefined }, { ...base, expires: "2026-13-01" }, { ...base, expires: "2026-02-30" },
    { ...base, expires: "never" }, { ...base, expires: "9999" }, { ...base, expires: 20261231 },
    { ...base, reason: " " }, { ...base, reason: undefined }, { ...base, id: "*" }, { ...base, package: "" },
    null, "GHSA-fc5q-39xc-vjpf",
  ]) {
    const result = evaluate({ exceptions: [exception] });
    assert.equal(result.ok, false, JSON.stringify(exception));
    assert.match(result.failures.join("\n"), /Malformed audit exception/);
  }
  assert.equal(evaluate({ exceptions: undefined }).ok, false);
  for (const today of [undefined, "", "tomorrow", "2026-11-31", "18/11/2026", new Date("2026-11-18")]) {
    assert.equal(evaluate({ today }).ok, false, String(today));
  }
});
