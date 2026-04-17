#!/usr/bin/env node
// Paper Auto-Index parser.
// Scans the repo for acg-paper frontmatter, fills missing fields, and
// generates papers.json and white-papers.html. Implements the rules
// defined in paper-auto-index-standard.html (Part 4).

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = process.cwd();
const PAPERS_JSON = path.join(REPO_ROOT, "papers.json");
const INDEX_HTML = path.join(REPO_ROOT, "white-papers.html");

const TYPE_ORDER = ["white-paper", "position-paper", "standard", "knowledge", "research-note", "experimental"];
const TYPE_LABEL = {
  "white-paper": "White Paper",
  "position-paper": "Position Paper",
  "experimental": "Experimental",
  "research-note": "Research Note",
  "knowledge": "Knowledge About Knowledge",
  "standard": "Standard",
};
const STATUS_VALUES = ["draft", "review", "published", "archived"];
const KNOWN_TAGS = [
  "ai-safety", "governance", "testing", "ethics", "architecture", "automation",
  "calibration", "peer-review", "culture", "epistemics", "falsification",
  "consciousness", "harness", "federation", "healthcare", "standards",
  "blockchain", "konomi", "isa-88", "isa-95", "packml", "scada", "opc-ua",
  "guild-chain", "guild-ops", "webrtc", "p2p", "github-actions", "ci-cd",
  "indexing", "white-papers",
  "knowledge-about-knowledge", "systems-thinking", "cognitive-apprenticeship",
  "triad-engine", "toast", "occam",
];

// ---------- minimal YAML subset parser (folded + literal block scalars) ----------
function parseYAML(text) {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const lines = [];
  for (const line of raw) {
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
          arr.push(parseBlock(li + 1));
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
      if (val === ">" || val === "|") obj[key] = readBlockScalar(val === "|", curIndent);
      else if (val === "") obj[key] = parseBlock(curIndent);
      else obj[key] = parseScalar(val);
    }
    return obj;
  }

  function readBlockScalar(literal, parentIndent) {
    const parts = []; let blockIndent = -1;
    while (i < lines.length) {
      const line = lines[i]; const li = indentOf(line);
      if (li <= parentIndent) break;
      if (blockIndent === -1) blockIndent = li;
      parts.push(line.slice(blockIndent)); i++;
    }
    if (literal) return parts.join("\n");
    let folded = "";
    for (const p of parts) {
      if (p.trim() === "") folded += "\n";
      else folded += (folded && !folded.endsWith("\n") ? " " : "") + p.trim();
    }
    return folded.trim();
  }
  return parseBlock(-1);
}

function stripComment(line) {
  let out = "", inStr = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (inStr) { out += c; if (c === inStr && line[k - 1] !== "\\") inStr = null; }
    else if (c === '"' || c === "'") { inStr = c; out += c; }
    else if (c === "#") break;
    else out += c;
  }
  return out;
}

function parseScalar(s) {
  if (s === "") return null;
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map((x) => parseScalar(x.trim()));
  }
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  return s;
}

function splitTopLevel(s, sep) {
  const out = []; let depth = 0, buf = "", inStr = null;
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

// ---------- extraction ----------

function extractFromHtml(text) {
  const m = text.match(/<!--\s*([\s\S]*?)-->/);
  if (!m) return null;
  const body = m[1];
  if (!/\bacg-paper\s*:/m.test(body)) return null;
  const parsed = parseYAML(body);
  return parsed && parsed["acg-paper"] ? parsed["acg-paper"] : null;
}

function extractFromMarkdown(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);
  if (!m) return null;
  const body = m[1];
  if (!/\bacg-paper\s*:/m.test(body)) return null;
  const parsed = parseYAML(body);
  return parsed && parsed["acg-paper"] ? parsed["acg-paper"] : null;
}

function extractFromSidecar(text) {
  const parsed = parseYAML(text);
  return parsed && parsed["acg-paper"] ? parsed["acg-paper"] : null;
}

function scanRepo(root) {
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = entry.name;
    const full = path.join(root, name);
    const text = fs.readFileSync(full, "utf8");
    let meta = null;
    if (name.endsWith(".html")) meta = extractFromHtml(text);
    else if (name.endsWith(".md")) meta = extractFromMarkdown(text);
    else if (name.endsWith(".meta.yml")) meta = extractFromSidecar(text);
    if (meta) results.push({ file: name, meta });
  }
  return results;
}

// ---------- fill + validate ----------

const REQUIRED = ["title", "author", "type", "abstract"];

function nextId(existing, prefix = "ACG-WP") {
  let max = 0;
  for (const e of existing) {
    const id = e.meta.id || "";
    const m = id.match(new RegExp(`^${prefix}-(\\d+)`));
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}-${new Date().getFullYear()}`;
}

function extractTags(title, abstract) {
  const text = ((title || "") + " " + (abstract || "")).toLowerCase();
  return KNOWN_TAGS.filter((t) => text.includes(t));
}

function slugFromFile(file) {
  return file.replace(/\.(html|md|meta\.yml)$/i, "");
}

function fill(entries) {
  const byId = new Map();
  // first pass: collect explicit IDs
  for (const e of entries) {
    const m = e.meta;
    if (!m.id) continue;
    if (byId.has(m.id)) e.duplicateId = true;
    byId.set(m.id, e);
  }
  // second pass: fill
  for (const e of entries) {
    const m = e.meta;
    if (!m.date) m.date = new Date().toISOString().slice(0, 10);
    if (!m.status) m.status = "draft";
    if (!m.tags || m.tags.length === 0) m.tags = extractTags(m.title, m.abstract);
    if (!m.slug) m.slug = slugFromFile(e.file);
    if (!m.id) m.id = nextId(entries);
  }
  return entries;
}

function validate(entries) {
  const problems = [];
  const seen = new Set();
  for (const e of entries) {
    const m = e.meta;
    for (const f of REQUIRED) if (!m[f]) problems.push(`${e.file}: missing required field '${f}'`);
    if (m.type && !TYPE_ORDER.includes(m.type)) problems.push(`${e.file}: unknown type '${m.type}'`);
    if (m.status && !STATUS_VALUES.includes(m.status)) problems.push(`${e.file}: unknown status '${m.status}'`);
    if (m.date && !/^\d{4}-\d{2}-\d{2}$/.test(m.date)) problems.push(`${e.file}: invalid ISO date '${m.date}'`);
    if (m.id) { if (seen.has(m.id)) problems.push(`${e.file}: duplicate id '${m.id}'`); seen.add(m.id); }
    if (e.file.endsWith(".html") && !fs.existsSync(path.join(REPO_ROOT, e.file))) problems.push(`${e.file}: file does not exist`);
  }
  return problems;
}

function sortEntries(entries) {
  const typeRank = (t) => {
    const k = TYPE_ORDER.indexOf(t);
    return k === -1 ? TYPE_ORDER.length : k;
  };
  return [...entries].sort((a, b) => {
    const ta = typeRank(a.meta.type), tb = typeRank(b.meta.type);
    if (ta !== tb) return ta - tb;
    if (a.meta.date !== b.meta.date) return (b.meta.date || "").localeCompare(a.meta.date || "");
    return (a.meta.title || "").localeCompare(b.meta.title || "");
  });
}

// ---------- emit ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatDate(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return iso || "";
  const [y, m] = iso.split("-");
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[parseInt(m, 10) - 1]} ${y}`;
}

function renderCard(m, href) {
  const label = TYPE_LABEL[m.type] || m.type;
  const statusBadge = (m.status === "draft" || m.status === "review")
    ? `    <span class="paper-status-badge">${escapeHtml(m.status === "draft" ? "Draft" : "For Review")}</span>\n`
    : "";
  const tagSpans = (m.tags || []).map((t) => `      <span class="tag">${escapeHtml(t)}</span>`).join("\n");
  return `  <article class="paper-card" data-type="${escapeHtml(m.type)}" data-tags="${escapeHtml((m.tags || []).join(" "))}">
    <div class="paper-meta">
      <span class="paper-author">${escapeHtml(m.author)}</span>
      <span class="paper-date">${escapeHtml(formatDate(m.date))}</span>
      <span class="paper-id">${escapeHtml(m.id)}</span>
    </div>
    <div class="paper-type-badge">${escapeHtml(label)}</div>
${statusBadge}    <h3>${escapeHtml(m.title)}</h3>
    <p class="paper-abstract">${escapeHtml(m.abstract)}</p>
    <div class="paper-tags">
${tagSpans}
    </div>
    <a href="${escapeHtml(href)}" class="paper-link">Read ${escapeHtml(label)} &rarr;</a>
  </article>`;
}

function renderIndex(entries) {
  const sections = new Map();
  for (const e of entries) {
    const key = e.meta.type || "other";
    if (!sections.has(key)) sections.set(key, []);
    sections.get(key).push(e);
  }
  const ordered = TYPE_ORDER.filter((t) => sections.has(t));
  for (const k of sections.keys()) if (!ordered.includes(k)) ordered.push(k);

  const blocks = ordered.map((t) => {
    const label = TYPE_LABEL[t] || t;
    const cards = sections.get(t).map((e) => renderCard(e.meta, e.file)).join("\n");
    return `<section class="paper-section" data-section="${escapeHtml(t)}">
  <h2>${escapeHtml(label)}</h2>
${cards}
</section>`;
  }).join("\n\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>White Papers &middot; ACG</title>
  <meta name="description" content="AI Craftspeople Guild publications, generated from paper frontmatter.">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body data-page="white-papers">
  <header class="site">
    <a class="brand" href="./index.html">ACG-TEST</a>
    <nav class="site-nav">
      <a href="./pages/standard.html">Standard</a>
      <a href="./pages/types.html">Types</a>
      <a href="./pages/example.html">Example</a>
      <a href="./pages/runner.html">Runner</a>
      <a href="./pages/terminal.html">Terminal</a>
      <a href="./white-papers.html" aria-current="page">Papers</a>
    </nav>
  </header>

  <main class="prose">
    <h1>White Papers</h1>
    <p class="lede">
      AI Craftspeople Guild publications. This page is generated from
      <code>papers.json</code> by the paper-index workflow. Do not edit by hand.
    </p>
    <p class="quiet">${entries.length} paper${entries.length === 1 ? "" : "s"} indexed &middot; generated by <code>.github/scripts/parse-papers.js</code></p>

${blocks}

  </main>

  <footer class="site">
    <p>AI Craftspeople Guild &middot; generated by <code>.github/scripts/parse-papers.js</code></p>
  </footer>
</body>
</html>
`;
}

function toRecord(e) {
  const m = e.meta;
  return {
    id: m.id,
    type: m.type,
    title: m.title,
    author: m.author,
    date: m.date,
    status: m.status,
    tags: m.tags || [],
    abstract: m.abstract,
    slug: m.slug,
    url: e.file,
  };
}

// ---------- main ----------

function main() {
  const found = scanRepo(REPO_ROOT);
  if (found.length === 0) {
    console.error("no paper frontmatter found at repo root");
    process.exit(0);
  }
  fill(found);
  const problems = validate(found);
  if (problems.length) {
    console.error("validation problems:");
    for (const p of problems) console.error("  - " + p);
    if (process.env.STRICT === "1") process.exit(1);
  }
  const sorted = sortEntries(found);
  const papers = sorted.map(toRecord);
  fs.writeFileSync(PAPERS_JSON, JSON.stringify(papers, null, 2) + "\n");
  fs.writeFileSync(INDEX_HTML, renderIndex(sorted));
  console.log(`wrote ${papers.length} paper${papers.length === 1 ? "" : "s"} to papers.json and white-papers.html`);
  for (const p of papers) console.log(`  ${p.id}  ${p.type.padEnd(14)}  ${p.title}`);
}

main();
