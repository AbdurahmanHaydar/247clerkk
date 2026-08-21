/**
 * A small user-agent parser. Deliberately not a dependency: we only need
 * browser, version, OS and form factor, and modern Chromium browsers hand us
 * the accurate answer through client hints anyway (see `client.uaData`). This
 * covers the rest, and everything unknown keeps the raw string in `user_agent`.
 */

export type Agent = {
  browser: string | null;
  browserVersion: string | null;
  os: string | null;
  device: "mobile" | "tablet" | "desktop" | "bot" | null;
};

// Order matters: Edge claims to be Chrome, Chrome claims to be Safari.
const BROWSERS: [string, RegExp][] = [
  ["Edge", /Edg(?:e|A|iOS)?\/([\d.]+)/],
  ["Opera", /(?:OPR|Opera)\/([\d.]+)/],
  ["Samsung Internet", /SamsungBrowser\/([\d.]+)/],
  ["Firefox", /(?:Firefox|FxiOS)\/([\d.]+)/],
  ["Chrome", /(?:Chrome|CriOS)\/([\d.]+)/],
  ["Safari", /Version\/([\d.]+).*Safari/],
  ["WhatsApp", /WhatsApp\/([\d.]+)/],
  ["Instagram", /Instagram ([\d.]+)/],
  ["Facebook", /FBAV\/([\d.]+)/],
];

const OSES: [string, RegExp][] = [
  ["Android", /Android ([\d.]+)/],
  ["iOS", /(?:iPhone )?OS ([\d_]+) like Mac/],
  ["Windows", /Windows NT ([\d.]+)/],
  ["macOS", /Mac OS X ([\d_]+)/],
  ["Chrome OS", /CrOS \w+ ([\d.]+)/],
  ["Linux", /Linux/],
];

const WINDOWS_NAMES: Record<string, string> = {
  "10.0": "10/11",
  "6.3": "8.1",
  "6.2": "8",
  "6.1": "7",
};

const BOT = /bot|crawler|spider|crawling|preview|facebookexternalhit|slackbot|whatsapp|telegram|headless|curl|wget|python-requests|monitor|uptime|lighthouse/i;

export function parseAgent(ua: string | null | undefined): Agent {
  if (!ua) return { browser: null, browserVersion: null, os: null, device: null };

  // Link previews and scrapers first — they also match the browser patterns,
  // and counting them as visitors is how a funnel starts lying to you.
  if (BOT.test(ua) && !/WhatsApp\/[\d.]+ [AI]/.test(ua)) {
    return { browser: label(ua), browserVersion: null, os: null, device: "bot" };
  }

  let browser: string | null = null;
  let browserVersion: string | null = null;
  for (const [name, pattern] of BROWSERS) {
    const match = ua.match(pattern);
    if (match) {
      browser = name;
      browserVersion = match[1]?.replace(/_/g, ".") ?? null;
      break;
    }
  }

  let os: string | null = null;
  for (const [name, pattern] of OSES) {
    const match = ua.match(pattern);
    if (match) {
      const version = match[1]?.replace(/_/g, ".");
      const pretty = name === "Windows" && version ? (WINDOWS_NAMES[version] ?? version) : version;
      os = pretty ? `${name} ${pretty}` : name;
      break;
    }
  }

  const tablet = /iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/.test(ua);
  const mobile = /Mobi|iPhone|iPod|Android|IEMobile|BlackBerry|Opera Mini/.test(ua);

  return {
    browser,
    browserVersion,
    os,
    device: tablet ? "tablet" : mobile ? "mobile" : "desktop",
  };
}

/** Best-effort name for a bot, e.g. "facebookexternalhit". */
function label(ua: string): string {
  const match = ua.match(/([A-Za-z][\w-]*(?:bot|crawler|spider|preview|externalhit|Slackbot|curl|wget|HeadlessChrome))/i);
  return match?.[1] ?? "bot";
}
