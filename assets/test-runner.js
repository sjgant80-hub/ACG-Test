// ACG-TEST in-browser runner.
// Loads tests/manifest.json, fetches each .test.yml and its target,
// evaluates each UDT:Expectation, and renders verdicts.
//
// Expect vocabulary per the standard: present | triggered | not triggered | configured
// Result vocabulary per the standard: pass | fail | skip

// ---------- minimal YAML subset parser ---------- //
// Handles the ACG-TEST shape: block mappings, block lists, inline lists,
// scalars (string/number/bool/null), quoted strings, and comments.

function parseYAML(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  for (const line of raw) {
    // strip full-line comments but keep the line so indentation stays intact
    const noComment = stripComment(line).replace(/\s+$/, "");
    if (noComment.trim() === "") continue;
    lines.push(noComment);
  }

  let i = 0;
  const indentOf = (l) => l.match(/^ */)[0].length;

  function parseBlock(parentIndent) {
    if (i >= lines.length) return null;
    const first = lines[i];
    const curIndent = indentOf(first);
    if (curIndent <= parentIndent) return null;

    if (first.slice(curIndent).startsWith("- ")) {
      const arr = [];
      while (i < lines.length) {
        const line = lines[i];
        const li = indentOf(line);
        if (li < curIndent) break;
        if (li !== curIndent || !line.slice(li).startsWith("- ")) break;

        const rest = line.slice(li + 2);
        const m = rest.match(/^([^:]+):\s*(.*)$/);
        if (m) {
          lines[i] = " ".repeat(li + 2) + rest;
          const val = parseBlock(li + 1);
          arr.push(val);
        } else {
          arr.push(parseScalar(rest));
          i++;
        }
      }
      return arr;
    }

    const obj = {};
    while (i < lines.length) {
      const line = lines[i];
      const li = indentOf(line);
      if (li < curIndent) break;
      if (li > curIndent) { i++; continue; }
      const content = line.slice(li);
      const m = content.match(/^([^:]+):\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim();
      const val = m[2].trim();
      i++;
      if (val === "") {
        const child = parseBlock(curIndent);
        obj[key] = child === null ? null : child;
      } else {
        obj[key] = parseScalar(val);
      }
    }
    return obj;
  }

  return parseBlock(-1);
}

function stripComment(line) {
  let out = "";
  let inStr = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (inStr) {
      out += c;
      if (c === inStr && line[k - 1] !== "\\") inStr = null;
    } else if (c === '"' || c === "'") {
      inStr = c;
      out += c;
    } else if (c === "#") {
      break;
    } else {
      out += c;
    }
  }
  return out;
}

function parseScalar(s) {
  if (s === "") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner === "") return [];
    return splitTopLevel(inner, ",").map(x => parseScalar(x.trim()));
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  return s;
}

function splitTopLevel(s, sep) {
  const out = [];
  let depth = 0, buf = "", inStr = null;
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (inStr) { buf += c; if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

// ---------- runner ---------- //

const REASONED_TAGS = ["udt-expectation", "udt-eventtrigger", "udt-pathwatch", "udt-guardrail", "udt-secret", "udt-field"];

async function loadManifest() {
  const candidates = ["tests/manifest.json", "../tests/manifest.json"];
  for (const url of candidates) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (r.ok) return { base: url.replace("tests/manifest.json", ""), manifest: await r.json() };
    } catch (_) {}
  }
  throw new Error("tests/manifest.json not found");
}

async function fetchText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return await r.text();
}

async function fetchDoc(url) {
  const text = await fetchText(url);
  const doc = new DOMParser().parseFromString(text, "text/html");
  return doc;
}

function verdict(totals) {
  if (totals.failed > 0) return "red";
  if (totals.skipped > 0) return "yellow";
  return "green";
}

function makeTotals() { return { passed: 0, failed: 0, skipped: 0 }; }

function tally(totals, result) {
  if (result === "pass") totals.passed++;
  else if (result === "fail") totals.failed++;
  else totals.skipped++;
}

async function runOne(testPath, baseUrl) {
  const fullUrl = baseUrl + testPath;
  const out = {
    file: testPath,
    name: testPath,
    target: null,
    results: [],
    totals: makeTotals(),
  };
  let yml;
  try {
    yml = parseYAML(await fetchText(fullUrl));
  } catch (e) {
    out.results.push({ name: "load test file", result: "fail", reason: "test file could not be loaded", expected: "present", actual: "missing" });
    out.totals.failed++;
    return out;
  }

  out.name = yml.test || testPath;
  out.target = yml.target || yml.workflow || null;

  // 1. exists
  if (yml.exists) {
    const r = await checkExists(yml.exists, out.target, baseUrl);
    out.results.push(r);
    tally(out.totals, r.result);
  }

  // 2. watches (DOM selectors for pages; file paths for workflows)
  let doc = null;
  if (out.target && out.target.endsWith(".html")) {
    try { doc = await fetchDoc(baseUrl + out.target); } catch (_) { doc = null; }
  }

  for (const w of (yml.watches || [])) {
    const r = checkWatch(w, doc);
    out.results.push(r);
    tally(out.totals, r.result);
  }

  // 3. guardrails (forbidden DOM selectors / conditions)
  for (const g of (yml.guardrails || [])) {
    const r = checkGuardrail(g, doc);
    out.results.push(r);
    tally(out.totals, r.result);
  }

  // 4. secrets (for pages: required asset files)
  for (const s of (yml.secrets || [])) {
    const r = await checkSecret(s, baseUrl);
    out.results.push(r);
    tally(out.totals, r.result);
  }

  // 5. triggers (workflow-only: skipped in-browser, listed with reason)
  for (const t of (yml.triggers || [])) {
    out.results.push({
      name: `trigger: ${t.event}`,
      result: "skip",
      reason: t.reason || "workflow trigger requires runtime check",
      expected: t.expect,
      actual: "needs runtime check",
    });
    out.totals.skipped++;
  }

  // 6. notification (skipped, workflow-only)
  if (yml.notification) {
    out.results.push({
      name: "notification shape",
      result: "skip",
      reason: "notification shape requires runtime check",
      expected: "present",
      actual: "needs runtime check",
    });
    out.totals.skipped++;
  }

  return out;
}

async function checkExists(exists, target, baseUrl) {
  const name = `exists: ${target || "(unset)"}`;
  if (!target) {
    return { name, result: "fail", reason: exists.reason || "", expected: "target set", actual: "missing target" };
  }
  try {
    const r = await fetch(baseUrl + target, { method: "GET", cache: "no-store" });
    if (r.ok) return { name, result: "pass", reason: exists.reason || "", expected: "present", actual: "present" };
    return { name, result: "fail", reason: exists.reason || "", expected: "present", actual: `${r.status}` };
  } catch (_) {
    return { name, result: "fail", reason: exists.reason || "", expected: "present", actual: "unreachable" };
  }
}

function checkWatch(watch, doc) {
  const name = `watch: ${watch.path}`;
  const expect = watch.expect || "triggered";
  if (!doc) {
    return { name, result: "skip", reason: watch.reason || "", expected: expect, actual: "no DOM available" };
  }
  const found = doc.querySelector(watch.path) !== null;
  const shouldMatch = expect === "triggered";
  const ok = found === shouldMatch;
  return {
    name,
    result: ok ? "pass" : "fail",
    reason: watch.reason || "",
    expected: expect,
    actual: found ? "triggered" : "not triggered",
  };
}

function checkGuardrail(g, doc) {
  const name = `guardrail: ${g.condition}`;
  // Condition may be a CSS selector (page guardrail) or a description (workflow guardrail)
  const selector = looksLikeSelector(g.condition) ? g.condition : null;
  if (selector && doc) {
    const found = doc.querySelector(selector) !== null;
    return {
      name,
      result: found ? "fail" : "pass",
      reason: g.reason || "",
      expected: "not triggered",
      actual: found ? "triggered" : "not triggered",
    };
  }
  // Workflow guardrail — cannot verify in-browser
  return { name, result: "skip", reason: g.reason || "", expected: "not triggered", actual: "needs runtime check" };
}

function looksLikeSelector(s) {
  if (!s || typeof s !== "string") return false;
  return /^[a-zA-Z0-9\[\].#:>*~\s\-_="'()]+$/.test(s) && /[.#\[:a-zA-Z]/.test(s);
}

async function checkSecret(s, baseUrl) {
  const name = `secret/asset: ${s.name}`;
  // For page tests, s.name is a file path relative to site root.
  const isFile = typeof s.name === "string" && /\.[a-z0-9]+$/i.test(s.name);
  if (!isFile) {
    return { name, result: "skip", reason: s.reason || "", expected: "configured", actual: "needs runtime check" };
  }
  try {
    const r = await fetch(baseUrl + s.name, { method: "GET", cache: "no-store" });
    if (r.ok) return { name, result: "pass", reason: s.reason || "", expected: "configured", actual: "configured" };
    return { name, result: "fail", reason: s.reason || "", expected: "configured", actual: `${r.status}` };
  } catch (_) {
    return { name, result: "fail", reason: s.reason || "", expected: "configured", actual: "unreachable" };
  }
}

// ---------- rendering ---------- //

function renderSummary(el, results) {
  const totals = results.reduce((acc, r) => {
    const t = r.totals;
    acc.passed += t.passed; acc.failed += t.failed; acc.skipped += t.skipped;
    return acc;
  }, makeTotals());
  const v = verdict(totals);
  el.classList.remove("verdict-green", "verdict-red", "verdict-yellow");
  el.classList.add(`verdict-${v}`);

  const totalFiles = results.length;
  const allGreen = results.filter(r => r.totals.failed === 0 && r.totals.skipped === 0).length;
  const redFiles = results.filter(r => r.totals.failed > 0).length;

  el.innerHTML = `
    <div class="totals">
      <span class="p">${totals.passed} passed</span>
      <span class="f">${totals.failed} failed</span>
      <span class="s">${totals.skipped} skipped</span>
      <span>across ${totalFiles} test file${totalFiles === 1 ? "" : "s"}</span>
    </div>
    <ul>
      ${results.map(r => `
        <li class="${r.totals.failed > 0 ? "fail" : r.totals.skipped > 0 ? "skip" : "pass"}">
          <strong>${escape(r.name)}</strong>
          <span class="reason">${r.totals.passed}p / ${r.totals.failed}f / ${r.totals.skipped}s</span>
        </li>
      `).join("")}
    </ul>
  `;
}

function renderList(el, results) {
  el.innerHTML = results.map(r => `
    <details ${r.totals.failed > 0 ? "open" : ""}>
      <summary>
        ${escape(r.name)}
        <span class="badge ${r.totals.failed ? "fail" : r.totals.skipped ? "skip" : "pass"}">
          ${r.totals.failed ? "FAIL" : r.totals.skipped ? "PARTIAL" : "PASS"}
        </span>
      </summary>
      <div class="body">
        <p class="quiet">${escape(r.file)} · target: ${escape(r.target || "(none)")}</p>
        <ul class="summary">
          ${r.results.map(x => `
            <li class="${x.result}">
              <strong>${escape(x.name)}</strong>
              <span class="reason">&mdash; ${escape(x.reason || "")}</span>
              ${x.result === "fail" ? `<div class="reason">expected ${escape(x.expected)} &middot; got ${escape(x.actual)}</div>` : ""}
            </li>
          `).join("")}
        </ul>
      </div>
    </details>
  `).join("");
}

function renderProcess(el, fileResults) {
  // Drive the five process steps from data:
  // 1. scaffold   — manifest loaded
  // 2. fail       — any test file has at least one fail (or all skip/partial)
  // 3. write      — page file responds successfully (exists check)
  // 4. pass       — zero fails across all tests
  // 5. commit     — pass == true AND this site is being served (fetch succeeded)
  if (!el) return;
  const totalFail = fileResults.reduce((n, r) => n + r.totals.failed, 0);
  const totalPass = fileResults.reduce((n, r) => n + r.totals.passed, 0);
  const anyExists = fileResults.some(r => r.results.some(x => x.name.startsWith("exists:") && x.result === "pass"));
  const mark = (key, state) => {
    const li = el.querySelector(`[data-step="${key}"] .r`);
    if (!li) return;
    li.classList.remove("pass", "fail", "skip");
    li.classList.add(state);
    li.textContent = state;
  };
  mark("scaffold", "pass");
  mark("fail", totalFail === 0 ? "pass" : "fail");
  mark("write", anyExists ? "pass" : "fail");
  mark("pass", totalFail === 0 && totalPass > 0 ? "pass" : totalFail > 0 ? "fail" : "skip");
  mark("commit", totalFail === 0 && totalPass > 0 ? "pass" : "skip");
}

function escape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- boot ---------- //

async function main() {
  const summaryEl = document.getElementById("site-summary");
  const listEl = document.getElementById("test-list");
  const processEl = document.getElementById("process-steps");
  if (!summaryEl && !listEl && !processEl) return;

  let base, manifest;
  try {
    ({ base, manifest } = await loadManifest());
  } catch (e) {
    if (summaryEl) summaryEl.textContent = "manifest not found: " + e.message;
    return;
  }

  const results = [];
  for (const path of manifest.tests) {
    const r = await runOne(path, base);
    results.push(r);
  }

  if (summaryEl) renderSummary(summaryEl, results);
  if (listEl) renderList(listEl, results);
  if (processEl) renderProcess(processEl, results);
}

main();
