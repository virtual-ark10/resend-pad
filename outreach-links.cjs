// outreach-links.cjs — OPTIONAL send-time link internalization for the pad kit.
//
// This module is only invoked when OUTREACH_ENABLED is on (default OFF). It
// exists for teams that run a click-attribution service and want the pad to
// (a) re-mint tracking links that their service no longer knows about and
// (b) refuse to send an email whose links point outside their own site.
//
// Nothing here is brand-specific: every host, path and credential comes from
// the `cfg` object passed in by server.cjs.
//
// Guarantees when ENABLED (fail-closed — an email never goes out broken/leaky):
//   1. Every tracked link (`{siteUrl}/api/click?lt=TOKEN`) must use a token the
//      attribution API knows about. Old-format local tokens (32-hex) are dead
//      server-side and are re-minted automatically at send time. The local
//      attribution store doubles as the dedupe mirror.
//   2. No link whose host is outside the allowed set leaves the pad.
//
// If anything is unresolvable (unknown token, external dest, API down) the send
// is BLOCKED with a human-readable message — never silently sent.
//
// Config (cfg):
//   siteUrl      — public site origin used for tracking links, e.g. https://example.com
//   apiBase      — attribution API base, e.g. http://127.0.0.1:3000/api/v1
//   token        — API bearer token ('' disables re-minting, still enforces policy)
//   storePath    — local attribution store mirror (attribution.json) — optional
//   allowedHosts — extra hostnames allowed in outgoing links (siteUrl host is always allowed)
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');

const OLD_LOCAL_RE = /^[a-f0-9]{32}$/;
const URL_RE = /https?:\/\/[^\s"'<>)]+/g;

class InternalizeError extends Error {}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeSite(siteUrl) {
  const raw = String(siteUrl || '').trim().replace(/\/+$/, '');
  if (!raw) return { base: '', host: '', clickPrefix: '' };
  let host = '';
  try { host = new URL(raw).hostname; } catch { host = ''; }
  return { base: raw, host, clickPrefix: `${raw}/api/click?lt=` };
}

function ltRegex(siteUrl) {
  const { clickPrefix } = normalizeSite(siteUrl);
  if (!clickPrefix) return /\u0000never-match\u0000/g;
  return new RegExp(escapeRe(clickPrefix) + '([A-Za-z0-9_-]{20,40})', 'g');
}

function isApiToken(tok) {
  // Server-minted tokens are base64url; old local mints were 32-lowercase-hex.
  return !OLD_LOCAL_RE.test(tok) && /^[A-Za-z0-9_-]{22,32}$/.test(tok);
}

function short(tok) { return `lt=${String(tok).slice(0, 10)}…`; }

function readStore(storePath) {
  if (!storePath) return { clicks: [], visits: [] };
  try {
    const d = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return (d && Array.isArray(d.clicks)) ? d : { clicks: [], visits: [] };
  } catch {
    return { clicks: [], visits: [] };
  }
}

// POST {apiBase}/outreach/links -> resolves with the minted row.
function mintLink(cfg, leadId, dest, ref, campaign) {
  return new Promise((resolve, reject) => {
    const url = new URL(String(cfg.apiBase).replace(/\/+$/, '') + '/outreach/links');
    const body = JSON.stringify(campaign
      ? { leadId, dest, ref, campaign }
      : { leadId, dest, ref });
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 20000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      res.on('end', () => {
        let payload;
        try { payload = JSON.parse(data); } catch { payload = null; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const msg = (payload && payload.error && payload.error.message) ? payload.error.message : data.slice(0, 200);
          return reject(new InternalizeError(`mint failed (HTTP ${res.statusCode}): ${msg}`));
        }
        const d = (payload && payload.data) || {};
        if (!d.token) return reject(new InternalizeError('mint response missing token'));
        return resolve(d);
      });
    });
    req.on('error', (e) => reject(new InternalizeError(`mint network error: ${e.message}`)));
    req.write(body);
    req.end();
  });
}

// Core: rewrite tracked links to server-known internal tokens, fail on externals.
// Returns { text, html, minted } with text/html rewritten. Throws InternalizeError.
async function internalize(rawText, rawHtml, leadId, cfg) {
  const text = rawText || '';
  const html = rawHtml || '';
  const conf = cfg || {};
  const site = normalizeSite(conf.siteUrl);
  if (!site.base || !site.host) {
    throw new InternalizeError('OUTREACH_SITE_URL is not configured — cannot verify/internalize links');
  }
  const allowed = new Set([site.host].concat(Array.isArray(conf.allowedHosts) ? conf.allowedHosts : []).map((h) => String(h).toLowerCase()));
  const store = readStore(conf.storePath);
  const byToken = new Map(store.clicks.map((c) => [c.token, c]));

  const tokens = new Set();
  for (const m of `${text}\n${html}`.matchAll(ltRegex(site.base))) tokens.add(m[1]);

  let newText = text;
  let newHtml = html;
  const minted = [];
  let dirty = false;

  for (const tok of tokens) {
    const row = byToken.get(tok) || {};
    if (!row.dest) {
      throw new InternalizeError(`${short(tok)} is not in the attribution store (${conf.storePath || 'unset'}) — mint it via the API before sending`);
    }
    const dest = row.dest || '';
    if (!dest.startsWith(site.base)) {
      throw new InternalizeError(`${short(tok)} still points externally (${dest}) — internalize it before sending`);
    }
    if (isApiToken(tok)) continue; // already server-known and internal

    if (!conf.token) {
      throw new InternalizeError(`cannot re-mint ${short(tok)}: pad has no OUTREACH_BEARER_TOKEN — set it in .env`);
    }
    const slug = dest.split('/').pop();
    const nt = await mintLink(conf, leadId, dest, `pub-${slug}`, row.campaign || 'pad-send');
    byToken.set(nt.token, nt);
    store.clicks.push(nt);
    minted.push(nt);
    dirty = true;
    const oldLink = `${site.clickPrefix}${tok}`;
    newText = newText.split(oldLink).join(`${site.clickPrefix}${nt.token}`);
    newHtml = newHtml.split(oldLink).join(`${site.clickPrefix}${nt.token}`);
  }

  // Fail closed on ANY link outside the allowed hosts.
  for (const s of [newText, newHtml]) {
    for (const m of s.matchAll(URL_RE)) {
      let host;
      try { host = new URL(m[0]).hostname.toLowerCase(); } catch { continue; }
      if (!allowed.has(host)) {
        throw new InternalizeError(`outgoing email links out to ${host} (${m[0].slice(0, 90)}) — allowed hosts: ${[...allowed].join(', ')} (internalize it before sending)`);
      }
    }
  }

  if (dirty && conf.storePath) {
    fs.writeFileSync(conf.storePath, JSON.stringify(store, null, 2) + '\n');
  }
  return { text: newText, html: newHtml, minted };
}

// Wrap bare http(s) URLs in <a href="...">...</a> anchors for the HTML body.
// Brand-agnostic and idempotent: URLs already inside an <a>...</a> element or an
// attribute value (href/src/content/cite/action) are left untouched, so re-runs
// are no-ops. Only the HTML part needs this — text/plain emails keep bare URLs,
// which is the correct standard form for them.
function linkifyHtml(html) {
  const masks = [];
  const hold = (m) => {
    masks.push(m);
    return `\u0000${masks.length - 1}\u0000`;
  };
  let masked = String(html || '');
  // Protect existing anchors and attribute values from re-wrapping.
  masked = masked.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, hold);
  masked = masked.replace(/(?:href|src|content|cite|action)\s*=\s*["'][^"']*["']/gi, hold);
  // Wrap bare URLs (stop at whitespace, quotes, angle brackets, brackets/parens,
  // and the mask placeholder so a URL directly next to an anchor stays intact).
  masked = masked.replace(/(https?:\/\/[^\s"'<>()[\]{}\u0000]+)/g, (m) => {
    let u = m;
    while (u.length && /[.,;:!?]$/.test(u)) u = u.slice(0, -1); // drop trailing sentence punctuation
    return `<a href="${u}">${u}</a>`;
  });
  return masked.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[Number(i)]);
}

module.exports = { internalize, linkifyHtml, InternalizeError, isApiToken };
