#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  searchMovement,
  logWorkout,
  logRoundsWorkout,
  getMovementHistory,
  getWorkoutSession,
  deleteWorkoutSession,
  refreshSessionCookie,
} from "./btwb-client.js";

const server = new Server(
  { name: "btwb-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: "search_movement",
    description:
      "Search BTWB's movement library by name (e.g. 'Deadlift', 'Squat Clean'). " +
      "Returns matching movements with their numeric IDs, which log_workout and " +
      "get_movement_history both require.",
    inputSchema: {
      type: "object",
      properties: {
        term: {
          type: "string",
          description: "Movement name or partial name to search for",
        },
      },
      required: ["term"],
    },
  },
  {
    name: "log_workout",
    description:
      "Log a single-movement result (e.g. a 1-rep max) to BTWB. Every entry logged " +
      "through this tool is always posted with Privacy: Only Me - this is hardcoded " +
      "and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        movementId: {
          type: "number",
          description: "Movement ID from search_movement",
        },
        movementName: {
          type: "string",
          description: "Movement name, should match the search_movement result",
        },
        reps: { type: "number", description: "Number of reps performed" },
        weight: { type: "number", description: "Weight lifted" },
        weightUnit: {
          type: "string",
          enum: ["lbs", "kg"],
          default: "lbs",
        },
        performedDate: {
          type: "string",
          description: "Date performed, format YYYY-MM-DD",
        },
        notes: {
          type: "string",
          description: "Optional notes for the entry",
        },
      },
      required: ["movementId", "movementName", "reps", "weight", "performedDate"],
    },
  },
  {
    name: "log_rounds_workout",
    description:
      "Log a multi-movement 'rounds' result (e.g. a For Time WOD with several " +
      "movements per round) to BTWB - as opposed to log_workout, which only " +
      "handles a single movement. Only 'For Time' workouts scored by total time " +
      "are supported (other scoring types like AMRAP/total-reps are untested). " +
      "workoutId/workoutSlug come from the workout's URL " +
      "(beyondthewhiteboard.com/workouts/{workoutId}-{workoutSlug}/...). " +
      "Every entry logged through this tool is always posted with Privacy: Only Me - " +
      "this is hardcoded and cannot be overridden.",
    inputSchema: {
      type: "object",
      properties: {
        workoutId: {
          type: "number",
          description: "Numeric workout ID from the workout's URL",
        },
        workoutSlug: {
          type: "string",
          description: "URL slug from the workout's URL, e.g. 'ft-rows-9x-toes-to-bars-power-cleans-and-wall-balls'",
        },
        memberId: {
          type: "number",
          description: "BTWB member/profile ID the result is logged under",
        },
        sections: {
          type: "array",
          description:
            "Ordered list of round groups making up the workout, e.g. a single " +
            "buy-in round followed by N rounds of several movements.",
          items: {
            type: "object",
            properties: {
              rounds: { type: "number", description: "Number of rounds for this section" },
              movements: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    movementName: { type: "string" },
                    movementId: { type: "number", description: "Movement ID from search_movement" },
                    measures: {
                      type: "object",
                      description:
                        "Per-round measures for this movement, keyed by measure type. " +
                        "Each value is {value, unit}. Common keys: reps ({value, unit:'reps'}), " +
                        "weight ({value, unit:'lbs'|'kg'}), distance ({value, unit:'m'|'ft'|...}), " +
                        "height ({value, unit:'ft'|'in'}). Include only the measures that apply " +
                        "to this movement (e.g. a weighted movement gets both reps and weight).",
                    },
                  },
                  required: ["movementName", "movementId", "measures"],
                },
              },
            },
            required: ["rounds", "movements"],
          },
        },
        totalTimeSeconds: {
          type: "number",
          description: "Total elapsed time in seconds (e.g. hit a 36:00 time cap -> 2160)",
        },
        performedDate: {
          type: "string",
          description: "Date performed, format YYYY-MM-DD",
        },
        rxd: {
          type: "boolean",
          description: "true = As Prescribed (Rx'd), false = Modified/scaled",
        },
        notes: {
          type: "string",
          description: "Optional notes for the entry",
        },
        trackEventId: {
          type: "number",
          description:
            "Optional track_event ID to link this result to a scheduled/prescribed " +
            "WOD (from get_workout_session or the workout's tracks page URL).",
        },
      },
      required: ["workoutId", "workoutSlug", "memberId", "sections", "totalTimeSeconds", "performedDate", "rxd"],
    },
  },
  {
    name: "get_movement_history",
    description:
      "Get the full logged history for a movement over a date range - every " +
      "individual set (date, reps, weight), not just PRs - plus a computed " +
      "'Potential Max' trend line. Requires the BTWB member ID and the movement's " +
      "numeric ID plus its URL slug (e.g. movementId 35, movementSlug 'deadlift' " +
      "for beyondthewhiteboard.com/.../35-deadlift).",
    inputSchema: {
      type: "object",
      properties: {
        memberId: { type: "number", description: "BTWB member/profile ID" },
        movementId: { type: "number", description: "Movement ID" },
        movementSlug: {
          type: "string",
          description: "URL slug for the movement, e.g. 'deadlift'",
        },
        days: {
          type: "number",
          default: 365,
          description: "How many days of history to look back",
        },
      },
      required: ["memberId", "movementId", "movementSlug"],
    },
  },
  {
    name: "get_workout_session",
    description:
      "Get the full details of one already-logged BTWB result by its session ID " +
      "(the number in a beyondthewhiteboard.com/workout_sessions/{id} URL): " +
      "workout name, performed date/time, the movements/sets, the result/score, " +
      "and level/WOD-rank stats. There's no search-by-date endpoint yet - you " +
      "need the session ID already (e.g. from a URL, or from log_workout's " +
      "redirectedTo field).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "number",
          description: "The workout_sessions ID",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "delete_workout_session",
    description:
      "Permanently delete an already-logged BTWB result by its session ID. " +
      "This cannot be undone - BTWB has no trash/undo for deleted sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "number",
          description: "The workout_sessions ID to delete",
        },
      },
      required: ["sessionId"],
    },
  },
  {
    name: "refresh_session_cookie",
    description:
      "Manually re-authenticate to BTWB and replace the stored session cookie with a " +
      "fresh one. Every other tool already does this automatically when it detects an " +
      "expired session, so you normally don't need to call this directly - it's mainly " +
      "useful to proactively refresh, or to test that BTWB_EMAIL and the Keychain-stored " +
      "password are set up correctly. Requires BTWB_EMAIL and a password stored in " +
      "Keychain (service: btwb-password) - see README \"Automatic cookie refresh\".",
    inputSchema: { type: "object", properties: {} },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let result;
    switch (name) {
      case "search_movement":
        result = await searchMovement(args.term);
        break;
      case "log_workout":
        result = await logWorkout(args);
        break;
      case "log_rounds_workout":
        result = await logRoundsWorkout(args);
        break;
      case "get_movement_history":
        result = await getMovementHistory(args);
        break;
      case "get_workout_session":
        result = await getWorkoutSession(args.sessionId);
        break;
      case "delete_workout_session":
        result = await deleteWorkoutSession(args.sessionId);
        break;
      case "refresh_session_cookie":
        result = await refreshSessionCookie();
        break;
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
