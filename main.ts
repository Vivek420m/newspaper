#!/usr/bin/env node
/**
 * main.ts — newspaper-style daily news entry image generator.
 *
 * Takes a news summary (CLI argument or piped stdin), generates an AI
 * background illustration with z-ai-web-dev-sdk, composites a newspaper-style
 * masthead (publication name, date line, top headline) plus an "ALSO INSIDE"
 * strip, and saves the 1024x1024 result as a PNG (default: /output/entry.png).
 *
 * Summary format (plain text):
 *   Line 1          -> top headline (rendered large, uppercased)
 *   Following lines -> secondary items; optional "- " / "• " prefixes
 *
 * Usage:
 *   node main.ts "Headline text"
 *   cat news_summary.txt | node main.ts
 *   node main.ts                                    # uses bundled Nov 18, 2026 digest
 *
 * Running TypeScript:
 *   Node >= 23.6 : node main.ts          (type stripping is on by default)
 *   Node 22.6+   : node --experimental-strip-types main.ts
 *   any Node 18+ : npx tsx main.ts
 *
 * Options:
 *   -o, --output <path>   Output PNG path    (default: /output/entry.png)
 *   --masthead <text>     Publication name   (default: THE DAILY BRIEF)
 *   --date <text>         Date line          (default: Wednesday, November 18, 2026)
 *   --no-ai               Skip AI background, use a plain aged-paper background
 *   --cli                 Skip the SDK, generate via the z-ai CLI subprocess
 *   --bg <path>           Use an existing image file as the background (skips AI)
 *   -h, --help            Show this help
 *
 * Dependencies: npm install z-ai-web-dev-sdk sharp   (Node >= 22.6)
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const SIZE = 1024;
const INK = '#1a1712';
const CREAM = '#f7f3e8';
const SERIF = "'Noto Serif SC','Liberation Serif','DejaVu Serif',Georgia,'Times New Roman',serif";

const DEFAULT_OUTPUT = '/output/entry.png';
const DEFAULT_MASTHEAD = 'THE DAILY BRIEF';
const DEFAULT_DATE = 'Wednesday, November 18, 2026';

// Sourced digest of the top stories of November 18, 2026
// (NPR, ABC World News Tonight, Democracy Now, UN News).
const DEFAULT_SUMMARY = [
  'Trump lands in China for first-ever trilateral summit with Xi and Putin',
  "- Trump greeted on the tarmac in Shenzhen by Xi Jinping before Thursday's APEC trilateral on nuclear limits and ending the Ukraine war",
  '- Global tech outages hit Microsoft, the FAA, JPMorgan Chase and NSA networks; Rubio sees no evidence of foreign links',
  '- Russia launches heavy attacks across Ukraine, while the US-Iran conflict continues with no end in sight',
  '- Colombia ends Amazon protections and rejects a fossil-fuel phaseout; critics denounce "ecocide"',
  "- UN warns Yemen's Taiz City is increasingly isolated; $18M emergency fund released for 824,000 Afghans",
].join('\n');

interface CliOpts {
  output: string;
  masthead: string;
  date: string;
  useAi: boolean;
  forceCli: boolean;
  bg?: string;
  help?: boolean;
  positional: string[];
}

interface ParsedSummary {
  headline: string;
  items: string[];
}

interface HeadlineLayout {
  fs: number;
  lh: number;
  lines: string[];
}

interface ItemsLayout {
  fs: number;
  lh: number;
  blocks: string[][];
}

const log = (m: string): void => console.log('[entry] ' + m);
const die = (m: string): never => { console.error('[entry] ERROR: ' + m); process.exit(2); };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- args -- */

function parseArgs(argv: string[]): CliOpts {
  const opts: CliOpts = { output: DEFAULT_OUTPUT, masthead: DEFAULT_MASTHEAD, date: DEFAULT_DATE, useAi: true, forceCli: false, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') opts.help = true;
    else if (a === '-o' || a === '--output') opts.output = argv[++i] ?? die('Missing value for --output');
    else if (a.startsWith('--output=')) opts.output = a.slice('--output='.length);
    else if (a === '--masthead') opts.masthead = argv[++i] ?? die('Missing value for --masthead');
    else if (a.startsWith('--masthead=')) opts.masthead = a.slice('--masthead='.length);
    else if (a === '--date') opts.date = argv[++i] ?? die('Missing value for --date');
    else if (a.startsWith('--date=')) opts.date = a.slice('--date='.length);
    else if (a === '--no-ai') opts.useAi = false;
    else if (a === '--cli') opts.forceCli = true;
    else if (a === '--bg') opts.bg = argv[++i] ?? die('Missing value for --bg');
    else if (a.startsWith('--bg=')) opts.bg = a.slice('--bg='.length);
    else if (a.startsWith('-')) die(`Unknown option: ${a} (see --help)`);
    else opts.positional.push(a);
  }
  return opts;
}

function printHelp(): void {
  console.log(`main.ts — newspaper-style daily news entry image (1024x1024)

USAGE
  node main.ts ["summary text"]
  cat news_summary.txt | node main.ts [options]

SUMMARY FORMAT
  First line      = top headline (rendered large)
  Further lines   = secondary items (optional "- " or "• " prefixes)

OPTIONS
  -o, --output <path>   output PNG path        (default: ${DEFAULT_OUTPUT})
  --masthead <text>     publication name       (default: ${DEFAULT_MASTHEAD})
  --date <text>         date line              (default: ${DEFAULT_DATE})
  --no-ai               skip AI background (plain aged-paper background)
  --cli                 skip the SDK, generate via the z-ai CLI subprocess
  --bg <path>           use an existing image as background (skips AI)
  -h, --help            show this help

DEPENDENCIES
  npm install z-ai-web-dev-sdk sharp`);
}

/* -------------------------------------------------------------- summary -- */

async function readSummary(opts: CliOpts): Promise<string> {
  if (opts.positional.length) return opts.positional.join(' ');
  if (!process.stdin.isTTY) {
    const text = await readStdinIfAvailable();
    if (text) return text;
  }
  log('No summary given — using the bundled November 18, 2026 digest.');
  return DEFAULT_SUMMARY;
}

// Read piped stdin, but never hang: if no data arrives within 400ms (or the
// stream goes silent for 5s), give up and let the caller use its fallback.
function readStdinIfAvailable(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let gotData = false, done = false;
    let idleTimer: NodeJS.Timeout, silenceTimer: NodeJS.Timeout;
    const finish = (): void => {
      if (done) return;
      done = true;
      clearTimeout(idleTimer); clearTimeout(silenceTimer);
      try { process.stdin.destroy(); } catch {}
      resolve(Buffer.concat(chunks).toString('utf8').trim());
    };
    idleTimer = setTimeout(() => { if (!gotData) finish(); }, 400);
    process.stdin.on('data', (c: Buffer) => {
      gotData = true;
      clearTimeout(idleTimer);
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(finish, 5000);
      chunks.push(c);
    });
    process.stdin.once('end', finish);
    process.stdin.once('error', finish);
  });
}

function parseSummary(raw: string): ParsedSummary {
  const lines = raw.replace(/\r/g, '').split('\n').map((s) => s.trim()).filter(Boolean);
  let headline = '';
  const items: string[] = [];
  for (const line of lines) {
    const isBullet = /^[-•*·—]\s+/.test(line) || /^\d+[.)]\s+/.test(line);
    const cleaned = line.replace(/^[-•*·—]\s+/, '').replace(/^\d+[.)]\s+/, '').trim();
    if (!headline && !isBullet) headline = cleaned;
    else if (cleaned) items.push(cleaned);
  }
  if (!headline) headline = items.shift() || 'The Day in News';
  headline = headline.replace(/^(?:top story|headline)\s*[:：]\s*/i, '').slice(0, 220);
  return { headline, items: items.slice(0, 4) };
}

/* ------------------------------------------------- text width estimator -- */

function charW(ch: string, fsPx: number): number {
  if ('iljI|!.,;:\'`'.includes(ch)) return 0.30 * fsPx;
  if ('mwMW—@'.includes(ch)) return 0.90 * fsPx;
  if (/[A-Z]/.test(ch)) return 0.68 * fsPx;
  if (/[0-9]/.test(ch)) return 0.53 * fsPx;
  if (ch === ' ') return 0.28 * fsPx;
  return 0.52 * fsPx;
}

const textWidth = (s: string, fsPx: number): number => [...s].reduce((w, ch) => w + charW(ch, fsPx), 0);

function wrapText(text: string, maxW: number, fsPx: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const cand = cur ? cur + ' ' + w : w;
    if (!cur || textWidth(cand, fsPx) <= maxW) cur = cand;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines;
}

function truncateToWidth(text: string, maxW: number, fsPx: number): string {
  if (textWidth(text, fsPx) <= maxW) return text;
  let t = text;
  while (t.length > 1 && textWidth(t + '…', fsPx) > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

function layoutHeadline(text: string): HeadlineLayout {
  const maxW = 920;
  for (const [fs, lh, maxLines] of [[46, 52, 3], [40, 46, 3], [34, 40, 3], [30, 36, 4]] as const) {
    const lines = wrapText(text, maxW, fs);
    if (lines.length <= maxLines && lines.every((l) => textWidth(l, fs) <= maxW)) return { fs, lh, lines };
  }
  const fs = 30, lh = 36, maxLines = 4;
  const lines = wrapText(text, maxW, fs).slice(0, maxLines);
  lines[maxLines - 1] = truncateToWidth(lines[maxLines - 1], maxW, fs);
  return { fs, lh, lines };
}

function layoutItems(items: string[]): ItemsLayout {
  const maxW = 872;
  for (const [fs, lh, maxLines] of [[19, 25, 3], [17, 22, 4], [15, 19, 4]] as const) {
    const blocks = items.map((t) => wrapText(t, maxW, fs).slice(0, 2));
    const total = blocks.reduce((s, b) => s + b.length, 0);
    if (total <= maxLines) return { fs, lh, blocks };
  }
  return { fs: 15, lh: 19, blocks: items.slice(0, 4).map((t) => [truncateToWidth(t, maxW, 15)]) };
}

/* ------------------------------------------------------ AI background -- */

function buildArtPrompts(headline: string, items: string[]): string[] {
  const topic = [headline, ...items].join('; ').slice(0, 420);
  const style = 'Vintage newspaper front-page engraving illustration in the style of a 19th-century etching. Cream paper background, black ink linework, fine crosshatch shading, dramatic editorial composition, aged paper texture, high quality, detailed. Strictly no text, no words, no letters, no numbers, no captions, no watermark.';
  // Variant 1 reflects the actual summary; variant 2 is a neutral fallback in
  // case the image API's content filter rejects news-specific wording.
  return [
    `Vintage newspaper front-page engraving illustration in the style of a 19th-century etching, depicting: ${topic}. ${style}`,
    `Vintage newspaper front-page engraving illustration in the style of a 19th-century etching: a large globe of the Earth surrounded by engraved scenes of world events — printing press, telegraph, steam train, sailing ship, city skyline, doves. ${style}`,
  ];
}

const SDK_INIT_TIMEOUT_MS = 30000;
const SDK_CALL_TIMEOUT_MS = 60000;
const CLI_TIMEOUT_MS = 240000;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${label} timed out after ${ms / 1000}s`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

async function trySdkBackground(prompt: string): Promise<Buffer | null> {
  let ZAI: { create(): Promise<any> } | null = null;
  try { ZAI = await withTimeout(import('z-ai-web-dev-sdk').then((m: any) => m.default), 15000, 'SDK import'); }
  catch { log('z-ai-web-dev-sdk unavailable — trying z-ai CLI fallback...'); return null; }
  try {
    const zai = await withTimeout(ZAI.create(), SDK_INIT_TIMEOUT_MS, 'SDK init');
    const res = await withTimeout(
      zai.images.generations.create({ prompt, size: `${SIZE}x${SIZE}` }),
      SDK_CALL_TIMEOUT_MS, 'SDK image call');
    const b64 = res?.data?.[0]?.base64;
    if (!b64) throw new Error('empty API response');
    return Buffer.from(b64, 'base64');
  } catch (err) {
    log(`SDK path failed: ${(err as Error).message} — trying z-ai CLI fallback...`);
    return null;
  }
}

function tryCliBackground(prompt: string, tmpPath: string): Promise<Buffer | null> {
  return new Promise<Buffer | null>((resolve) => {
    execFile('z-ai', ['image', '-p', prompt, '-o', tmpPath, '-s', `${SIZE}x${SIZE}`],
      { timeout: CLI_TIMEOUT_MS }, (err: Error | null) => {
        if (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') log('z-ai CLI not found on PATH.');
          else log(`z-ai CLI failed: ${err.message.split('\n').slice(-3).join(' ').slice(0, 300)}`);
          return resolve(null);
        }
        try {
          if (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size < 1000) throw new Error('CLI produced no usable file');
          const data = fs.readFileSync(tmpPath);
          try { fs.rmSync(tmpPath, { force: true }); } catch {}
          resolve(data);
        } catch (e) { log(`z-ai CLI failed: ${(e as Error).message}`); resolve(null); }
      });
  });
}

async function generateBackground(prompts: string[], tmpPath: string, forceCli = false): Promise<Buffer | null> {
  // 1) Official SDK path (with hard timeouts so the script can never hang)
  if (!forceCli) {
    const viaSdk = await trySdkBackground(prompts[0]);
    if (viaSdk) return viaSdk;
    log('SDK path unavailable — trying z-ai CLI fallback...');
  }
  // 2) z-ai CLI fallback (same backend, subprocess) — tries every prompt variant
  for (const prompt of prompts) {
    const buf = await tryCliBackground(prompt, tmpPath);
    if (buf) return buf;
  }
  try { fs.rmSync(tmpPath, { force: true }); } catch {}
  return null;
}

function paperBackgroundSvg(): string {
  const hatch: string[] = [];
  for (let y = 0; y < SIZE; y += 8) hatch.push(`<line x1="0" y1="${y}" x2="${SIZE}" y2="${y}"/>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <defs><radialGradient id="v" cx="50%" cy="42%" r="80%">
    <stop offset="0%" stop-color="#faf6ec"/><stop offset="100%" stop-color="#e7dfcc"/>
  </radialGradient></defs>
  <rect width="${SIZE}" height="${SIZE}" fill="url(#v)"/>
  <g stroke="${INK}" stroke-width="1" opacity="0.045">${hatch.join('')}</g>
</svg>`;
}

/* ------------------------------------------------------- overlay (SVG) -- */

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function buildOverlaySvg({ masthead, dateLine, headline, items }: { masthead: string; dateLine: string; headline: string; items: string[] }): string {
  const h = layoutHeadline(headline.toUpperCase());
  const it = layoutItems(items);

  // masthead panel (top)
  const parts: string[] = [];
  parts.push(`<rect x="0" y="0" width="${SIZE}" height="340" fill="${CREAM}" opacity="0.97"/>`);
  parts.push(`<text x="512" y="56" text-anchor="middle" font-family="${SERIF}" font-size="16" letter-spacing="4" fill="${INK}">— EVENING EDITION —</text>`);
  parts.push(`<text x="512" y="110" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="46" letter-spacing="6" fill="${INK}">${esc(masthead)}</text>`);
  parts.push(`<line x1="402" y1="126" x2="622" y2="126" stroke="${INK}" stroke-width="1"/>`);
  parts.push(`<text x="512" y="154" text-anchor="middle" font-family="${SERIF}" font-size="17" letter-spacing="3" fill="${INK}">${esc(dateLine.toUpperCase())}</text>`);
  parts.push(`<rect x="64" y="170" width="896" height="3" fill="${INK}"/>`);
  parts.push(`<rect x="64" y="177" width="896" height="1" fill="${INK}"/>`);

  // top headline, vertically centered in 190..330
  const contentH = (h.lines.length - 1) * h.lh + h.fs;
  const top = 190 + Math.max(0, (140 - contentH) / 2);
  h.lines.forEach((line, i) => {
    const y = top + h.fs * 0.9 + i * h.lh;
    parts.push(`<text x="512" y="${y.toFixed(1)}" text-anchor="middle" font-family="${SERIF}" font-weight="700" font-size="${h.fs}" fill="${INK}">${esc(line)}</text>`);
  });
  parts.push(`<rect x="0" y="340" width="${SIZE}" height="3" fill="${INK}"/>`);
  parts.push(`<rect x="0" y="347" width="${SIZE}" height="1" fill="${INK}"/>`);

  // "also inside" strip (bottom)
  parts.push(`<rect x="0" y="878" width="${SIZE}" height="146" fill="${CREAM}" opacity="0.97"/>`);
  parts.push(`<rect x="0" y="878" width="${SIZE}" height="3" fill="${INK}"/>`);
  parts.push(`<rect x="0" y="885" width="${SIZE}" height="1" fill="${INK}"/>`);
  parts.push(`<text x="64" y="914" font-family="${SERIF}" font-weight="700" font-size="14" letter-spacing="3.5" fill="${INK}">ALSO INSIDE</text>`);
  parts.push(`<line x1="196" y1="909" x2="760" y2="909" stroke="${INK}" stroke-width="1"/>`);
  parts.push(`<text x="960" y="914" text-anchor="end" font-family="${SERIF}" font-size="13" letter-spacing="3" fill="${INK}">PAGE ONE</text>`);

  let y = 942;
  it.blocks.forEach((block) => {
    block.forEach((line, i) => {
      if (i === 0) parts.push(`<circle cx="69" cy="${(y - it.fs * 0.32).toFixed(1)}" r="3" fill="${INK}"/>`);
      parts.push(`<text x="84" y="${y}" font-family="${SERIF}" font-size="${it.fs}" ${i > 0 ? 'font-style="italic"' : ''} fill="${INK}">${esc(line)}</text>`);
      y += it.lh;
    });
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
  <g>${parts.join('\n  ')}</g>
</svg>`;
}

/* ---------------------------------------------------------------- main -- */

const opts = parseArgs(process.argv.slice(2));
if (opts.help) { printHelp(); process.exit(0); }

let sharp: any;
try { sharp = (await import('sharp')).default; }
catch { die('Missing dependency "sharp" — run: npm install sharp z-ai-web-dev-sdk'); }

const raw = await readSummary(opts);
log('Summary loaded.');
const { headline, items } = parseSummary(raw);
log(`Top headline : ${headline}`);
log(`Also inside  : ${items.length} item(s)`);

const outPath = path.resolve(opts.output);
let bg: Buffer | null = null;
if (opts.bg) {
  const bgPath = path.resolve(opts.bg);
  bg = fs.readFileSync(bgPath);
  log(`Using provided background: ${bgPath}`);
} else if (opts.useAi) {
  log('Generating AI background (engraving-style illustration)...');
  bg = await generateBackground(buildArtPrompts(headline, items), `${outPath}.bg-tmp.png`, opts.forceCli);
  if (!bg) log('AI background unavailable — falling back to aged-paper background.');
}
if (!bg) bg = await sharp(Buffer.from(paperBackgroundSvg())).png().toBuffer();

const overlay = buildOverlaySvg({ masthead: opts.masthead, dateLine: opts.date, headline, items });
fs.mkdirSync(path.dirname(outPath), { recursive: true });

try {
  await sharp(bg).resize(SIZE, SIZE, { fit: 'cover' }).ensureAlpha()
    .composite([{ input: Buffer.from(overlay) }])
    .png().toFile(outPath);
  const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
  log(`Saved ${outPath} (1024x1024 PNG, ${kb} KB)`);
} catch (err) {
  die(`Could not write ${outPath}: ${(err as Error).message}` +
    (outPath === path.resolve(DEFAULT_OUTPUT) ? ' (permission denied? pass -o <path> to choose another location)' : ''));
}
