// Unofficial client for beyondthewhiteboard.com.
// There is no public BTWB API - this calls the same internal endpoints the
// BTWB web app itself uses, authenticated with a copied browser session
// cookie rather than a real API key. It can break if BTWB changes their app,
// and the cookie will need refreshing whenever the session expires.

import { execFileSync } from "node:child_process";

const BASE_URL = "https://beyondthewhiteboard.com";
const KEYCHAIN_SERVICE = "btwb-session-cookie";

let cachedCookie;

function readFromKeychain() {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-a", process.env.USER, "-s", KEYCHAIN_SERVICE, "-w"],
      { encoding: "utf8" }
    ).trim();
  } catch {
    return undefined;
  }
}

function getCookie() {
  if (cachedCookie) return cachedCookie;

  // Prefer an explicit env var (e.g. set by a terminal-launched session),
  // but fall back to Keychain directly - GUI-launched apps (like the Claude
  // desktop app) don't source ~/.zshrc, so an inherited env var can't be
  // relied on there even though .mcp.json references it.
  const cookie = process.env.BTWB_SESSION_COOKIE || readFromKeychain();
  if (!cookie) {
    throw new Error(
      "No BTWB session cookie found in BTWB_SESSION_COOKIE or in Keychain " +
        `(service: ${KEYCHAIN_SERVICE}). Copy the Cookie header from a logged-in ` +
        "browser request to beyondthewhiteboard.com (DevTools > Network) and " +
        "store it - see README.md."
    );
  }
  cachedCookie = cookie;
  return cookie;
}

async function getCsrfToken() {
  const res = await fetch(`${BASE_URL}/whiteboard`, {
    headers: { Cookie: getCookie() },
  });
  if (!res.ok) {
    throw new Error(`Failed to load page for CSRF token: HTTP ${res.status}`);
  }
  const html = await res.text();
  const match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!match) {
    throw new Error(
      "Could not find a CSRF token on the page - BTWB_SESSION_COOKIE is likely expired. " +
        "Copy a fresh Cookie header from your browser and try again."
    );
  }
  return match[1];
}

export async function searchMovement(term) {
  const res = await fetch(
    `${BASE_URL}/exercises/autocomplete_name.json?posting_trait=true&term=${encodeURIComponent(term)}`,
    { headers: { Cookie: getCookie() } }
  );
  if (!res.ok) {
    throw new Error(`BTWB movement search failed: HTTP ${res.status}`);
  }
  return res.json();
}

export async function logWorkout({
  movementId,
  movementName,
  reps,
  weight,
  weightUnit = "lbs",
  performedDate,
  notes = "",
}) {
  const csrfToken = await getCsrfToken();
  const cookie = getCookie();

  const definition = {
    type: "workoutSession",
    execution: {
      type: "weightlifting/sets",
      scoring: "totalWeight",
      result: { totalWeight: { value: weight, unit: weightUnit } },
    },
    contents: [
      {
        type: "movement",
        movementName,
        movementId,
        reps: { value: reps, unit: "reps" },
        inputs: { weight: { value: weight, unit: weightUnit } },
      },
    ],
  };

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "workout_session[definition]": JSON.stringify(definition),
    "workout_session[prescribed]": "true",
    "workout_session[performedDate]": performedDate,
    "workout_session[notes]": notes,
    // Hard rule, not a default: every post through this server is private.
    // Do not wire a parameter that can override this - see README "Privacy".
    "workout_session[privacy]": "onlyme",
    commit: "Log Result",
  });

  const res = await fetch(`${BASE_URL}/workouts/logger`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRF-Token": csrfToken,
    },
    body,
    redirect: "manual",
  });

  // Rails redirects (302/303) to the new workout_session on success.
  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB log_workout failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return {
    success: true,
    privacy: "onlyme",
    redirectedTo: res.headers.get("location"),
  };
}

export async function getMovementHistory({ memberId, movementId, movementSlug, days = 365 }) {
  const seconds = Math.round(days * 86400);
  const res = await fetch(
    `${BASE_URL}/members/${memberId}/movements/${movementId}-${movementSlug}/vmax?d=${seconds}`,
    { headers: { Cookie: getCookie() } }
  );
  if (!res.ok) {
    throw new Error(`BTWB movement history fetch failed: HTTP ${res.status}`);
  }
  return res.json();
}
