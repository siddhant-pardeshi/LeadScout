# LeadScout walkthrough generator
# Renders 13 scene SVGs -> PNGs (headless Chrome) -> female neural voice-over
# (edge-tts, Aria) -> 1080p MP4 with gentle camera drift + SRT captions.
#
# Usage:  tools/video/.venv/Scripts/python.exe tools/video/build_walkthrough.py
# Output: docs/walkthrough.mp4, docs/walkthrough.srt, docs/walkthrough-poster.png

import asyncio
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORK = ROOT / "tools" / "video"
SCENES_DIR = WORK / "scenes"
SEGS_DIR = WORK / "segs"
DOCS = ROOT / "docs"
VOICE = "en-US-AriaNeural"     # bright, friendly female neural voice
TTS_RATE = "+8%"
TTS_PITCH = "+4Hz"
W, H = 1920, 1080

# --------------------------------------------------------------------------
# Scenes: kind + content + narration. kind ∈ hero | bullets | cards | steps
# --------------------------------------------------------------------------
SCENES = [
    dict(kind="hero", kicker="THE WALKTHROUGH", title="LeadScout",
         sub="Bulk LinkedIn decision-maker finder — for Google Chrome",
         chips=["Bing-powered", "AI-optional", "100% local"],
         narration=(
             "Meet LeadScout! A Chrome extension that turns fifty to one hundred company names "
             "into a complete decision-maker lead sheet, ready for Microsoft Excel. It finds the "
             "CEO, the CTO, AI heads, product and engineering leaders, with their LinkedIn profiles "
             "and emails — in one click. This is the full walkthrough.")),
    dict(kind="bullets", kicker="THE PROBLEM", title="The old way hurts",
         points=["One company at a time — hours of copy-paste",
                 "Chatbots mix Company A into Company B",
                 "Stale designations and guessed profile links",
                 "Manual Excel typing, late into the night"],
         narration=(
             "Researching companies one by one is slow, and pasting multiple companies into a "
             "chatbot mixes up the details. LeadScout fixes that by researching every company in "
             "complete isolation — its own searches, its own page reads, its own AI call — so names "
             "never bleed between companies.")),
    dict(kind="steps", kicker="SETUP", title="Install in 2 minutes",
         steps=["Open chrome://extensions — enable Developer mode",
                "Load unpacked — select the LeadScout folder",
                "Pin LeadScout and log into LinkedIn",
                "Paste companies and press Start research"],
         narration=(
             "Installing takes two minutes. Open Chrome extensions and enable Developer mode. "
             "Click Load unpacked and select the LeadScout folder. Pin it to your toolbar. "
             "That's it — no servers, no signup; everything runs locally in your browser.")),
    dict(kind="bullets", kicker="STEP 1", title="Feed it everything",
         points=["LinkedIn company URLs — one per line",
                 "Plain names: Freshworks, Zoho Corporation…",
                 "Mixed lines: Postman - https://…",
                 "Add current page while browsing LinkedIn"],
         narration=(
             "Paste your companies in the big box — LinkedIn URLs, plain names like Freshworks, "
             "or a mix on the same line. Duplicates are removed automatically. You can also click "
             "Add current LinkedIn page while browsing, to capture the company you are viewing "
             "instantly.")),
    dict(kind="cards", kicker="STEP 2", title="The research engine",
         cards=[["Tier-1 resolver", "guess the slug, verify it live"],
                ["Scored Bing resolve", "recall-friendly matching"],
                ["About-page scan", "industry · size · HQ · website"],
                ["3 depths", "Quick · Standard · Deep"]],
         narration=(
             "For every company, LeadScout resolves its LinkedIn page — first by guessing the page "
             "slug and verifying it live, then by scored Bing search as backup. A deep scan reads "
             "the About page for industry, company size, headquarters, and website. Three scan "
             "depths balance speed and detail.")),
    dict(kind="bullets", kicker="STEP 3", title="Bing extraction",
         points=["Scoped searches for every company",
                 "Profile URLs come from real SERP results",
                 "Title parser turns results into people",
                 "Anti-bleed company gate on every row"],
         narration=(
             "Then it runs scoped Bing searches for decision-makers. Every profile link comes from "
             "a real search result — never guessed. A strict matching gate checks the company "
             "against each title and snippet, so a person appears only under the right company.")),
    dict(kind="bullets", kicker="THE HEADLINE FEATURE", title="Current roles only",
         points=["Title-verified roles are marked CURRENT",
                 "Former / was / Ex- markers are dropped",
                 "Position-aware: 'previously at Google' survives",
                 "Contradictions are flagged PAST? for review"],
         narration=(
             "You want the latest designation, not an old one. The role currency engine keeps a "
             "person only with a current role at this company. Former, ex, or was-style mentions "
             "are dropped — and it is position-aware: an engineer previously at Google stays, "
             "while a former CEO at Acme goes.")),
    dict(kind="bullets", kicker="TRUST", title="Verified, honest data",
         points=["Profile URLs only from real search results",
                 "Unverified rows are clearly flagged",
                 "P1–P5 priorities from the full designation list",
                 "Nothing is ever invented"],
         narration=(
             "Everything is labeled. Verified means the profile URL came from a real search result "
             "for that company. Unverified is flagged, never invented. Priorities P1 to P5 rank "
             "C-suite and founders above directors and managers, following the full B2B "
             "designation list.")),
    dict(kind="cards", kicker="EMAILS", title="Emails in two layers",
         cards=[["Hunter.io — free key", "matched, domain-verified emails"],
                ["Domain-verified pattern", "{first}.{last} from Hunter"],
                ["Pattern estimate", "always labeled estimated"],
                ["No source?", "the cell stays empty"]],
         narration=(
             "Emails work in two layers. With a free Hunter dot io key, LeadScout matches each "
             "person against real, domain-verified addresses. Without it, it estimates patterns "
             "like first dot last at the company's verified domain — and always labels them "
             "estimated, so you know exactly what to verify.")),
    dict(kind="bullets", kicker="EXPORT", title="One click → Excel",
         points=["📋 Copy the full 14-column TSV",
                 "Filter-aware: C-Suite only? Copy exactly that",
                 "Core 7-column template mode included",
                 ".CSV with UTF-8 BOM opens perfectly"],
         narration=(
             "One click copies the full fourteen-column TSV: name, designation, country, company, "
             "size, industry, LinkedIn URL, email, status, role currency, priority, verification, "
             "HQ, and the company page. Filters apply to exports too — filter to C-suite and copy "
             "exactly that. CSV downloads open perfectly in Excel.")),
    dict(kind="bullets", kicker="CONTROLS", title="Background queue & controls",
         points=["Live progress, ETA and stat tiles",
                 "Pause · Resume · Stop · Retry failed",
                 "⟳ Refresh all — latest data, always",
                 "Captcha-aware: pauses and notifies you"],
         narration=(
             "The queue runs in the background with live progress, ETAs, pause, resume, stop, "
             "retry, and refresh all. If Bing asks for human verification, LeadScout pauses "
             "itself, notifies you, and resumes when you are ready. Refresh all re-runs every "
             "company, so your data is always the latest.")),
    dict(kind="cards", kicker="POWER-UPS", title="Free AI keys (optional)",
         cards=[["Groq", "fast result structuring"],
                ["Gemini", "real Google-search grounding"],
                ["OpenRouter", "free Llama models"],
                ["Model rotated?", "edit the id in Settings"]],
         narration=(
             "AI is optional. Groq structures results fast, Gemini adds real Google search "
             "grounding, and OpenRouter offers free Llama models — all with free keys. And if a "
             "provider rotates a model id, you can update it right in settings, no reinstall "
             "needed.")),
    dict(kind="hero", kicker="YOUR TURN", title="Paste. Start. Excel.",
         sub="github.com/siddhant-pardeshi/LeadScout",
         chips=["⭐ Star the repo", "Try it on your Chrome today"],
         narration=(
             "That is LeadScout. Paste your list, click start, and export verified "
             "decision-makers to Excel — current roles, real links, honest labels. Star the repo, "
             "try it on your own Chrome, and ship your next lead list today.")),
]

# --------------------------------------------------------------------------
# SVG scene template (1920x1080)
# --------------------------------------------------------------------------
FONT = "'Segoe UI','Helvetica Neue',Arial,sans-serif"
MONO = "Consolas,'Cascadia Mono',monospace"

DEFS = """
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#0B0D17"/><stop offset="1" stop-color="#141731"/>
  </linearGradient>
  <linearGradient id="titleGrad" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="560" y2="0">
    <stop offset="0" stop-color="#6366F1"/><stop offset="0.45" stop-color="#C084FC"/>
    <stop offset="0.7" stop-color="#E9D5FF"/><stop offset="1" stop-color="#818CF8"/>
    <animateTransform attributeName="gradientTransform" type="translate"
      values="0 0; 700 0; 0 0" dur="7s" repeatCount="indefinite"/>
  </linearGradient>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#4F46E5"/><stop offset="1" stop-color="#A855F7"/>
  </linearGradient>
  <filter id="big" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="55"/></filter>
  <filter id="soft" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="14"/></filter>
</defs>
"""

def _esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))

def scene_svg(cfg, idx):
    total = len(SCENES)
    n = idx + 1
    parts = []
    parts.append(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">')
    parts.append(DEFS)
    parts.append(f'<rect width="{W}" height="{H}" fill="url(#bg)"/>')
    # ambient glows
    parts.append(f'<circle cx="1660" cy="150" r="200" fill="#6366F1" opacity="0.14" filter="url(#big)"/>')
    parts.append(f'<circle cx="260" cy="950" r="220" fill="#9333EA" opacity="0.12" filter="url(#big)"/>')
    # brand corner
    parts.append(f'<circle cx="120" cy="92" r="26" fill="none" stroke="#FFFFFF" stroke-width="7"/>')
    parts.append(f'<line x1="141" y1="113" x2="163" y2="135" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round"/>')
    parts.append(f'<circle cx="113" cy="86" r="4.5" fill="#FFFFFF"/><circle cx="128" cy="82" r="4.5" fill="#FFFFFF"/>')
    parts.append(f'<text x="180" y="102" font-family="{FONT}" font-size="30" font-weight="800" fill="#E7E9F2">LeadScout</text>')
    parts.append(f'<text x="{W-90}" y="100" text-anchor="end" font-family="{MONO}" font-size="24" fill="#5A617F">walkthrough · {n:02d}/{total:02d}</text>')
    # kicker + title (hero scenes use the centered layout instead)
    if cfg["kind"] != "hero":
        parts.append(f'<rect x="300" y="292" width="10" height="54" rx="5" fill="url(#accent)"/>')
        parts.append(f'<text x="332" y="334" font-family="{FONT}" font-size="30" font-weight="700" letter-spacing="6" fill="#A5B4FC">{_esc(cfg["kicker"].upper())}</text>')
        parts.append(f'<text x="300" y="430" font-family="{FONT}" font-size="84" font-weight="800" fill="url(#titleGrad)">{_esc(cfg["title"])}</text>')
    # content zone y 500..920
    y = 520
    kind = cfg["kind"]
    if kind == "bullets":
        for p in cfg["points"]:
            parts.append(f'<rect x="320" y="{y-8}" width="44" height="44" rx="12" fill="#0F2A20" stroke="#2E6E5B"/>')
            parts.append(f'<path d="M{330} {y+14} l9 9 l16 -20" stroke="#34D399" stroke-width="5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>')
            parts.append(f'<text x="392" y="{y+22}" font-family="{FONT}" font-size="35" fill="#D5DAEE">{_esc(p)}</text>')
            y += 92
    elif kind == "steps":
        for i, p in enumerate(cfg["steps"]):
            parts.append(f'<circle cx="342" cy="{y+14}" r="26" fill="#4F46E5"/>')
            parts.append(f'<text x="342" y="{y+23}" text-anchor="middle" font-family="{FONT}" font-size="26" font-weight="800" fill="#FFFFFF">{i+1}</text>')
            parts.append(f'<text x="396" y="{y+23}" font-family="{FONT}" font-size="35" fill="#D5DAEE">{_esc(p)}</text>')
            y += 92
    elif kind == "cards":
        cx0, cy0, cw, ch, gx, gy = 320, 520, 620, 150, 40, 36
        for i, (head, sub) in enumerate(cfg["cards"]):
            row, col = divmod(i, 2)
            x = cx0 + col * (cw + gx)
            yy = cy0 + row * (ch + gy)
            parts.append(f'<rect x="{x}" y="{yy}" width="{cw}" height="{ch}" rx="18" fill="#151827" stroke="#303756" stroke-width="2"/>')
            parts.append(f'<rect x="{x}" y="{yy}" width="8" height="{ch}" rx="4" fill="url(#accent)"/>')
            parts.append(f'<text x="{x+38}" y="{yy+58}" font-family="{FONT}" font-size="32" font-weight="700" fill="#E7E9F2">{_esc(head)}</text>')
            parts.append(f'<text x="{x+38}" y="{yy+106}" font-family="{FONT}" font-size="24" fill="#8A92AD">{_esc(sub)}</text>')
    elif kind == "hero":
        parts.append(f'<text x="960" y="600" text-anchor="middle" font-family="{FONT}" font-size="30" font-weight="700" letter-spacing="10" fill="#A5B4FC">{_esc(cfg["kicker"].upper())}</text>')
        parts.append(f'<text x="960" y="660" text-anchor="middle" font-family="{FONT}" font-size="120" font-weight="800" fill="url(#titleGrad)">{_esc(cfg["title"])}</text>')
        parts.append(f'<text x="960" y="720" text-anchor="middle" font-family="{MONO}" font-size="30" fill="#8A92AD">{_esc(cfg["sub"])}</text>')
        chips = cfg.get("chips", [])
        widths = [max(240, 34 + len(c) * 17) for c in chips]
        total_w = sum(widths) + 30 * (len(chips) - 1)
        x = 960 - total_w // 2
        for c, wch in zip(chips, widths):
            parts.append(f'<rect x="{x}" y="790" width="{wch}" height="56" rx="28" fill="#1A1E33" stroke="#3A4162"/>')
            parts.append(f'<text x="{x + wch//2}" y="827" text-anchor="middle" font-family="{FONT}" font-size="23" font-weight="600" fill="#C3C9E8">{_esc(c)}</text>')
            x += wch + 30
    # bottom progress bars
    bx, bw, gap = 300, 62, 14
    total_bars = total * (bw + gap) - gap
    bx = (W - total_bars) // 2
    for i in range(total):
        fill = "url(#accent)" if i < n else "#232842"
        parts.append(f'<rect x="{bx + i*(bw+gap)}" y="990" width="{bw}" height="10" rx="5" fill="{fill}"/>')
    parts.append(f'<text x="{W-90}" y="1002" text-anchor="end" font-family="{MONO}" font-size="22" fill="#5A617F">{n:02d} / {total:02d}</text>')
    parts.append("</svg>")
    return "\n".join(parts)

# --------------------------------------------------------------------------
# Entry modes — pure file generation only. The browser render, ffprobe and
# ffmpeg steps are executed from the shell (see README video section).
#   python build_walkthrough.py svgs    → tools/video/scenes/sceneNN.svg
#   python build_walkthrough.py voices  → tools/video/scenes/voiceNN.mp3
#   python build_walkthrough.py srt     → docs/walkthrough.srt + poster
# --------------------------------------------------------------------------
def write_svgs():
    SCENES_DIR.mkdir(parents=True, exist_ok=True)
    for i, cfg in enumerate(SCENES):
        name = "scene{0:02d}.svg".format(i + 1)
        (SCENES_DIR / name).write_text(scene_svg(cfg, i), encoding="utf-8")
        print("wrote", name)

async def _voice(text, mp3_path):
    import edge_tts
    com = edge_tts.Communicate(text, VOICE, rate=TTS_RATE, pitch=TTS_PITCH)
    await com.save("{0}".format(mp3_path))

def write_voices():
    SCENES_DIR.mkdir(parents=True, exist_ok=True)
    for i, cfg in enumerate(SCENES):
        n = i + 1
        mp3 = SCENES_DIR / "voice{0:02d}.mp3".format(n)
        asyncio.run(_voice(cfg["narration"], mp3))
        print("voice {0:02d} ok".format(n))

def srt_ts(sec):
    ms = int(round(sec * 1000))
    h, rem = divmod(ms, 3600000)
    m, rem = divmod(rem, 60000)
    s, ms = divmod(rem, 1000)
    return "{0:02d}:{1:02d}:{2:02d},{3:03d}".format(h, m, s, ms)

def wrap_caption(text, width=78):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        if len(cur) + len(w) + 1 > width:
            lines.append(cur)
            cur = w
        else:
            cur = (cur + " " + w).strip()
    if cur:
        lines.append(cur)
    return "\n".join(lines[:3])

def write_srt():
    DOCS.mkdir(parents=True, exist_ok=True)
    dpath = WORK / "durations.txt"
    out = []
    t = 0.0
    idx = 1
    for line in dpath.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        d = float(line)
        seg_len = d + 0.75
        out.append("{0}\n{1} --> {2}\n{3}\n".format(
            idx, srt_ts(t), srt_ts(t + d + 0.4), wrap_caption(SCENES[idx - 1]["narration"])))
        t += seg_len
        idx += 1
    (DOCS / "walkthrough.srt").write_text("\n".join(out), encoding="utf-8")
    shutil.copyfile(SCENES_DIR / "scene01.png", DOCS / "walkthrough-poster.png")
    print("captions -> docs/walkthrough.srt, poster -> docs/walkthrough-poster.png")

def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "svgs"
    if mode == "svgs":
        write_svgs()
    elif mode == "voices":
        write_voices()
    elif mode == "srt":
        write_srt()
    else:
        print("modes: svgs | voices | srt")

if __name__ == "__main__":
    main()
