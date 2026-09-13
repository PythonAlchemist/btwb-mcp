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
  getMovementHistory,
  getWorkoutSession,
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
    name: "get_movement_history",
    description:
      "Get max-over-time history for a movement (PR data points with dates/reps/weight). " +
      "Requires the BTWB member ID and the movement's numeric ID plus its URL slug " +
      "(e.g. movementId 35, movementSlug 'deadlift' for beyondthewhiteboard.com/.../35-deadlift).",
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
      case "get_movement_history":
        result = await getMovementHistory(args);
        break;
      case "get_workout_session":
        result = await getWorkoutSession(args.sessionId);
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
