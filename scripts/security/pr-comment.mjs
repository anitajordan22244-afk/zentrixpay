#!/usr/bin/env node
/**
 * Post the malware-scan report on a pull request as a single sticky comment,
 * and keep the "security: flagged" label in sync with the result.
 *
 * Env: GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER, REPORT (path to the JSON
 * written by scan-malware.mjs --report). Uses only the REST API; it never
 * touches the PR's files.
 */
import { readFileSync } from "node:fs";

const MARKER = "<!-- zentrixpay-malware-scan -->";
const FLAG_LABEL = "security: flagged";
const {
  GITHUB_TOKEN,
  GITHUB_REPOSITORY,
  PR_NUMBER,
  REPORT,
  GITHUB_API_URL = "https://api.github.com",
} = process.env;

async function api(method, path, body) {
  const res = await fetch(`${GITHUB_API_URL}/repos/${GITHUB_REPOSITORY}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 || res.status === 404 ? null : res.json();
}

async function findComment() {
  for (let page = 1; page <= 10; page++) {
    const comments = await api("GET", `/issues/${PR_NUMBER}/comments?per_page=100&page=${page}`);
    if (!comments?.length) return null;
    const mine = comments.find((c) => c.body?.includes(MARKER) && c.user?.type === "Bot");
    if (mine) return mine;
  }
  return null;
}

async function main() {
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !PR_NUMBER || !REPORT)
    throw new Error("missing GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER or REPORT");
  const report = JSON.parse(readFileSync(REPORT, "utf8"));
  const existing = await findComment();
  const interesting = report.findings.some((f) => f.severity !== "warn");

  // Stay quiet on clean PRs; update an earlier warning so it doesn't go stale.
  if (interesting || existing) {
    const body = `${MARKER}\n${report.markdown}`;
    if (existing) await api("PATCH", `/issues/comments/${existing.id}`, { body });
    else await api("POST", `/issues/${PR_NUMBER}/comments`, { body });
  }

  if (report.failed) await api("POST", `/issues/${PR_NUMBER}/labels`, { labels: [FLAG_LABEL] });
  else await api("DELETE", `/issues/${PR_NUMBER}/labels/${encodeURIComponent(FLAG_LABEL)}`);
}

main().catch((err) => {
  // Reporting must never hide the scan result; the scan step decides pass/fail.
  console.error(`pr-comment: ${err.message}`);
});
