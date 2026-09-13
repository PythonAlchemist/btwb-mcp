# btwb-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js >= 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-server-blue.svg)](https://modelcontextprotocol.io)

An unofficial [MCP](https://modelcontextprotocol.io) server for [Beyond the Whiteboard](https://beyondthewhiteboard.com) (BTWB).

BTWB has no public API. This server calls the same internal JSON/form endpoints the BTWB web app itself uses, found by inspecting its network traffic. It authenticates with a copied browser session cookie rather than a real API key.

**This is unofficial and unsupported by BTWB.** It can break if they change their app, and your session cookie will periodically expire and need refreshing. Use it for personal automation only.

## Disclaimer

This project calls BTWB's internal, undocumented endpoints rather than a published API, using your own logged-in session cookie in place of an API key. It isn't affiliated with, endorsed by, or supported by BTWB, LLC. Using it may be subject to BTWB's own Terms of Service - review those and use this at your own discretion and risk. Provided as-is, with no warranty (see [LICENSE](LICENSE)).

## Tools

- **`search_movement(term)`** - search BTWB's movement library, returns `{id, name, modality, posting_trait}` matches.
- **`log_workout(movementId, movementName, reps, weight, weightUnit, performedDate, notes)`** - logs a single-movement result (e.g. a 1RM). **Always posts with Privacy: Only Me** - this is hardcoded in `src/btwb-client.js` and is not an exposed parameter, on purpose.
- **`log_rounds_workout(workoutId, workoutSlug, memberId, sections, totalTimeSeconds, performedDate, rxd, notes, trackEventId)`** - logs a multi-movement "rounds" result (e.g. a For Time WOD with several movements per round). Only "For Time" / total-time scoring is supported. **Always posts with Privacy: Only Me**, same as `log_workout`.
- **`get_movement_history(memberId, movementId, movementSlug, days)`** - pulls max-over-time history (PR data points with date/reps/weight) for a movement.
- **`get_workout_session(sessionId)`** - fetches details of an already-logged result by its session ID.
- **`delete_workout_session(sessionId)`** - permanently deletes an already-logged result by its session ID. No undo.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Get your session cookie

1. Log into [beyondthewhiteboard.com](https://beyondthewhiteboard.com) in your browser.
2. Open DevTools → Network tab, reload the page.
3. Click any request to `beyondthewhiteboard.com`.
4. Copy the full value of the `Cookie` request header.

This cookie is tied to your login session. If tools start failing with a CSRF/session error, it has expired - repeat these steps for a fresh one.

### 3. Configure the environment variable

```bash
cp .env.example .env
# paste your cookie into .env
```

Or export it directly:

```bash
export BTWB_SESSION_COOKIE="your_cookie_here"
```

### 4. Register with Claude Code

Add to your `.mcp.json` (project-level or global):

```json
{
  "mcpServers": {
    "btwb": {
      "command": "node",
      "args": ["/absolute/path/to/btwb-mcp/src/index.js"],
      "env": {
        "BTWB_SESSION_COOKIE": "your_cookie_here"
      }
    }
  }
}
```

Or via the CLI:

```bash
claude mcp add btwb --env BTWB_SESSION_COOKIE="your_cookie_here" -- node /absolute/path/to/btwb-mcp/src/index.js
```

## Privacy

Every entry this server logs is posted with **Privacy: Only Me**, hardcoded in the client, not passed as a parameter. If you ever need a differently-scoped post, do it by hand in the BTWB app rather than changing this server's default.

## How the endpoints were found

Documented in commit history / session notes: found by watching Network tab traffic in a real logged-in browser session while performing each action (searching a movement, submitting the "Log Result" form, viewing a movement's PR page), then reading the resulting request URLs and the log form's actual field names directly out of the page DOM.

- Search: `GET /exercises/autocomplete_name.json?posting_trait=true&term={term}`
- Log (single movement): `POST /workouts/logger` (form-encoded, CSRF-protected, `workout_session[definition]` JSON)
- Log (multi-movement/rounds): `POST /workouts/{workoutId}-{slug}/workout_sessions` (form-encoded, CSRF-protected, `workout_session[uiobject]` JSON - a different field name and shape than the single-movement flow)
- History: `GET /members/{memberId}/movements/{movementId}-{slug}/vmax?d={seconds}`
- Single session detail: `GET /workout_sessions/{id}` (HTML scrape - no JSON endpoint)
- Delete: `DELETE /workout_sessions/{id}` (CSRF-protected, same endpoint as the app's own "Delete" UJS links)

## Contributing

Bug reports and PRs are welcome - see [CONTRIBUTING.md](CONTRIBUTING.md) for how this project is tested (there's no automated test suite) and what to include in a report.

## Security

Found a security issue (e.g. a way this could leak your session cookie)? See [SECURITY.md](SECURITY.md) for how to report it privately.

## License

[MIT](LICENSE)
