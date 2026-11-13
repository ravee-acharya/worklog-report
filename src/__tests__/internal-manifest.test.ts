import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The transform that turns the Marketplace manifest into the internal,
 * unlicensed clone. Worth real tests: a silent mistake here deploys the wrong
 * app id, or ships the internal build still carrying licensing.
 */

const REPO = path.join(__dirname, '..', '..');
const SCRIPT = path.join(REPO, 'scripts', 'make-internal-manifest.cjs');
const MARKETPLACE_ID = 'ari:cloud:ecosystem::app/ad045ff2-dddf-4d5c-9394-1e4bd6e30750';
const INTERNAL_ID = 'ari:cloud:ecosystem::app/11111111-2222-3333-4444-555555555555';

/** Run the script against a copy of the real manifest in a temp repo. */
function runTransform(
  manifest: string,
  appId: string = INTERNAL_ID,
): { ok: boolean; manifest: string; output: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-manifest-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'make-internal-manifest.cjs'));
  fs.writeFileSync(path.join(dir, 'manifest.yml'), manifest);
  // The repo is "type": "module"; without this the temp dir defaults to
  // CommonJS and the test stops reproducing how CI actually runs the script.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ type: 'module' }));

  let ok = true;
  let output = '';
  try {
    output = execFileSync('node', [path.join(dir, 'scripts', 'make-internal-manifest.cjs')], {
      env: { ...process.env, FORGE_INTERNAL_APP_ID: appId },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    ok = false;
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  return { ok, manifest: fs.readFileSync(path.join(dir, 'manifest.yml'), 'utf8'), output };
}

/** The real manifest, so these tests fail if its shape changes under them. */
const REAL_MANIFEST = fs.readFileSync(path.join(REPO, 'manifest.yml'), 'utf8');

describe('make-internal-manifest', () => {
  it('swaps the app id to the internal one', () => {
    const { ok, manifest } = runTransform(REAL_MANIFEST);

    expect(ok).toBe(true);
    expect(manifest).toContain(`id: ${INTERNAL_ID}`);
    expect(manifest).not.toContain(MARKETPLACE_ID);
  });

  // The whole point of the clone: it must not ask anyone to subscribe.
  it('removes licensing so the clone stays free', () => {
    const { manifest } = runTransform(REAL_MANIFEST);
    expect(manifest).not.toMatch(/licensing:/);
    expect(manifest).not.toMatch(/enabled:\s*true/);
  });

  it('suffixes the title so both apps are tellable apart in Jira', () => {
    const { manifest } = runTransform(REAL_MANIFEST);
    expect(manifest).toContain('title: Worklog Report (Internal)');
  });

  it('leaves scopes, modules and resources untouched', () => {
    const { manifest } = runTransform(REAL_MANIFEST);
    expect(manifest).toContain("'read:jira-work'");
    expect(manifest).toContain("'read:jira-user'");
    expect(manifest).toContain("'storage:app'");
    expect(manifest).toContain('key: worklog-report');
    expect(manifest).toContain('handler: index.handler');
    expect(manifest).toContain('path: src/frontend/index.tsx');
  });

  it('is idempotent — running twice does not double the suffix', () => {
    const once = runTransform(REAL_MANIFEST).manifest;
    const twice = runTransform(once).manifest;
    expect(twice).toContain('title: Worklog Report (Internal)');
    expect(twice).not.toContain('(Internal) (Internal)');
  });

  // The dangerous mistake: pointing the internal build at the Marketplace app
  // would deploy the unlicensed clone over the app customers pay for.
  it('refuses when the internal id equals the Marketplace id', () => {
    const { ok, output, manifest } = runTransform(REAL_MANIFEST, MARKETPLACE_ID);

    expect(ok).toBe(false);
    expect(output).toMatch(/same as the id already in the manifest/);
    // And it must not have half-applied the other edits.
    expect(manifest).toContain('licensing:');
  });

  it('refuses an id that is not an app ARI', () => {
    const { ok, output } = runTransform(REAL_MANIFEST, 'not-an-ari');
    expect(ok).toBe(false);
    expect(output).toMatch(/does not look like an app ARI/);
  });

  it('refuses when FORGE_INTERNAL_APP_ID is unset', () => {
    const { ok, output } = runTransform(REAL_MANIFEST, '');
    expect(ok).toBe(false);
    expect(output).toMatch(/is not set/);
  });

  // If licensing is ever removed from the Marketplace manifest, this script's
  // assumptions no longer hold and it should say so rather than quietly
  // producing a manifest that looks right.
  it('fails loudly if there is no licensing block to remove', () => {
    const noLicensing = REAL_MANIFEST.replace(/licensing:\n\s+enabled: true\n/, '');
    const { ok, output } = runTransform(noLicensing);

    expect(ok).toBe(false);
    expect(output).toMatch(/could not find a licensing block/);
  });
});
