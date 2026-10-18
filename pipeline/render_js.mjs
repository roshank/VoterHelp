// Render JavaScript-only pages with headless Chromium. Used by campaign_sites.py as a fallback.
// Usage: node render_js.mjs <url>...  -> prints {"<url>": "<rendered html>" | null} as JSON.
import { chromium } from "playwright";

const proxy = process.env.HTTPS_PROXY ? new URL(process.env.HTTPS_PROXY) : null;
const browser = await chromium.launch({ args: proxy ? [`--proxy-server=https=${proxy.host}`] : [] });
const page = await browser.newPage({ userAgent: "VoterHelp/0.1 (nonpartisan voter guide; github.com/roshank/VoterHelp)" });
const out = {};
for (const url of process.argv.slice(2)) {
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    out[url] = await page.content();
  } catch {
    out[url] = null;
  }
}
await browser.close();
process.stdout.write(JSON.stringify(out));
