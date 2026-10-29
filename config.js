// ---------------------------------------------------------------------------
// Frontend configuration — edit these two values before this app will talk
// to a real backend. This file is loaded as a plain <script> tag by
// index.html, so changes take effect on page reload with no build step.
// ---------------------------------------------------------------------------

// Base URL of the News Summary Helper backend (FastAPI app).
//   - Defaults to http://localhost:8000 for local development.
//   - The real production URL is still undecided — deployment is being
//     reworked (possibly moving off the old VPS to running locally behind
//     a tunnel). Update this once that's settled. Do NOT reuse the old
//     https://newsapi.aryhsg.com domain; it has no working route for this
//     app in the backend's current nginx config.
const API_BASE = "http://localhost:8000";

// Must match the backend's INTERNAL_API_KEY value exactly. Every endpoint
// requires this, sent as the `X-API-KEY` header, or the backend returns
// 403 Access Denied.
//
// IMPORTANT: this is a 100%-static site with no server or build step, so
// there is no way to truly hide this value from anyone who opens dev tools
// or views page source. Treating it as a constant here is "good enough"
// obscurity for a personal project — it is NOT real security. Never reuse
// this key anywhere it would actually need to stay secret from the public.
const API_KEY = ""; // <-- fill in with the real INTERNAL_API_KEY value
