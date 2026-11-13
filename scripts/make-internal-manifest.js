#!/usr/bin/env node
/**
 * Rewrite manifest.yml in place so the SAME source deploys as the internal,
 * unlicensed clone of the app instead of the Marketplace one.
 *
 * Why a transform rather than a second manifest file: a Forge app's identity
 * is just `app.id`, so two checked-in manifests would be the same file twice,
 * drifting apart silently the moment anyone edits only one. Deriving the
 * internal variant guarantees it can only ever differ in the three ways
 * below.
 *
 * It makes exactly three changes:
 *   1. app.id            -> the internal app's ARI
 *   2. app.licensing     -> removed, so the clone is free and never asks a
 *                           site admin to subscribe
 *   3. globalPage title  -> suffixed, so two entries in Jira's Apps menu are
 *                           tellable apart
 *
 * Intended for CI on a throwaway checkout. It refuses to run against a dirty
 * tree so a stray local invocation can't leave the internal id committed to
 * the repo — which would deploy the clone's code over the Marketplace app.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', 'manifest.yml');
const TITLE_SUFFIX = ' (Internal)';

function fail(msg) {
  console.error(`make-internal-manifest: ${msg}`);
  process.exit(1);
}

const internalId = process.env.FORGE_INTERNAL_APP_ID;
if (!internalId) fail('FORGE_INTERNAL_APP_ID is not set.');
if (!/^ari:cloud:ecosystem::app\/[0-9a-f-]{36}$/.test(internalId)) {
  fail(`FORGE_INTERNAL_APP_ID does not look like an app ARI: ${internalId}`);
}

let src = fs.readFileSync(MANIFEST, 'utf8');

// 1. Swap the app id.
const idLine = /^(\s*)id:\s*(ari:cloud:ecosystem::app\/[0-9a-f-]{36})\s*$/m;
const idMatch = src.match(idLine);
if (!idMatch) fail('could not find the app id line in manifest.yml');
if (idMatch[2] === internalId) {
  fail('FORGE_INTERNAL_APP_ID is the same as the id already in the manifest — that would deploy the clone over the Marketplace app.');
}
src = src.replace(idLine, `${idMatch[1]}id: ${internalId}`);

// 2. Drop licensing, comments included, so the clone stays free.
//
//    Done line by line, on indentation. A regex that swallowed "the following
//    indented lines" also ate `id:` — a sibling key at the same depth — and
//    produced a manifest with no app id at all. Only lines indented DEEPER
//    than `licensing:` belong to it.
const lines = src.split('\n');
const keyIdx = lines.findIndex((l) => /^\s*licensing:\s*$/.test(l));
if (keyIdx === -1) fail('could not find a licensing block to remove');

const indentOf = (l) => l.match(/^[ \t]*/)[0].length;
const keyIndent = indentOf(lines[keyIdx]);

// Its children: deeper-indented lines directly beneath it.
let endIdx = keyIdx + 1;
while (endIdx < lines.length && lines[endIdx].trim() !== '' && indentOf(lines[endIdx]) > keyIndent) {
  endIdx++;
}

// Its explanatory comments: comment lines directly above, at the same depth.
let startIdx = keyIdx;
while (startIdx > 0) {
  const prev = lines[startIdx - 1];
  if (/^\s*#/.test(prev) && indentOf(prev) === keyIndent) startIdx--;
  else break;
}

lines.splice(startIdx, endIdx - startIdx);
src = lines.join('\n');

if (/licensing:/.test(src)) fail('licensing: still present after removal');
// The id sits beside licensing, so an over-greedy removal would take it too.
if (!src.includes(`id: ${internalId}`)) fail('the app id was lost while removing licensing');

// 3. Distinguish it in the Jira Apps menu.
const titleLine = /^(\s*)title:\s*(.+?)\s*$/m;
const titleMatch = src.match(titleLine);
if (!titleMatch) fail('could not find the globalPage title');
if (!titleMatch[2].endsWith(TITLE_SUFFIX)) {
  src = src.replace(titleLine, `${titleMatch[1]}title: ${titleMatch[2]}${TITLE_SUFFIX}`);
}

fs.writeFileSync(MANIFEST, src);

console.log('manifest.yml rewritten for the internal app:');
console.log(`  id        ${idMatch[2]}  ->  ${internalId}`);
console.log('  licensing removed');
console.log(`  title     ${titleMatch[2]}  ->  ${titleMatch[2]}${TITLE_SUFFIX}`);
