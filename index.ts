#!/usr/bin/env bun
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";

// ── Config ────────────────────────────────────────────────────────────────────

const VERSION  = "1.0.0";
const API_URL  = "https://cipherend.vercel.app/api/chat";
const DEFAULT_USERNAME = "dimitris";
const MODELS   = ["cipher-1", "cipher-2", "cipher-3", "cipher-nano", "cipher-pro"];
const EFFORTS  = ["low", "medium", "high"];

const CMDS = [
  { name: "/clear",       desc: "Clear the conversation history" },
  { name: "/effort",      desc: "Set effort level" },
  { name: "/exit",        desc: "Exit the CLI" },
  { name: "/help",        desc: "Show all available commands" },
  { name: "/memory",      desc: "Save or list memories" },
  { name: "/model",       desc: "Switch the AI model" },
  { name: "/new",        desc: "Start a new session" },
  { name: "/profile",     desc: "View your profile or profile path" },
  { name: "/sessions",   desc: "List all sessions" },
  { name: "/settings",   desc: "Open settings" },
];

const O  = "\x1b[38;5;208m";  // orange
const B  = "\x1b[1;37m";      // bold white
const D  = "\x1b[2m";         // dim
const GR = "\x1b[38;5;240m";  // grey
const G  = "\x1b[38;5;82m";   // green
const R  = "\x1b[0m";         // reset
const SPIN = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"];

// ── State ─────────────────────────────────────────────────────────────────────

let currentModel   = "cipher-pro";
let currentEffort  = "low";
let showThinking   = false;
let showTools      = false;
let allowMemoryTool = true;
let conversation: { role: string; content: string }[] = [];
let abortCtrl: AbortController | null = null;

// ── Profile / Memory ──────────────────────────────────────────────────────────

const HOME                = process.env.HOME ?? "";
const CIPHER_DIR          = path.join(HOME, ".cipher");
const USERS_DIR           = path.join(CIPHER_DIR, "users");
const ACTIVE_USER_PATH    = path.join(CIPHER_DIR, "active-user.json");
const LEGACY_PROFILE_PATH = path.join(CIPHER_DIR, "profile.md");
const LEGACY_MEMORIES_DIR = path.join(CIPHER_DIR, "memories");
const PROFILE_FILENAME    = "profile.md";

type UserPaths = {
  slug: string;
  root: string;
  profile: string;
  memories: string;
};

type OnboardingProfile = {
  name: string;
  job: string;
  country: string;
  timezone: string;
  language: string;
  goals: string;
  preferences: string;
};

type SSEEvent =
  | { kind: "skip" | "done"; data: string }
  | { kind: "tool_step"; data: string; name?: string; args?: Record<string, unknown>; result?: string }
  | { kind: "thinking" | "text"; data: string };

// ── Sessions Management ────────────────────────────────────────────────────

const SESSIONS_FILE = "sessions.md";

type SessionEntry = {
  id: string;
  startTime: string;
  endTime: string;
  messages: number;
  model: string;
};

let currentSessionId: string | null = null;
let sessionStartTime: string | null = null;
let sessionMessageCount = 0;
let sessionToolUses: string[] = [];

function clearTerminal() {
  process.stdout.write("\x1b[2J\x1b[0f");
}

function generateSessionId(): string {
  const chars = "0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function sessionsDir(): string {
  return path.join(CIPHER_DIR, "sessions");
}

function sessionsFilePath(): string {
  return path.join(sessionsDir(), SESSIONS_FILE);
}

function currentSessionFilePath(): string {
  return path.join(sessionsDir(), `${currentSessionId}.md`);
}

function loadSessions(): SessionEntry[] {
  const filePath = sessionsFilePath();
  const content = safeRead(filePath);
  if (!content) return [];

  const sessions: SessionEntry[] = [];
  const entries = content.split(/^## /m).filter(Boolean);

  for (const entry of entries) {
    const lines = entry.split("\n");
    const idMatch = lines[0]?.match(/^Session (\d{6}):/);
    const id = idMatch?.[1] || "";

    const startMatch = entry.match(/\*\*Started:\*\* (.+)/);
    const endMatch = entry.match(/\*\*Ended:\*\* (.+)/);
    const msgsMatch = entry.match(/\*\*Messages:\*\* (\d+)/);
    const modelMatch = entry.match(/\*\*Model:\*\* (.+)/);

    if (id) {
      sessions.push({
        id,
        startTime: startMatch?.[1] || "",
        endTime: endMatch?.[1] || "",
        messages: parseInt(msgsMatch?.[1] || "0", 10),
        model: modelMatch?.[1] || "",
      });
    }
  }

  return sessions;
}

function createSession(): string {
  currentSessionId = generateSessionId();
  sessionStartTime = new Date().toISOString();
  sessionMessageCount = 0;
  sessionToolUses = [];

  const sessionDir = sessionsDir();
  fs.mkdirSync(sessionDir, { recursive: true });

  const sessionFile = currentSessionFilePath();
  const header = `# Session ${currentSessionId}

**Started:** ${sessionStartTime}
**Model:** ${currentModel}
**Status:** active

---

`;
  fs.writeFileSync(sessionFile, header, "utf8");

  updateSessionsFile();

  return currentSessionId;
}

function loadSessionMessages(): { role: string; content: string }[] {
  if (!currentSessionId) return [];

  const sessionFile = currentSessionFilePath();
  const content = safeRead(sessionFile);
  if (!content) return [];

  const messages: { role: string; content: string }[] = [];
  const sections = content.split(/^### /m);

  for (const section of sections) {
    const lines = section.split("\n");
    const header = lines[0]?.trim().toLowerCase();
    const body = lines.slice(1).join("\n").trim();

    if (header === "user" && body) {
      messages.push({ role: "user", content: body });
    } else if (header === "assistant" && body) {
      messages.push({ role: "assistant", content: body });
    }
  }

  return messages;
}

function renderSessionChat() {
  const messages = loadSessionMessages();
  if (messages.length === 0) return;

  const title = `${B}Session ${currentSessionId}${R}`;
  wrl(title);
  wrl(`${GR}Messages loaded: ${messages.length}${R}\n`);

  for (const msg of messages) {
    if (msg.role === "user") {
      wrl(`${D}❯${R} ${renderMarkdown(msg.content)}`);
    } else {
      wrl(`${O}⏺${R} ${renderMarkdown(msg.content)}`);
    }
    wrl();
  }
}

function renderMarkdown(text: string): string {
  let out = text;

  out = out.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    return `${D}\`\`\`\`${lang || ""}\n${code.trim()}\`\`\`${R}`;
  });

  out = out.replace(/`([^`]+)`/g, `${D}$1${R}`);

  out = out.replace(/^### (.+)$/gm, `${B}$1${R}`);
  out = out.replace(/^## (.+)$/gm, `${B}$1${R}`);
  out = out.replace(/^# (.+)$/gm, `${B}$1${R}`);

  out = out.replace(/\*\*([^*]+)\*\*/g, `${B}$1${R}`);
  out = out.replace(/\*([^*]+)\*/g, `${D}$1${R}`);

  out = out.replace(/^\- (.+)$/gm, `${GR}•${R} $1`);

  out = out.replace(/\[([^\]]+)\]\([^)]+\)/g, (m: string, text: string, url: string) => `${O}${text}${R}`);

  return out;
}

function endSession() {
  if (!currentSessionId || !sessionStartTime) return;

  const endTime = new Date().toISOString();
  const sessionFile = currentSessionFilePath();

  let content = safeRead(sessionFile) || "";
  content += `\n---\n**Ended:** ${endTime}\n**Messages:** ${sessionMessageCount}\n`;

  if (sessionToolUses.length > 0) {
    content += `\n## Tool Uses\n`;
    for (const tool of sessionToolUses) {
      content += `- ${tool}\n`;
    }
  }

  fs.writeFileSync(sessionFile, content, "utf8");
  updateSessionsFile();

  currentSessionId = null;
  sessionStartTime = null;
  sessionMessageCount = 0;
  sessionToolUses = [];
}

function appendToSession(content: string) {
  if (!currentSessionId) return;
  const sessionFile = currentSessionFilePath();
  const existing = safeRead(sessionFile) || "";
  fs.writeFileSync(sessionFile, existing + content + "\n", "utf8");
}

function updateSessionsFile() {
  const sessionDir = sessionsDir();
  if (!fs.existsSync(sessionDir)) return;

  const files = fs.readdirSync(sessionDir).filter(f => f.endsWith(".md") && !f.startsWith("sessions"));
  const sessions: SessionEntry[] = [];

  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const content = safeRead(filePath);
    if (!content) continue;

    const idMatch = file.match(/^(\d{6})\.md$/);
    const id = idMatch?.[1] || "";

    const startMatch = content.match(/\*\*Started:\*\* (.+)/);
    const endMatch = content.match(/\*\*Ended:\*\* (.+)/);
    const msgsMatch = content.match(/\*\*Messages:\*\* (\d+)/);
    const modelMatch = content.match(/\*\*Model:\*\* (.+)/);

    sessions.push({
      id,
      startTime: startMatch?.[1] || "",
      endTime: endMatch?.[1] || "",
      messages: parseInt(msgsMatch?.[1] || "0", 10),
      model: modelMatch?.[1] || "",
    });
  }

  sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));

  let md = "# Sessions\n\n";
  md += "| ID | Started | Ended | Messages | Model |\n";
  md += "|----|---------|-------|----------|-------|\n";

  for (const s of sessions) {
    const started = s.startTime ? s.startTime.split("T")[0] + " " + s.startTime.split("T")[1]?.slice(0, 5) : "-";
    const ended = s.endTime ? s.endTime.split("T")[0] + " " + s.endTime.split("T")[1]?.slice(0, 5) : "active";
    md += `| ${s.id} | ${started} | ${ended} | ${s.messages} | ${s.model} |\n`;
  }

  md += "\n";

  if (currentSessionId) {
    md += `**Current Session:** ${currentSessionId}\n`;
  }

  fs.writeFileSync(sessionsFilePath(), md, "utf8");
}

function recordToolUse(toolName: string) {
  if (!currentSessionId) return;
  sessionToolUses.push(toolName);
  appendToSession(`### Tool: ${toolName}\n`);
}

function recordCodeBlock(code: string, language?: string) {
  if (!currentSessionId) return;
  const lang = language || "text";
  appendToSession(`\`\`\`${lang}\n${code}\n\`\`\`\n`);
}

const SAVE_MEMORY_TOOL = {
  type: "function",
  function: {
    name: "save_memory",
    description:
      "Save a durable fact, preference, project detail, or explicit 'remember this' request to the active user's local Cipher memory folder. Do not save secrets, credentials, payment details, or short-lived one-off details.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "One concise memory to save for future conversations.",
        },
      },
      required: ["content"],
    },
  },
} as const;

function shortPath(filePath: string): string {
  return HOME && filePath.startsWith(HOME) ? "~" + filePath.slice(HOME.length) : filePath;
}

function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "user";
}

function safeRead(filePath: string): string | null {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function userPaths(slug: string): UserPaths {
  const root = path.join(USERS_DIR, slug);
  return {
    slug,
    root,
    profile: path.join(root, PROFILE_FILENAME),
    memories: path.join(root, "memories"),
  };
}

function readActiveUserSlug(): string | null {
  const raw = safeRead(ACTIVE_USER_PATH);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed.slug === "string" && parsed.slug.trim()) return parsed.slug.trim();
    } catch {
      // Ignore a broken active-user file and fall back to discovery.
    }
  }

  if (!fs.existsSync(USERS_DIR)) return null;
  const dirs = fs.readdirSync(USERS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .filter(slug => fs.existsSync(userPaths(slug).profile))
    .sort();
  return dirs[0] ?? null;
}

function writeActiveUser(slug: string) {
  fs.mkdirSync(CIPHER_DIR, { recursive: true });
  fs.writeFileSync(ACTIVE_USER_PATH, JSON.stringify({ slug }, null, 2) + "\n", "utf8");
}

function extractProfileName(markdown: string | null): string | null {
  if (!markdown) return null;
  const bullet = markdown.match(/^- Name:\s*(.+)$/im);
  if (bullet?.[1]?.trim()) return bullet[1].trim();
  const bold = markdown.match(/\*\*Name:\*\*\s*(.+)/i);
  if (bold?.[1]?.trim()) return bold[1].trim();
  return null;
}

function ensureCipherDirs() {
  fs.mkdirSync(CIPHER_DIR, { recursive: true });
  fs.mkdirSync(USERS_DIR, { recursive: true });

  const activeSlug = readActiveUserSlug() ?? slugify(DEFAULT_USERNAME);
  const paths = userPaths(activeSlug);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.memories, { recursive: true });
}

function activeUserPaths(): UserPaths {
  migrateLegacyProfileIfNeeded();
  const slug = readActiveUserSlug() ?? slugify(DEFAULT_USERNAME);
  const paths = userPaths(slug);
  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.memories, { recursive: true });
  return paths;
}

function migrateLegacyProfileIfNeeded() {
  if (readActiveUserSlug()) return;
  if (!fs.existsSync(LEGACY_PROFILE_PATH)) return;

  fs.mkdirSync(USERS_DIR, { recursive: true });
  const legacyProfile = fs.readFileSync(LEGACY_PROFILE_PATH, "utf8");
  const name = extractProfileName(legacyProfile) ?? DEFAULT_USERNAME;
  const slug = slugify(name);
  const paths = userPaths(slug);
  fs.mkdirSync(paths.memories, { recursive: true });

  if (!fs.existsSync(paths.profile)) {
    fs.writeFileSync(paths.profile, legacyProfile, "utf8");
  }

  if (fs.existsSync(LEGACY_MEMORIES_DIR)) {
    const files = fs.readdirSync(LEGACY_MEMORIES_DIR).filter(f => f.endsWith(".md"));
    for (const file of files) {
      const from = path.join(LEGACY_MEMORIES_DIR, file);
      const to = path.join(paths.memories, file);
      if (!fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  }

  writeActiveUser(slug);
}

function activeProfileMarkdown(): string | null {
  const paths = activeUserPaths();
  return safeRead(paths.profile);
}

function activeProfileName(): string {
  return extractProfileName(activeProfileMarkdown()) ?? DEFAULT_USERNAME;
}

function renderProfileMarkdown(profile: OnboardingProfile, createdAt: string): string {
  const line = (value: string, fallback = "Not specified") => value.trim() || fallback;
  const block = (value: string) => value.trim() || "Not specified";

  return `# User Profile

## Basic Info
- Name: ${line(profile.name, DEFAULT_USERNAME)}
- Job: ${line(profile.job)}
- Country: ${line(profile.country)}
- Timezone: ${line(profile.timezone)}
- Preferred language: ${line(profile.language)}

## Goals
${block(profile.goals)}

## AI Preferences
${block(profile.preferences)}

## Memory Policy
- Save durable facts, preferences, project context, and explicit remember-this requests in this user's memories folder.
- Do not save secrets, passwords, API keys, payment details, or short-lived one-off details.

---
Created: ${createdAt}
Updated: ${createdAt}
`;
}

function createUserProfile(profile: OnboardingProfile): UserPaths {
  const slug = slugify(profile.name || DEFAULT_USERNAME);
  const paths = userPaths(slug);
  const createdAt = new Date().toISOString();

  fs.mkdirSync(paths.memories, { recursive: true });
  fs.writeFileSync(paths.profile, renderProfileMarkdown(profile, createdAt), "utf8");
  writeActiveUser(slug);

  return paths;
}

function loadSystemPrompt(): string {
  migrateLegacyProfileIfNeeded();
  let parts: string[] = [];
  const paths = activeUserPaths();
  const profile = safeRead(paths.profile);

  if (allowMemoryTool) {
    parts.push(`## Local Profile and Memory
Use the user's profile and saved memories as durable context. When the user explicitly asks you to remember something, or shares a stable preference or important long-lived fact, call the save_memory tool with one concise memory. Never mention SAVE_MEMORY directives to the user.`);
  } else {
    parts.push(`## Local Profile and Memory
Use the user's profile and saved memories as durable context. Local memory writes are currently disabled, so do not call save_memory or try to persist new memories.`);
  }

  if (profile) {
    parts.push(`## User Profile\n${profile}`);
  }

  if (fs.existsSync(paths.memories)) {
    const files = fs.readdirSync(paths.memories).filter(f => f.endsWith(".md")).sort();
    if (files.length > 0) {
      const memParts = files.map(f => {
        const content = fs.readFileSync(path.join(paths.memories, f), "utf8");
        return `### ${f}\n${content}`;
      });
      parts.push(`## Memories\n${memParts.join("\n\n")}`);
    }
  }

  return parts.join("\n\n");
}

function saveMemory(content: string): string {
  const normalized = content.trim();
  if (!normalized) return "";

  const paths = activeUserPaths();
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const datePart = `${now.getFullYear()}-${pad2(now.getMonth()+1)}-${pad2(now.getDate())}`;
  const timePart = `${pad2(now.getHours())}-${pad2(now.getMinutes())}-${pad2(now.getSeconds())}`;
  let filename = `${datePart}_${timePart}.md`;
  let filePath = path.join(paths.memories, filename);
  let suffix = 2;
  while (fs.existsSync(filePath)) {
    filename = `${datePart}_${timePart}_${suffix}.md`;
    filePath = path.join(paths.memories, filename);
    suffix++;
  }
  const md = `# Memory - ${datePart} ${timePart.replace(/-/g, ":")}

Created: ${now.toISOString()}

${normalized}
`;
  fs.writeFileSync(filePath, md, "utf8");
  return filePath;
}

function consumeMemoryDirectives(text: string): string {
  return text.replace(/SAVE_MEMORY:\s*([^\n]+)/g, (_match, content: string) => {
    saveMemory(content);
    return "";
  });
}

function maybeSaveToolMemory(event: Extract<SSEEvent, { kind: "tool_step" }>): string | null {
  const argsContent = typeof event.args?.content === "string" ? event.args.content.trim() : "";
  const resultContent = event.result?.startsWith("SAVE_MEMORY:")
    ? event.result.slice("SAVE_MEMORY:".length).trim()
    : "";
  const content = argsContent || resultContent;
  if (event.name !== "save_memory" || !content) return null;
  return saveMemory(content);
}

function requestTools(): unknown[] {
  const tools: unknown[] = ["websearch", "webfetch"];
  if (allowMemoryTool) tools.push(SAVE_MEMORY_TOOL);
  return tools;
}

// ── Onboarding ────────────────────────────────────────────────────────────────

async function runOnboarding(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const ask = (q: string): Promise<string> =>
    new Promise(resolve => rl.question(q, ans => resolve(ans.trim())));

  process.stdout.write("\n");
  process.stdout.write(`${O}╭──────────────────────────────────────────╮${R}\n`);
  process.stdout.write(`${O}│${R}${B}  Welcome to Cipher!  Let's set you up.   ${R}${O}│${R}\n`);
  process.stdout.write(`${O}╰──────────────────────────────────────────╯${R}\n\n`);

  const defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Not specified";
  const name        = await ask(`  What's your name?                 ${O}>${R} `) || DEFAULT_USERNAME;
  const job         = await ask(`  What do you do?                   ${O}>${R} `);
  const country     = await ask(`  Country or home base?             ${O}>${R} `);
  const language    = await ask(`  Preferred language?               ${O}>${R} `);
  const goals       = await ask(`  What are you using Cipher for?    ${O}>${R} `);
  const preferences = await ask(`  Any AI style/preferences?         ${O}>${R} `);

  rl.close();

  const paths = createUserProfile({
    name,
    job,
    country,
    timezone: defaultTimezone,
    language,
    goals,
    preferences,
  });

  process.stdout.write("\n");
  process.stdout.write(`  ${G}✓${R} Profile saved to ${shortPath(paths.profile)}\n`);
  process.stdout.write(`  ${G}✓${R} Memory folder ready at ${shortPath(paths.memories)}/\n\n`);
  process.stdout.write(`  Let's go, ${O}${name}${R}!\n\n`);
}

// ── Terminal helpers ──────────────────────────────────────────────────────────

const tw  = () => process.stdout.columns || 100;
const wr  = (s: string) => process.stdout.write(s);
const wrl = (s = "") => process.stdout.write(s + "\n");
const vis = (s: string) => s.replace(/\x1b\[[^m]*m/g, "");
const vl  = (s: string) => vis(s).length;
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - vl(s)));

function center(s: string, w: number) {
  const p = Math.max(0, w - vl(s)), l = Math.floor(p / 2);
  return " ".repeat(l) + s + " ".repeat(p - l);
}
function workingDir() {
  const cwd = process.cwd(), home = process.env.HOME ?? "";
  return home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

// ── Banner ────────────────────────────────────────────────────────────────────

const ROBOT = [
  " ╔═══════════╗ ", " ║  ◉     ◉  ║ ", " ║   ·───·   ║ ",
  " ╠═══════════╣ ", " ║  CIPHER   ║ ", " ╚══╤═════╤══╝ ", "    │     │    ",
];

function drawBanner() {
  const W = tw(), lw = 42, rw = W - 2 - lw - 1;
  const title = ` Cipher CLI v${VERSION} `;
  const username = activeProfileName();
  const pre = Math.floor((lw - title.length) / 2), post = lw - title.length - pre;
  wrl(`${O}╭${"─".repeat(pre)}${B}${title}${R}${O}${"─".repeat(post)}┬${"─".repeat(rw)}╮${R}`);
  const left = ["", `${B}Welcome back ${O}${username}${B}!${R}`, "",
    ...ROBOT.map(l => `${O}${l}${R}`), "",
    `${O}${currentModel}${R} · ${D}Free · ${username}${R}`, `${D}${workingDir()}${R}`, ""];
  const th = showThinking ? `${G}on${R}` : `${R}off${R}`;
  const tl = showTools ? `${G}on${R}` : `${R}off${R}`;
  const pm = allowMemoryTool ? `${G}on${R}` : `${R}off${R}`;
  const right = ["", `${B}Tips for getting started${R}`,
    `${D}Run /help to see all commands${R}`,
    `${D}${"─".repeat(rw - 2)}${R}`, `${B}Settings${R}`,
    `${D}thinking: ${th}${R}`,
    `${D}tools: ${tl}${R}`,
    `${D}memory: ${pm}${R}`,
    `${D}/settings for options${R}`, ""];
  const rows = Math.max(left.length, right.length);
  while (left.length < rows) left.push("");
  while (right.length < rows) right.push("");
  for (let i = 0; i < rows; i++)
    wrl(`${O}│${R}${center(left[i] ?? "", lw)}${O}│${R}${pad(right[i] ?? "", rw)}${O}│${R}`);
  wrl(`${O}╰${"─".repeat(lw)}┴${"─".repeat(rw)}╯${R}`);
}

// ── Spinner ───────────────────────────────────────────────────────────────────

function startSpinner(): () => void {
  let i = 0, stopped = false;
  wr(`${D}${SPIN[0]} thinking…${R}`);
  const t = setInterval(() => {
    if (stopped) return;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    wr(`${D}${SPIN[i % SPIN.length]} thinking…${R}`);
    i++;
  }, 80);
  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(t);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

// ── SSE parse ─────────────────────────────────────────────────────────────────

function parseSSE(line: string): SSEEvent {
  if (!line.startsWith("data: ")) return { kind: "skip", data: "" };
  const raw = line.slice(6).trim();
  if (raw === "[DONE]") return { kind: "done", data: "" };
  let o: any;
  try { o = JSON.parse(raw); } catch { return { kind: "skip", data: "" }; }

  if (o.cipher_step) {
    if (o.cipher_step === "tool") {
      const name = typeof o.name === "string" ? o.name : "tool";
      const args = asRecord(o.args);
      const result = typeof o.result === "string" ? o.result : "";
      return { kind: "tool_step", data: name, name, args, result };
    }
    return { kind: "tool_step", data: o.cipher_step + (o.query ? `: ${o.query}` : "") };
  }

  const delta = o.choices?.[0]?.delta;
  if (!delta) return { kind: "skip", data: "" };

  if (delta.reasoning) return { kind: "thinking", data: delta.reasoning };
  if (delta.content)   return { kind: "text",     data: delta.content };

  return { kind: "skip", data: "" };
}

// ── Send message ──────────────────────────────────────────────────────────────

async function sendMessage(userText: string) {
  wrl(`${D}❯${R} ${userText}`);
  wrl();

  conversation.push({ role: "user", content: userText });
  sessionMessageCount++;
  appendToSession(`\n### User\n\n${userText}\n`);

  abortCtrl = new AbortController();
  const t0 = Date.now();

  let full = "", thinking = "";
  let textStarted = false;

  const stopSpinner = startSpinner();

  const systemPrompt = loadSystemPrompt();

  try {
    const bodyObj: Record<string, unknown> = {
      model: currentModel,
      messages: conversation,
      stream: true,
      tools: requestTools(),
      temperature: 0.7,
    };
    if (systemPrompt) bodyObj.system_prompt = systemPrompt;

    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(bodyObj),
      signal: abortCtrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let sbuf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sbuf += dec.decode(value, { stream: true });
      const lines = sbuf.split("\n"); sbuf = lines.pop() ?? "";

      for (const line of lines) {
        const event = parseSSE(line.trim());
        if (event.kind === "done") break;
        if (event.kind === "skip") continue;

        stopSpinner();

        if (event.kind === "tool_step") {
          const savedPath = maybeSaveToolMemory(event);
          const label = savedPath ? `save_memory: saved to ${shortPath(savedPath)}` : event.data;
          recordToolUse(event.name || event.data);
          if (showTools) wr(`${D}⚙ ${label}${R}\n`);

        } else if (event.kind === "thinking") {
          thinking += event.data;

        } else if (event.kind === "text") {
          if (!textStarted) {
            if (thinking && showThinking) wr(`${GR}${thinking.trim()}${R}\n\n`);
            wr(`${O}⏺${R} `);
            textStarted = true;
          }

          const cleaned = consumeMemoryDirectives(event.data);
          if (cleaned) { wr(renderMarkdown(cleaned)); full += cleaned; }
        }
      }
    }
  } catch (err: any) {
    stopSpinner();
    if (err?.name === "AbortError") { wr(`\n\n${D}✻ Interrupted${R}\n\n`); return; }
    wr(`\n${O}Error:${R} ${(err as Error)?.message ?? err}\n\n`); return;
  }

  stopSpinner();
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  wr(`\n\n${D}✻ Cooked for ${elapsed}s${R}\n\n`);
  if (full) {
    conversation.push({ role: "assistant", content: full });
    appendToSession(`\n### Assistant\n\n${full}\n`);
  }
  abortCtrl = null;
}

// ── Generic inline picker ─────────────────────────────────────────────────────

function runPicker<T extends { label: string; value: string; hint?: string }>(
  items: T[],
  title: string,
  currentVal: string,
  onDone: (val: string | null) => void
) {
  const W = tw();
  let sel = Math.max(0, items.findIndex(i => i.value === currentVal));
  let pickerLines = 0;

  function draw() {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);

    wr(`${D}${title}  ${GR}↑↓ navigate · Enter select · Esc cancel${R}`);

    for (let i = 0; i < items.length; i++) {
      const item   = items[i];
      if (!item) continue;
      const active = i === sel;
      const prefix = active ? `${O}❯${R} ` : "  ";
      const label  = active ? `${B}${item.label}${R}` : `${R}${item.label}${R}`;
      const hint   = item.hint ? `  ${D}${item.hint}${R}` : "";
      wr("\n" + prefix + label + hint);
    }

    pickerLines = items.length;
    readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
  }

  function close(val: string | null) {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdin.removeListener("keypress", onKey);
    onDone(val);
  }

  function onKey(_char: string | undefined, key: any) {
    if (!key) return;
    if (key.ctrl && key.name === "d") { close(null); process.exit(0); }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { close(null); return; }
    if (key.name === "up")   { sel = sel <= 0 ? items.length - 1 : sel - 1; draw(); return; }
    if (key.name === "down") { sel = sel >= items.length - 1 ? 0 : sel + 1; draw(); return; }
    if (key.name === "return" || key.name === "enter") { close(items[sel]?.value ?? null); return; }
  }

  draw();
  process.stdin.on("keypress", onKey);
}

type SettingItem = { label: string; value: string; hint?: string; description?: string };

function runSettingsPicker(onDone: () => void) {
  const items: SettingItem[] = [
    { label: "thinking", value: "thinking", hint: showThinking ? "on" : "off",
      description: "Show AI reasoning process" },
    { label: "tools", value: "tools", hint: showTools ? "on" : "off",
      description: "Show tool calls and results" },
    { label: "memory", value: "memory", hint: allowMemoryTool ? "on" : "off",
      description: "Allow AI to save memories" },
    { label: "Submit", value: "__submit__", hint: "Enter",
      description: "Save and continue" },
  ];

  let sel = 0;
  let pickerLines = 0;

  function draw() {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);

    wr(`${D}Settings  ↑↓ navigate · Enter toggle/submit · Esc cancel${R}`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const active = i === sel;
      const prefix = active ? `${O}❯${R} ` : "  ";
      const label = active ? `${B}${item.label}${R}` : `${R}${item.label}${R}`;
      const hint = item.hint ? `  ${item.value === "thinking" ? (showThinking ? G : D) :
                             item.value === "tools" ? (showTools ? G : D) :
                             item.value === "memory" ? (allowMemoryTool ? G : D) :
                             D}${item.hint}${R}` : "";
      const desc = item.description ? `  ${D}${item.description}${R}` : "";
      wr("\n" + prefix + label + hint + desc);
    }

    pickerLines = items.length;
    readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
  }

  function close(save: boolean) {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdin.removeListener("keypress", onKey);

    if (save) {
      wrl(`${G}✓ Settings saved${R}\n`);
    }
    onDone();
  }

  function onKey(_char: string | undefined, key: any) {
    if (!key) return;
    if (key.ctrl && key.name === "d") { close(false); process.exit(0); }
    if (key.name === "escape") { close(false); return; }
    if (key.name === "up") { sel = sel <= 0 ? items.length - 1 : sel - 1; draw(); return; }
    if (key.name === "down") { sel = sel >= items.length - 1 ? 0 : sel + 1; draw(); return; }
    if (key.name === "return" || key.name === "enter") {
      const item = items[sel];
      if (item.value === "__submit__") {
        close(true);
      } else if (item.value === "thinking") {
        showThinking = !showThinking;
        items[0].hint = showThinking ? "on" : "off";
        draw();
      } else if (item.value === "tools") {
        showTools = !showTools;
        items[1].hint = showTools ? "on" : "off";
        draw();
      } else if (item.value === "memory") {
        allowMemoryTool = !allowMemoryTool;
        items[2].hint = allowMemoryTool ? "on" : "off";
        draw();
      }
      return;
    }
  }

  draw();
  process.stdin.on("keypress", onKey);
}

function runSessionsPicker(onDone: (sessionId: string | null) => void) {
  const sessionDir = sessionsDir();
  if (!fs.existsSync(sessionDir)) {
    wrl(`${D}No sessions found${R}\n`);
    onDone(null);
    return;
  }

  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("sessions"))
    .sort()
    .reverse();

  if (files.length === 0) {
    wrl(`${D}No sessions found${R}\n`);
    onDone(null);
    return;
  }

  const items: SettingItem[] = files.map(f => {
    const filePath = path.join(sessionDir, f);
    const content = safeRead(filePath);
    const ended = content?.includes("**Ended:**");
    const msgs = content?.match(/\*\*Messages:\*\* (\d+)/)?.[1] || "0";
    return {
      label: f.replace(".md", ""),
      value: f.replace(".md", ""),
      hint: ended ? "done" : "active",
      description: `${msgs} messages`,
    };
  });

  items.push({ label: "Cancel", value: "__cancel__", hint: "Esc", description: "Go back" });

  let sel = 0;
  let pickerLines = 0;

  function draw() {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);

    wr(`${D}Sessions  ↑↓ navigate · Enter select · Esc cancel${R}`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const active = i === sel;
      const prefix = active ? `${O}❯${R} ` : "  ";
      const label = active ? `${B}${item.label}${R}` : `${R}${item.label}${R}`;
      const hint = item.hint ? `  ${item.hint === "active" ? G : D}${item.hint}${R}` : "";
      const desc = item.description ? `  ${D}${item.description}${R}` : "";
      wr("\n" + prefix + label + hint + desc);
    }

    pickerLines = items.length;
    readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
  }

  function close(sessionId: string | null) {
    for (let i = 0; i < pickerLines; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (pickerLines > 0) readline.moveCursor(process.stdout, 0, -pickerLines);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdin.removeListener("keypress", onKey);
    onDone(sessionId);
  }

  function onKey(_char: string | undefined, key: any) {
    if (!key) return;
    if (key.ctrl && key.name === "d") { close(null); process.exit(0); }
    if (key.name === "escape" || (key.ctrl && key.name === "c")) { close(null); return; }
    if (key.name === "up") { sel = sel <= 0 ? items.length - 1 : sel - 1; draw(); return; }
    if (key.name === "down") { sel = sel >= items.length - 1 ? 0 : sel + 1; draw(); return; }
    if (key.name === "return" || key.name === "enter") {
      const item = items[sel];
      if (item.value === "__cancel__") {
        close(null);
      } else {
        currentSessionId = item.value;
        wrl(`${D}Restarting with session ${item.value}...${R}\n`);
        process.stdin.removeListener("keypress", onKey);
        process.exit(0);
      }
      return;
    }
  }

  draw();
  process.stdin.on("keypress", onKey);
}

// ── Command runner ────────────────────────────────────────────────────────────

async function runCommand(input: string, onPrompt: () => void): Promise<boolean> {
  const s = input.trim();
  if (s === "?") {
    wrl(`\n${B}Shortcuts:${R}`);
    wrl(`  ${O}Ctrl+C${R}  Cancel stream / clear line`);
    wrl(`  ${O}Ctrl+D${R}  Exit`);
    wrl(`  ${O}↑↓${R}      History · picker navigation\n`);
    onPrompt(); return true;
  }
  if (!s.startsWith("/")) return false;

  const [rawCmd, ...rest] = s.slice(1).split(/\s+/);
  const cmd = rawCmd ?? "";
  const arg = rest.join(" ").trim();

  switch (cmd.toLowerCase()) {
    case "exit": case "quit":
      endSession();
      wrl(`\n${D}Goodbye. Session saved.${R}\n`); process.exit(0);

    case "help":
      wrl(`\n${B}Commands:${R}`);
      for (const c of CMDS) {
        const gap = Math.max(2, 16 - c.name.length);
        wrl(`  ${O}${c.name}${R}${" ".repeat(gap)}${D}${c.desc}${R}`);
      }
      wrl(); onPrompt(); return true;

    case "clear":
      conversation = []; wrl(`${D}Conversation cleared.${R}\n`); onPrompt(); return true;

    case "model": {
      if (arg && MODELS.includes(arg)) {
        currentModel = arg; wrl(`${D}Model → ${arg}${R}\n`); onPrompt(); return true;
      }
      wrl();
      runPicker(
        MODELS.map(m => ({ label: m, value: m, hint: m === currentModel ? "current" : undefined })),
        "Select model",
        currentModel,
        (val) => {
          if (val) { currentModel = val; wrl(`${D}Model → ${val}${R}\n`); }
          onPrompt();
        }
      );
      return true;
    }

    case "effort": {
      if (arg && EFFORTS.includes(arg)) {
        currentEffort = arg; wrl(`${D}Effort → ${arg}${R}\n`); onPrompt(); return true;
      }
      wrl();
      runPicker(
        EFFORTS.map(e => ({ label: e, value: e, hint: e === currentEffort ? "current" : undefined })),
        "Select effort",
        currentEffort,
        (val) => {
          if (val) { currentEffort = val; wrl(`${D}Effort → ${val}${R}\n`); }
          onPrompt();
        }
      );
      return true;
    }

    case "memory": {
      const paths = activeUserPaths();
      if (arg) {
        const filePath = saveMemory(arg);
        wrl(`${G}✓${R} Memory saved to ${D}${shortPath(filePath)}${R}\n`);
      } else {
        const files = fs.existsSync(paths.memories)
          ? fs.readdirSync(paths.memories).filter(f => f.endsWith(".md")).sort()
          : [];
        if (!files.length) {
          wrl(`${D}No memories saved yet. Use /memory <text> to save one.${R}\n`);
        } else {
          wrl(`\n${B}Saved memories:${R}`);
          for (const f of files) {
            const content = fs.readFileSync(path.join(paths.memories, f), "utf8");
            const preview = content
              .split("\n")
              .map(l => l.trim())
              .find(l => l && !l.startsWith("#") && !l.startsWith("Created:"))
              ?.slice(0, 60) ?? "";
            wrl(`  ${O}${f}${R}  ${D}${preview}${R}`);
          }
          wrl(`\n${D}${shortPath(paths.memories)}${R}\n`);
        }
      }
      onPrompt(); return true;
    }

    case "profile": {
      const paths = activeUserPaths();
      if (arg === "path") {
        wrl(`${D}${shortPath(paths.profile)}${R}\n`);
      } else if (fs.existsSync(paths.profile)) {
        const content = fs.readFileSync(paths.profile, "utf8");
        wrl(`\n${content}`);
      } else {
        wrl(`${D}No profile found. Restart Cipher to run onboarding.${R}\n`);
      }
      onPrompt(); return true;
    }

    case "settings": {
      runSettingsPicker(() => {
        onPrompt();
      });
      return true;
    }

    case "sessions": {
      if (arg === "current") {
        if (currentSessionId) {
          const sessionFile = currentSessionFilePath();
          if (fs.existsSync(sessionFile)) {
            const content = fs.readFileSync(sessionFile, "utf8");
            wrl(`\n${content}`);
          }
        } else {
          wrl(`${D}No active session.${R}\n`);
        }
        onPrompt(); return true;
      }
      if (arg) {
        const sessionFile = path.join(sessionsDir(), `${arg}.md`);
        if (fs.existsSync(sessionFile)) {
          wrl(`${D}Switching to session ${arg}...${R}\n`);
          process.exit(0);
        } else {
          wrl(`${D}Session ${arg} not found.${R}\n`);
        }
        onPrompt(); return true;
      }
      runSessionsPicker((sessionId) => {
        if (sessionId) {
          process.exit(0);
        }
        onPrompt();
      });
      return true;
    }

    case "new": {
      endSession();
      const newId = createSession();
      conversation = [];
      wrl(`${G}✓${R} New session started: ${newId}${R}\n`);
      drawBanner();
      onPrompt(); return true;
    }

    default:
      wrl(`${D}Unknown command /${cmd}. Type /help${R}\n`); onPrompt(); return true;
  }
}

// ── Main input loop ───────────────────────────────────────────────────────────

function findIncompleteSession(): string | null {
  const sessionDir = sessionsDir();
  if (!fs.existsSync(sessionDir)) return null;

  const files = fs.readdirSync(sessionDir)
    .filter(f => f.endsWith(".md") && !f.startsWith("sessions"));

  const incomplete: { id: string; mtime: number }[] = [];
  for (const file of files) {
    const filePath = path.join(sessionDir, file);
    const content = safeRead(filePath);
    if (content && !content.includes("**Ended:**")) {
      const stat = fs.statSync(filePath);
      const id = file.replace(".md", "");
      incomplete.push({ id, mtime: stat.mtimeMs });
    }
  }

  if (incomplete.length === 0) return null;
  incomplete.sort((a, b) => b.mtime - a.mtime);
  return incomplete[0].id;
}

async function main() {
  const args = process.argv.slice(2);
  let sessionArg: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--session" && args[i + 1]) {
      sessionArg = args[i + 1];
      break;
    }
  }

  // Onboarding: runs before raw mode, uses regular readline
  migrateLegacyProfileIfNeeded();
  const paths = activeUserPaths();
  if (!fs.existsSync(paths.profile)) {
    await runOnboarding();
  }

  // Find active session or use provided session
  if (sessionArg) {
    const sessionFile = path.join(sessionsDir(), `${sessionArg}.md`);
    if (fs.existsSync(sessionFile)) {
      currentSessionId = sessionArg;
      sessionStartTime = new Date().toISOString();
      conversation = loadSessionMessages();
      clearTerminal();
      wrl(`${D}Loaded session: ${sessionArg}${R}`);
      if (conversation.length > 0) {
        renderSessionChat();
      } else {
        drawBanner();
      }
    } else {
      wrl(`${D}Session ${sessionArg} not found.${R}\n`);
      const activeSessionId = findIncompleteSession();
      if (activeSessionId) {
        currentSessionId = activeSessionId;
      } else {
        const sessionId = createSession();
        wrl(`${D}Session started: ${sessionId}${R}`);
      }
      clearTerminal();
      drawBanner();
    }
  } else {
    const activeSessionId = findIncompleteSession();
    if (activeSessionId) {
      currentSessionId = activeSessionId;
      const sessionFile = currentSessionFilePath();
      sessionStartTime = new Date().toISOString();
      sessionMessageCount = 0;
      sessionToolUses = [];
    } else {
      const sessionId = createSession();
      wrl(`${D}Session started: ${sessionId}${R}\n`);
    }

    clearTerminal();

    const prevMessages = loadSessionMessages();
    if (prevMessages.length > 0) {
      conversation = prevMessages;
      wrl(`${D} Continuing session: ${currentSessionId}${R}`);
      renderSessionChat();
    } else {
      wrl(`${D}Session: ${currentSessionId}${R}`);
      drawBanner();
    }
  }

  wrl();

  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let done = false;
      if (await runCommand(line, () => { done = true; })) continue;
      wrl(); await sendMessage(line);
    }
    return;
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  readline.emitKeypressEvents(process.stdin);

  let buf      = "";
  let sel      = -1;
  let rendered = 0;
  let history: string[] = [];
  let histIdx  = -1;
  let locked   = false;

  function getMatches() { return CMDS.filter(c => c.name.startsWith(buf)); }

  function clearUI() {
    for (let i = 0; i < rendered; i++) {
      readline.moveCursor(process.stdout, 0, 1);
      readline.clearLine(process.stdout, 0);
    }
    if (rendered > 0) readline.moveCursor(process.stdout, 0, -rendered);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    rendered = 0;
  }

  function render() {
    const W = tw();
    wr(`${O}❯${R} ${buf}`);
    const list = getMatches();
    if (!buf.startsWith("/") || !list.length) { rendered = 0; return; }
    for (let i = 0; i < list.length; i++) {
      const c = list[i], active = i === sel;
      if (!c) continue;
      const prefix   = active ? `${O}❯${R} ` : "  ";
      const namePart = active ? `${O}\x1b[1m${c.name}\x1b[22m${R}` : `${O}${c.name}${R}`;
      const descPart = active ? `${R}${c.desc}${R}` : `${D}${c.desc}${R}`;
      const gap = Math.max(4, W - 2 - c.name.length - c.desc.length - 2);
      wr("\n" + prefix + namePart + " ".repeat(gap) + descPart);
    }
    rendered = list.length;
    readline.moveCursor(process.stdout, 0, -rendered);
    readline.cursorTo(process.stdout, 2 + buf.length);
  }

  function redraw() { clearUI(); render(); }

  function showPrompt() {
    locked = false;
    buf = ""; sel = -1; rendered = 0;
    wr(`${O}❯${R} `);
  }

  wr(`${O}❯${R} `);

  process.stdin.on("keypress", async (_char: string | undefined, key: any) => {
    if (!key || locked) return;

    if (key.ctrl && key.name === "d") {
      clearUI(); endSession(); wrl(`\n${D}Goodbye. Session saved.${R}\n`); process.exit(0);
    }

    if (key.ctrl && key.name === "c") {
      if (abortCtrl) { abortCtrl.abort(); return; }
      clearUI(); buf = ""; sel = -1; rendered = 0; wrl(); wr(`${O}❯${R} `); return;
    }

    if (key.name === "escape") { sel = -1; redraw(); return; }

    if (key.name === "up") {
      if (buf.startsWith("/") && rendered > 0) {
        const list = getMatches();
        sel = sel <= 0 ? list.length - 1 : sel - 1; redraw();
      } else {
        if (histIdx < history.length - 1) { histIdx++; buf = history[histIdx] ?? ""; sel = -1; redraw(); }
      }
      return;
    }

    if (key.name === "down") {
      if (buf.startsWith("/") && rendered > 0) {
        const list = getMatches();
        sel = sel >= list.length - 1 ? 0 : sel + 1; redraw();
      } else {
        histIdx > 0 ? (buf = history[--histIdx] ?? "") : (buf = "", histIdx = -1);
        sel = -1; redraw();
      }
      return;
    }

    if (key.name === "return" || key.name === "enter") {
      if (sel >= 0 && buf.startsWith("/")) {
        const list = getMatches();
        const picked = list[sel];
        if (picked) { buf = picked.name + " "; sel = -1; redraw(); return; }
      }

      clearUI();
      const input = buf.trim();
      buf = ""; sel = -1; histIdx = -1;
      wrl();
      if (!input) { wr(`${O}❯${R} `); return; }
      history.unshift(input);

      locked = true;
      if (await runCommand(input, showPrompt)) return;
      await sendMessage(input);
      showPrompt();
      return;
    }

    if (key.name === "backspace") {
      if (!buf.length) return;
      buf = buf.slice(0, -1); sel = -1; redraw(); return;
    }

    if (key.name === "tab") {
      const list = getMatches();
      const first = list[0];
      if (first) { buf = first.name + " "; sel = -1; redraw(); }
      return;
    }

    if (!key.ctrl && !key.meta && _char && _char >= " ") {
      buf += _char; sel = -1; redraw();
    }
  });

  process.on("SIGINT", () => { if (abortCtrl) abortCtrl.abort(); endSession(); });
}

main().catch(e => { console.error(e); process.exit(1); });
