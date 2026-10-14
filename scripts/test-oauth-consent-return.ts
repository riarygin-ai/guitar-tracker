/**
 * test-oauth-consent-return.ts
 *
 * Pure unit coverage for src/lib/oauthConsentReturn.ts — the post-login
 * redirect validator used by /login + /oauth/consent. No DB, no network.
 *
 * Usage:  npx tsx scripts/test-oauth-consent-return.ts
 */

import { safeLoginRedirect } from '../src/lib/oauthConsentReturn';

let passed = 0;
let failed = 0;
function check(label: string, condition: boolean, detail?: unknown) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.log(`  FAIL: ${label}`, detail !== undefined ? detail : ''); }
}

function main() {
  console.log('\n[A — valid targets]');
  check('exact /oauth/consent is allowed', safeLoginRedirect('/oauth/consent') === '/oauth/consent');
  check('/oauth/consent?authorization_id=abc is allowed', safeLoginRedirect('/oauth/consent?authorization_id=abc') === '/oauth/consent?authorization_id=abc');
  check('a URL-encoded authorization_id value survives untouched', safeLoginRedirect('/oauth/consent?authorization_id=abc%2D123') === '/oauth/consent?authorization_id=abc%2D123');

  console.log('\n[B — rejected targets (never an open redirect)]');
  check('null/undefined/empty are rejected', safeLoginRedirect(null) === null && safeLoginRedirect(undefined) === null && safeLoginRedirect('') === null);
  check('plain "/" is rejected (not the consent path)', safeLoginRedirect('/') === null);
  check('an unrelated internal path is rejected', safeLoginRedirect('/inventory') === null);
  check('a path merely starting with the right prefix string but not "/" or "?" next is rejected', safeLoginRedirect('/oauth/consentX') === null);
  check('an absolute URL is rejected', safeLoginRedirect('https://evil.example/oauth/consent') === null);
  check('a protocol-relative URL is rejected', safeLoginRedirect('//evil.example/oauth/consent') === null);
  check('a javascript: URL is rejected', safeLoginRedirect('javascript:alert(1)') === null);
  check('a backslash variant is rejected', safeLoginRedirect('/oauth/consent\\@evil.example') === null);
  check('a fragment is rejected', safeLoginRedirect('/oauth/consent#frag') === null);
  check('embedded control characters are rejected', safeLoginRedirect('/oauth/consent?authorization_id=abc\n') === null);
  check('a value over the length cap is rejected', safeLoginRedirect(`/oauth/consent?authorization_id=${'a'.repeat(600)}`) === null);
  check('non-string input types are rejected without throwing', safeLoginRedirect(123 as unknown as string) === null && safeLoginRedirect({} as unknown as string) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
