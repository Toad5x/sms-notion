export interface Env {
  ANTHROPIC_API_KEY?: string;
  TWILIO_ACCOUNT_SID: string;
  TWILIO_AUTH_TOKEN: string;
  TWILIO_NUMBER: string;
  ALLOWED_NUMBER: string;
  NOTION_TOKEN: string;
  TODOS_DS: string;
  REMINDERS_DS: string;
  TZ: string;
  MODEL: string;
  HISTORY?: KVNamespace;
}

// ---------- Twilio ----------

async function validTwilioSignature(req: Request, params: URLSearchParams, token: string): Promise<boolean> {
  const sig = req.headers.get("X-Twilio-Signature");
  if (!sig) return false;
  const keys = [...new Set(params.keys())].sort();
  let data = req.url;
  for (const k of keys) data += k + params.get(k);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
  return expected === sig;
}

async function sendSms(env: Env, body: string): Promise<void> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: env.ALLOWED_NUMBER, From: env.TWILIO_NUMBER, Body: body.slice(0, 1500) }),
  });
  if (!res.ok) console.error("twilio send failed", res.status, await res.text());
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const twiml = (msg?: string) =>
  new Response(msg ? `<Response><Message>${xmlEscape(msg)}</Message></Response>` : "<Response/>", {
    headers: { "Content-Type": "text/xml" },
  });

// ---------- Notion ----------

const NOTION_HEADERS = (env: Env) => ({
  Authorization: `Bearer ${env.NOTION_TOKEN}`,
  "Notion-Version": "2025-09-03",
  "Content-Type": "application/json",
});

async function notion(env: Env, path: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    method: path.startsWith("/pages/") ? "PATCH" : "POST",
    headers: NOTION_HEADERS(env),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Notion ${res.status}: ${await res.text()}`);
  return res.json();
}

async function addTodo(env: Env, text: string) {
  await notion(env, "/pages", {
    parent: { type: "data_source_id", data_source_id: env.TODOS_DS },
    properties: {
      Task: { title: [{ text: { content: text } }] },
      Status: { status: { name: "Not started" } },
      Area: { select: { name: "Personal" } },
    },
  });
}

async function addReminder(env: Env, text: string, dueUtc: Date) {
  await notion(env, "/pages", {
    parent: { type: "data_source_id", data_source_id: env.REMINDERS_DS },
    properties: {
      Name: { title: [{ text: { content: text } }] },
      Due: { date: { start: dueUtc.toISOString() } },
    },
  });
}

// ---------- Time helpers ----------

function tzParts(date: Date, tz: string) {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric",
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute };
}

function tzOffsetMs(date: Date, tz: string) {
  const p = tzParts(date, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) - Math.floor(date.getTime() / 60000) * 60000;
}

function zonedToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz); // re-check across DST boundaries
  return new Date(t);
}

const fmtLocal = (d: Date, tz: string) =>
  d.toLocaleString("en-US", { timeZone: tz, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Parses "in 30m", "in 2h", "3pm", "3:30pm", "15:00", "1530", optionally prefixed by "tomorrow". Returns null if unsure. */
export function parseWhen(spec: string, now: Date, tz: string): Date | null {
  // Military time without a colon: "1530", "0900", "1530h" -> "15:30"
  const s = spec.trim().toLowerCase().replace(/^(tomorrow\s+)?(\d{2})(\d{2})h?$/, "$1$2:$3");
  let m = s.match(/^in (\d+)\s*(m|min|mins|h|hr|hrs|d)$/);
  if (m) {
    const n = +m[1];
    const ms = m[2].startsWith("m") ? 60_000 : m[2] === "d" ? 86_400_000 : 3_600_000;
    return new Date(now.getTime() + n * ms);
  }
  m = s.match(/^(tomorrow\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = +m[2];
  const mi = m[3] ? +m[3] : 0;
  if (m[4] === "pm" && h < 12) h += 12;
  if (m[4] === "am" && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  const p = tzParts(now, tz);
  let when = zonedToUtc(p.y, p.mo, p.d, h, mi, tz);
  if (m[1]) when = new Date(when.getTime() + 86_400_000);
  else if (when <= now) when = new Date(when.getTime() + 86_400_000);
  return when;
}

// ---------- Fast path (no Claude) ----------

async function fastPath(env: Env, text: string): Promise<string | null> {
  let m = text.match(/^(?:todo|t)[:\s]+(.+)$/is);
  if (m) {
    await addTodo(env, m[1].trim());
    return `Todo added: ${m[1].trim()}`;
  }
  // "r 3pm call dentist" / "r tomorrow 9am call dentist" / "r in 30m check oven"
  m = text.match(/^(?:remind|r)[:\s]+((?:tomorrow\s+)?(?:in\s+\d+\s*\w+|\d{4}h?|\d{1,2}(?::\d{2})?\s*(?:am|pm)?))\s+(.+)$/is);
  if (m) {
    const when = parseWhen(m[1], new Date(), env.TZ);
    if (when) {
      await addReminder(env, m[2].trim(), when);
      return `Reminder set: ${m[2].trim()}, ${fmtLocal(when, env.TZ)}`;
    }
  }
  return null;
}

// ---------- Claude path ----------

const TOOLS = [
  {
    name: "add_todo",
    description: "Add an item to the user's todo list in Notion.",
    input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "set_reminder",
    description: "Schedule a text-message reminder. The user will be texted at the due time.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remind the user about" },
        due_local: { type: "string", description: "Local wall-clock time as YYYY-MM-DDTHH:MM in the user's timezone" },
      },
      required: ["text", "due_local"],
    },
  },
];

async function runClaude(env: Env, userText: string): Promise<string> {
  const now = new Date();
  const system =
    `You are a terse SMS assistant for one user who texts from a basic phone. ` +
    `Current time: ${fmtLocal(now, env.TZ)} (${env.TZ}), today is ${new Date(now).toLocaleDateString("en-CA", { timeZone: env.TZ })}. ` +
    `Use add_todo for tasks and set_reminder for anything time-based. Resolve relative times yourself. ` +
    `Reply in plain text under 300 characters, no markdown or emoji. Confirm what you did in one short line. ` +
    `If a time is ambiguous, ask one short question.`;

  const histKey = "hist";
  let messages: any[] = [];
  if (env.HISTORY) messages = JSON.parse((await env.HISTORY.get(histKey)) ?? "[]");
  messages.push({ role: "user", content: userText });

  let reply = "";
  for (let i = 0; i < 4; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": env.ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: env.MODEL, max_tokens: 400, system, tools: TOOLS, messages }),
    });
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
    const data: any = await res.json();
    messages.push({ role: "assistant", content: data.content });
    reply = data.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ").trim();
    if (data.stop_reason !== "tool_use") break;

    const results = [];
    for (const b of data.content.filter((b: any) => b.type === "tool_use")) {
      try {
        if (b.name === "add_todo") {
          await addTodo(env, b.input.text);
          results.push({ type: "tool_result", tool_use_id: b.id, content: "ok" });
        } else if (b.name === "set_reminder") {
          const mm = String(b.input.due_local).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
          if (!mm) throw new Error("bad due_local format");
          const due = zonedToUtc(+mm[1], +mm[2], +mm[3], +mm[4], +mm[5], env.TZ);
          await addReminder(env, b.input.text, due);
          results.push({ type: "tool_result", tool_use_id: b.id, content: `ok, due ${fmtLocal(due, env.TZ)}` });
        }
      } catch (e) {
        results.push({ type: "tool_result", tool_use_id: b.id, content: String(e), is_error: true });
      }
    }
    messages.push({ role: "user", content: results });
  }

  if (env.HISTORY) await env.HISTORY.put(histKey, JSON.stringify(messages.slice(-8)), { expirationTtl: 3600 });
  return reply || "Done.";
}

// ---------- Entry points ----------

const HELP =
  "Commands: 'todo <text>', 'r <time> <text>' (r 3pm call mom, r tomorrow 9am rent, r in 30m oven). Free-form text needs an API key.";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (req.method !== "POST") return new Response("ok");
    const params = new URLSearchParams(await req.text());
    if (!(await validTwilioSignature(req, params, env.TWILIO_AUTH_TOKEN))) return new Response("forbidden", { status: 403 });
    if (params.get("From") !== env.ALLOWED_NUMBER) return twiml(); // silently ignore strangers

    const body = (params.get("Body") ?? "").trim();
    if (!body) return twiml();

    try {
      const quick = await fastPath(env, body);
      if (quick) return twiml(quick);
    } catch (e) {
      console.error(e);
      return twiml("Notion error, try again.");
    }

    if (!env.ANTHROPIC_API_KEY) return twiml(HELP);

    // Slow path: answer Twilio immediately, text the result when Claude finishes.
    ctx.waitUntil(
      runClaude(env, body)
        .then((r) => sendSms(env, r))
        .catch((e) => { console.error(e); return sendSms(env, "Error, try again."); }),
    );
    return twiml();
  },

  async scheduled(_evt: ScheduledController, env: Env): Promise<void> {
    const q = await notion(env, `/data_sources/${env.REMINDERS_DS}/query`, {
      filter: {
        and: [
          { property: "Sent", checkbox: { equals: false } },
          { property: "Due", date: { on_or_before: new Date().toISOString() } },
        ],
      },
      page_size: 20,
    });
    for (const page of q.results) {
      const title = page.properties.Name.title.map((t: any) => t.plain_text).join("");
      await sendSms(env, `Reminder: ${title}`);
      await notion(env, `/pages/${page.id}`, { properties: { Sent: { checkbox: true } } });
    }
  },
};
