// Unofficial client for beyondthewhiteboard.com.
// There is no public BTWB API - this calls the same internal endpoints the
// BTWB web app itself uses, authenticated with a copied browser session
// cookie rather than a real API key. It can break if BTWB changes their app,
// and the cookie will need refreshing whenever the session expires.

import { execFileSync } from "node:child_process";
import { userInfo } from "node:os";

const BASE_URL = "https://beyondthewhiteboard.com";
const KEYCHAIN_SERVICE = "btwb-session-cookie";
const PASSWORD_KEYCHAIN_SERVICE = "btwb-password";

let cachedCookie;
let keychainError;

// Merges a response's Set-Cookie headers into a "name=value; name2=value2"
// Cookie string, replacing same-named cookies. BTWB sets more than one cookie
// at once (remember_me_token AND _btwb_session_id at sign-in, and a rotated
// _btwb_session_id on page loads), and the CSRF token on a page is tied to the
// _btwb_session_id sent with it - keeping only the first cookie makes every
// write (log/delete) fail with HTTP 422 while reads still work.
function mergeSetCookies(cookieString, headers) {
  const setCookies =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : (headers.get("set-cookie") || "").split(/,(?=\s*[^;=\s]+=)/);

  const jar = new Map();
  for (const pair of (cookieString || "").split(";")) {
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  for (const setCookie of setCookies) {
    const pair = setCookie.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

function readSecretFromKeychain(service) {
  try {
    // process.env.USER is not reliable here - GUI-launched processes (like
    // the Claude desktop app spawning this server) often don't have it set.
    // os.userInfo() asks the OS directly instead.
    const account = userInfo().username;
    return execFileSync(
      "security",
      ["find-generic-password", "-a", account, "-s", service, "-w"],
      { encoding: "utf8" }
    ).trim();
  } catch (err) {
    if (service === KEYCHAIN_SERVICE) {
      keychainError = err.stderr ? err.stderr.toString().trim() : err.message;
    }
    return undefined;
  }
}

function readFromKeychain() {
  return readSecretFromKeychain(KEYCHAIN_SERVICE);
}

// Keychain is the preferred source of truth for both the live cookie and the
// login password - it's what refreshSessionCookie() keeps current automatically
// on macOS. BTWB_PASSWORD is a fallback for a Claude cloud session (a Linux
// container with no Keychain): unlike a cookie, a password doesn't go stale,
// so holding it in an env var doesn't reintroduce the "stale copied cookie"
// problem the Keychain-only design was chosen to avoid.
function readPassword() {
  return readSecretFromKeychain(PASSWORD_KEYCHAIN_SERVICE) || process.env.BTWB_PASSWORD;
}

async function getCookie() {
  if (cachedCookie) return cachedCookie;

  const cookie = readFromKeychain();
  if (cookie) {
    cachedCookie = cookie;
    return cachedCookie;
  }

  // No stored cookie - either nothing's been saved yet, or this host has no
  // Keychain at all (readFromKeychain() fails the same way either way). If
  // login credentials are configured, get a fresh cookie automatically
  // instead of requiring a manual DevTools copy on every restart.
  if (process.env.BTWB_EMAIL && readPassword()) {
    await refreshSessionCookie();
    return cachedCookie;
  }

  throw new Error(
    `No BTWB session cookie found in Keychain (service: ${KEYCHAIN_SERVICE}). ` +
      "Either set BTWB_EMAIL plus a password (Keychain on macOS, or the BTWB_PASSWORD " +
      "env var on hosts without Keychain) so refresh_session_cookie can log in " +
      "automatically, or copy one manually from DevTools and store it - see README.md." +
      (keychainError ? ` [Keychain error: ${keychainError}]` : "")
  );
}

// Logs in with BTWB_EMAIL + a password (Keychain on macOS, or BTWB_PASSWORD
// elsewhere) and replaces the stored session cookie with a fresh one - the
// same request beyondthewhiteboard.com's own /signin form makes (GET /signin
// for a pre-login session cookie + CSRF token, then POST /session with
// credentials). Optional: only works if both credentials are configured (see
// README "Automatic cookie refresh"); without them this throws and callers
// fall back to the "copy a fresh cookie by hand" error path.
export async function refreshSessionCookie() {
  const email = process.env.BTWB_EMAIL;
  const password = readPassword();
  if (!email || !password) {
    throw new Error(
      "Can't auto-refresh the BTWB session: set BTWB_EMAIL and a password - store the " +
        `password in Keychain (service: ${PASSWORD_KEYCHAIN_SERVICE}) on macOS, or set the ` +
        "BTWB_PASSWORD env var on hosts without Keychain - see README " +
        '"Automatic cookie refresh". Otherwise copy a fresh Cookie header from your ' +
        "browser by hand instead."
    );
  }

  const signinRes = await fetch(`${BASE_URL}/signin`);
  const signinCookie = mergeSetCookies("", signinRes.headers);
  const signinHtml = await signinRes.text();
  const tokenMatch = signinHtml.match(/name="authenticity_token" value="([^"]+)"/);
  if (!tokenMatch) {
    throw new Error("Could not find a CSRF token on the BTWB sign-in page - it may have changed.");
  }

  const body = new URLSearchParams({
    authenticity_token: tokenMatch[1],
    login: email,
    password,
    remember_me: "1",
    commit: "Sign In",
  });

  const loginRes = await fetch(`${BASE_URL}/session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(signinCookie ? { Cookie: signinCookie } : {}),
    },
    body,
    redirect: "manual",
  });

  if (![302, 303].includes(loginRes.status)) {
    throw new Error(
      `BTWB sign-in failed: HTTP ${loginRes.status}. Check BTWB_EMAIL and the password ` +
        `(Keychain service: ${PASSWORD_KEYCHAIN_SERVICE}, or BTWB_PASSWORD) are correct - ` +
        "this also fails if BTWB ever adds a CAPTCHA/2FA step to sign-in."
    );
  }

  if (!loginRes.headers.get("set-cookie")) {
    throw new Error("BTWB sign-in succeeded but didn't return a new session cookie.");
  }
  const freshCookie = mergeSetCookies(signinCookie, loginRes.headers);

  try {
    execFileSync("security", [
      "add-generic-password",
      "-a", userInfo().username,
      "-s", KEYCHAIN_SERVICE,
      "-w", freshCookie,
      "-A",
      "-U",
    ]);
  } catch {
    // No Keychain on this host (e.g. a Claude cloud session) - the refreshed
    // cookie still lives in the in-memory cache below for this process's
    // lifetime, it just isn't persisted across restarts. Expected outside
    // macOS, not an error.
  }

  cachedCookie = freshCookie;
  return { success: true };
}

async function fetchWhiteboardHtml() {
  const res = await fetch(`${BASE_URL}/whiteboard`, {
    headers: { Cookie: await getCookie() },
  });
  if (!res.ok) {
    throw new Error(`Failed to load page for CSRF token: HTTP ${res.status}`);
  }
  // Keep any rotated session cookie so the write that follows is sent with
  // the same session this page's CSRF token belongs to.
  cachedCookie = mergeSetCookies(cachedCookie, res.headers);
  return res.text();
}

async function getCsrfToken() {
  let html = await fetchWhiteboardHtml();
  let match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
  if (!match) {
    // Missing csrf-token usually means the session cookie has expired and
    // BTWB served a logged-out page instead - try one automatic re-login
    // (if configured) before falling back to the manual-copy error.
    await refreshSessionCookie();
    html = await fetchWhiteboardHtml();
    match = html.match(/<meta name="csrf-token" content="([^"]+)"/);
    if (!match) {
      throw new Error(
        "Could not find a CSRF token on the page even after refreshing the session - " +
          "BTWB's login page may have changed."
      );
    }
  }
  return match[1];
}

// The signed-in member's own ID, read from the "Analyze Dashboard" link in
// BTWB's navigation menu (/analyze/members/{id}) - that link always points at
// the current user, unlike other /members/{id} links on the whiteboard, which
// can belong to gym-mates. Cached for the process's lifetime.
let cachedMemberId;

export async function getMemberId() {
  if (cachedMemberId) return cachedMemberId;

  const pattern = /href="\/analyze\/members\/(\d+)"/;
  let match = (await fetchWhiteboardHtml()).match(pattern);
  if (!match) {
    // Same expired-session fallback as getCsrfToken().
    await refreshSessionCookie();
    match = (await fetchWhiteboardHtml()).match(pattern);
    if (!match) {
      throw new Error(
        "Could not find your member ID on the BTWB whiteboard page even after " +
          "refreshing the session - BTWB's navigation markup may have changed."
      );
    }
  }
  cachedMemberId = Number(match[1]);
  return cachedMemberId;
}

export async function searchMovement(term) {
  const res = await fetch(
    `${BASE_URL}/exercises/autocomplete_name.json?posting_trait=true&term=${encodeURIComponent(term)}`,
    { headers: { Cookie: await getCookie() } }
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
  const cookie = await getCookie();

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

// Logs a multi-movement "rounds" result (e.g. a "For Time" WOD with several
// movements per round), as opposed to logWorkout's single-movement schema.
// Reverse-engineered by filling out a real BTWB "Log Result" form for a
// named/benchmark workout and extracting its actual POST payload - BTWB uses
// a totally different field name and JSON shape here ("uiobject", execution
// type "bookends") than the single-movement flow ("definition", execution
// type "weightlifting/sets"). Only the "For Time" / totalTime-scoring case
// has been tested; other scoring types (e.g. AMRAP/totalReps) may need a
// different execution.type/scoring and haven't been verified.
export async function logRoundsWorkout({
  workoutId,
  workoutSlug,
  memberId,
  sections,
  totalTimeSeconds,
  performedDate,
  rxd,
  notes = "",
  trackEventId,
}) {
  const csrfToken = await getCsrfToken();
  const cookie = await getCookie();

  const uiobject = {
    type: "workoutSession",
    execution: {
      type: "bookends",
      inputs: { time: { value: totalTimeSeconds, unit: "seconds" } },
      scoring: "totalTime",
      result: { totalTime: { value: totalTimeSeconds, unit: "seconds" } },
    },
    contents: sections.map(({ rounds, movements }) => ({
      type: "section",
      rounds,
      contents: movements.map(({ movementName, movementId, measures }) => ({
        type: "movement",
        movementName,
        movementId,
        ...measures,
      })),
    })),
  };

  // The form's hidden "performedOn" field carries a human-readable date
  // alongside session_date - included for parity with what the real form
  // sends, since it's unclear whether the server actually depends on it.
  const performedOn = new Date(`${performedDate}T00:00:00`).toLocaleDateString(
    "en-US",
    { weekday: "long", month: "long", day: "numeric", year: "numeric" }
  );

  const body = new URLSearchParams({
    authenticity_token: csrfToken,
    "workout_session[uiobject]": JSON.stringify(uiobject),
    "workout_session[member_id]": String(memberId),
    "workout_session[rxd]": String(rxd),
    "workout_session[session_date]": performedDate,
    performedOn,
    "workout_session[notes_plain_text]": notes,
    // Hard rule, not a default: every post through this server is private.
    // Do not wire a parameter that can override this - see README "Privacy".
    "workout_session[privacy]": "onlyme",
  });
  if (trackEventId) {
    body.append("track_event_ids[]", String(trackEventId));
  }

  const res = await fetch(
    `${BASE_URL}/workouts/${workoutId}-${workoutSlug}/workout_sessions`,
    {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": csrfToken,
      },
      body,
      redirect: "manual",
    }
  );

  if (![302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB log_rounds_workout failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return {
    success: true,
    privacy: "onlyme",
    redirectedTo: res.headers.get("location"),
  };
}

export async function getMovementHistory({ memberId, movementId, movementSlug, days = 365 }) {
  memberId ??= await getMemberId();
  const seconds = Math.round(days * 86400);
  const res = await fetch(
    `${BASE_URL}/members/${memberId}/movements/${movementId}-${movementSlug}/vmax?d=${seconds}`,
    { headers: { Cookie: await getCookie() } }
  );
  if (!res.ok) {
    throw new Error(`BTWB movement history fetch failed: HTTP ${res.status}`);
  }
  return res.json();
}

// Rails' standard destroy action - the same request its own UJS delete links
// (data-method="delete") trigger, just issued directly as a real HTTP DELETE
// instead of simulating the link click.
export async function deleteWorkoutSession(sessionId) {
  const csrfToken = await getCsrfToken();
  const cookie = await getCookie();

  const res = await fetch(`${BASE_URL}/workout_sessions/${sessionId}`, {
    method: "DELETE",
    headers: {
      Cookie: cookie,
      "X-CSRF-Token": csrfToken,
    },
    redirect: "manual",
  });

  if (![200, 204, 302, 303].includes(res.status)) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `BTWB delete_workout_session failed: HTTP ${res.status}. ${text.slice(0, 300)}`
    );
  }

  return { success: true, sessionId };
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

// There's no JSON endpoint for a single workout_session (unlike search/log/
// history) - this scrapes the session's page HTML instead. Built against the
// "Lifting Complex" (CrossFit Total) page template; other workout types
// (single-movement, named/benchmark WODs) use the same "Sets" / "Result"
// section labels as of this writing, but haven't all been tested - if BTWB
// changes their markup, or a workout type renders differently, the relevant
// field will just come back null/empty rather than throwing.
export async function getWorkoutSession(sessionId) {
  const res = await fetch(`${BASE_URL}/workout_sessions/${sessionId}`, {
    headers: { Cookie: await getCookie() },
  });
  if (!res.ok) {
    throw new Error(`BTWB workout session fetch failed: HTTP ${res.status}`);
  }
  const html = await res.text();

  const nameMatch = html.match(
    /class="h4 fw-semibold text-dark text-uppercase text-decoration-none d-none d-lg-block"[^>]*>([^<]+)<\/a>/
  );
  const workoutName = nameMatch ? decodeHtmlEntities(nameMatch[1]) : null;

  const dateMatch = html.match(/mdi-calendar-blank"><\/span>\s*([\d-]+)/);
  const timeMatch = html.match(/mdi-clock-outline"><\/span>\s*([\d: ]+(?:AM|PM))/);
  const performedDate = dateMatch ? dateMatch[1].trim() : null;
  const performedTime = timeMatch ? timeMatch[1].trim() : null;

  const setsMatch = html.match(/<p>Sets\s*([\s\S]*?)<\/p>/);
  let sets = null;
  if (setsMatch) {
    sets = setsMatch[1]
      .split(/<br\s*\/?>/)
      .map((line) => decodeHtmlEntities(line.replace(/<[^>]+>/g, "")))
      .filter(Boolean);
  }

  const resultMatch = html.match(
    /Result<\/p>\s*<div class="row[^>]*>\s*<div class="d-inline[^>]*>\s*<span class="text-dark text-decoration-none"[^>]*>\s*([^<]+?)\s*<\/span>/
  );
  const result = resultMatch ? decodeHtmlEntities(resultMatch[1]) : null;

  const levelMatch = html.match(/Level (\d+)/);
  const wodRankMatch = html.match(/(\d+)(?:st|nd|rd|th) WOD/);

  return {
    sessionId,
    url: `${BASE_URL}/workout_sessions/${sessionId}`,
    workoutName,
    performedDate,
    performedTime,
    sets,
    result,
    level: levelMatch ? Number(levelMatch[1]) : null,
    wodRank: wodRankMatch ? Number(wodRankMatch[1]) : null,
  };
}
