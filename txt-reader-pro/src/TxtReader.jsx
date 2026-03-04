import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ═══════════════════════════════════════════════════════════════
//  TOAST — Fixed: proper 3.5s timeout with slide-out animation
// ═══════════════════════════════════════════════════════════════
function Toast({ message, type, onClose }) {
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const t1 = setTimeout(() => setLeaving(true), 3000);
    const t2 = setTimeout(onClose, 3500);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [onClose]);

  const cfg = {
    success: { icon: "✓", accent: "#22c55e", bg: "#0d1f17" },
    error:   { icon: "✕", accent: "#ef4444", bg: "#1f0d0d" },
    warning: { icon: "⚠", accent: "#f59e0b", bg: "#1f1708" },
    info:    { icon: "i", accent: "#3b82f6", bg: "#0d1426" },
  }[type] || { icon: "·", accent: "#64748b", bg: "#111" };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      background: cfg.bg, color: "#f1f5f9",
      border: `1px solid ${cfg.accent}33`,
      borderLeft: `3px solid ${cfg.accent}`,
      borderRadius: 10, padding: "10px 14px",
      boxShadow: "0 8px 32px rgba(0,0,0,.5)",
      fontSize: 13, maxWidth: 320,
      opacity: leaving ? 0 : 1,
      transform: leaving ? "translateX(20px)" : "translateX(0)",
      transition: "opacity .4s, transform .4s",
    }}>
      <span style={{
        width: 20, height: 20, borderRadius: 5,
        background: `${cfg.accent}20`, color: cfg.accent,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 10, fontWeight: 800, flexShrink: 0
      }}>{cfg.icon}</span>
      <span style={{ flex: 1, lineHeight: 1.4 }}>{message}</span>
      <button onClick={() => { setLeaving(true); setTimeout(onClose, 400); }}
        style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: 0 }}>×</button>
    </div>
  );
}

function ToastStack({ toasts, remove }) {
  return (
    <div style={{
      position: "fixed", bottom: 80, right: 16, zIndex: 9999,
      display: "flex", flexDirection: "column", gap: 8,
      pointerEvents: "none", alignItems: "flex-end"
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{ pointerEvents: "all", animation: "toastIn .3s cubic-bezier(.2,1,.3,1)" }}>
          <Toast message={t.msg} type={t.type} onClose={() => remove(t.id)} />
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  GEMINI API
// ═══════════════════════════════════════════════════════════════
async function callGemini(apiKey, prompt, system = "") {
  if (!apiKey?.startsWith("AIza")) throw new Error("Invalid API key — must start with AIza");
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 30000);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal }
  );
  clearTimeout(tid);
  if (!res.ok) { const e = await res.json().catch(() => {}); throw new Error(e?.error?.message || `HTTP ${res.status}`); }
  const data = await res.json();
  if (!data.candidates?.length) throw new Error("Empty response from Gemini");
  return data.candidates[0].content.parts[0].text || "";
}

async function callGeminiJSON(apiKey, prompt, onErr) {
  const raw = await callGemini(apiKey, prompt,
    "Respond ONLY with a valid JSON object. No markdown fences, no backticks, no prose before or after. Pure JSON only."
  ).catch(e => { onErr?.(e.message); return null; });
  if (!raw) return null;
  try {
    const clean = raw.replace(/^```json\s*/gi, "").replace(/```\s*$/gi, "").replace(/[\u201C\u201D]/g, '"').trim();
    return JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch { onErr?.("Couldn't parse AI response — try again."); return null; }
}

// ═══════════════════════════════════════════════════════════════
//  PARSER — converts raw text into structured blocks
// ═══════════════════════════════════════════════════════════════
function parseDoc(raw) {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\\n/g, "\n").replace(/\n{3,}/g, "\n\n").split("\n");
  const blocks = []; let id = 0; let i = 0;
  while (i < lines.length) {
    const line = lines[i], t = line.trim();
    if (!t) { i++; continue; }
    // Chapter / part headers
    if (/^(chapter|part|prologue|epilogue|act)\s*[\dIVX:.\-]/i.test(t) || /^chapter\s+\d+/i.test(t)) {
      blocks.push({ id: ++id, type: "chapter", text: t }); i++; continue;
    }
    if (/^#\s/.test(t))   { blocks.push({ id: ++id, type: "h1", text: t.replace(/^#+\s/, "") }); i++; continue; }
    if (/^##\s/.test(t))  { blocks.push({ id: ++id, type: "h2", text: t.replace(/^#+\s/, "") }); i++; continue; }
    if (/^###\s/.test(t)) { blocks.push({ id: ++id, type: "h3", text: t.replace(/^#+\s/, "") }); i++; continue; }
    // All-caps headings
    if (t === t.toUpperCase() && t.length > 3 && t.length < 80 && /[A-Z]/.test(t) && !/[.?,;:]$/.test(t) && t.split(/\s+/).length < 10)
      { blocks.push({ id: ++id, type: "heading", text: t }); i++; continue; }
    if (/^[-=*_~]{3,}$/.test(t)) { blocks.push({ id: ++id, type: "divider" }); i++; continue; }
    // Quotes
    if (/^[>❝""'']/.test(t)) {
      const ql = [];
      while (i < lines.length && lines[i].trim() && /^[>❝""'']/.test(lines[i].trim())) { ql.push(lines[i].trim().replace(/^[>❝""'']\s*/, "")); i++; }
      blocks.push({ id: ++id, type: "quote", text: ql.join(" ") }); continue;
    }
    // Code blocks
    if (/^```/.test(t)) {
      const cl = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { cl.push(lines[i]); i++; }
      i++; blocks.push({ id: ++id, type: "code", text: cl.join("\n") }); continue;
    }
    // Lists
    if (/^[\s]*[-*•]\s/.test(line) || /^[\s]*\d+[.)]\s/.test(line)) {
      const items = [], ordered = /^[\s]*\d+[.)]\s/.test(line);
      while (i < lines.length && lines[i].trim() && (/^[\s]*[-*•]\s/.test(lines[i]) || /^[\s]*\d+[.)]\s/.test(lines[i])))
        { items.push(lines[i].trim().replace(/^[-*•]\s+/, "").replace(/^\d+[.)]\s+/, "")); i++; }
      blocks.push({ id: ++id, type: "list", items, ordered }); continue;
    }
    // Paragraphs
    const pl = [];
    while (i < lines.length) {
      const c = lines[i].trim(); if (!c) { i++; break; }
      if (/^(chapter|part)/i.test(c) || /^#+\s/.test(c) || /^```/.test(c) || /^[-=*_~]{3,}$/.test(c)) break;
      pl.push(c); i++;
    }
    if (pl.length) {
      const poetry = pl.length > 3 && pl.every(l => l.length < 40) && !pl.join(" ").match(/[.!?]$/);
      blocks.push({ id: ++id, type: poetry ? "poetry" : "paragraph", text: pl.join(poetry ? "\n" : " ") });
    }
  }
  return blocks;
}

// ═══════════════════════════════════════════════════════════════
//  STATS
// ═══════════════════════════════════════════════════════════════
const STOPS = new Set("the be to of and a in that have it for on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us".split(" "));
function computeStats(raw, blocks) {
  const words = raw.match(/\b\w+\b/g) || [];
  const sentences = (raw.match(/[^.!?]+[.!?]+/g) || []).filter(s => s.trim().length > 5);
  const freq = {};
  words.forEach(w => { const l = w.toLowerCase(); if (l.length > 3 && !STOPS.has(l) && !/^\d+$/.test(l)) freq[l] = (freq[l] || 0) + 1; });
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 15);
  const unique = new Set(words.map(w => w.toLowerCase())).size;
  return {
    wordCount: words.length, charCount: raw.length,
    sentenceCount: sentences.length,
    paragraphCount: blocks.filter(b => ["paragraph", "poetry"].includes(b.type)).length,
    chapterCount: blocks.filter(b => b.type === "chapter").length,
    readingTime: Math.max(1, Math.ceil(words.length / 238)),
    avgSentLen: sentences.length ? Math.round(words.length / sentences.length) : 0,
    unique, lexDiv: words.length ? Math.round(unique / words.length * 100) : 0,
    topWords
  };
}

// ═══════════════════════════════════════════════════════════════
//  THEMES — 7 themes
// ═══════════════════════════════════════════════════════════════
const THEMES = {
  obsidian: {
    name: "Obsidian", emoji: "🌑",
    bg: "#0a0a0f", surface: "#13131a", surface2: "#1c1c26", surface3: "#252530",
    text: "#e2e0f0", text2: "#8b87a8", text3: "#4a4760",
    accent: "#7c6af7", accentBg: "#16153a", accentText: "#a89ef9",
    border: "#252530", shadow: "rgba(0,0,0,.7)",
    heading: "#f0eeff", code: "#0f0f18", quote: "#7c6af7",
  },
  ivory: {
    name: "Ivory", emoji: "☀️",
    bg: "#F6F1E9", surface: "#FFFDF8", surface2: "#EDE7DA", surface3: "#E0D9CC",
    text: "#1C1610", text2: "#5C4F3D", text3: "#9C8B78",
    accent: "#B84A1A", accentBg: "#FDF0E8", accentText: "#B84A1A",
    border: "#D9D0C0", shadow: "rgba(28,22,16,.10)",
    heading: "#120E08", code: "#EDE7DA", quote: "#B84A1A",
  },
  ink: {
    name: "Ink", emoji: "🖋",
    bg: "#0F0E0D", surface: "#171614", surface2: "#201E1C", surface3: "#2C2926",
    text: "#E8E0D4", text2: "#9A8E80", text3: "#5A524A",
    accent: "#D4A24A", accentBg: "#1E1800", accentText: "#D4A24A",
    border: "#2C2926", shadow: "rgba(0,0,0,.6)",
    heading: "#F0E8D8", code: "#161412", quote: "#D4A24A",
  },
  dusk: {
    name: "Dusk", emoji: "🌆",
    bg: "#16142A", surface: "#1E1C34", surface2: "#272540", surface3: "#32304E",
    text: "#DDD8F4", text2: "#8880AA", text3: "#524C70",
    accent: "#9B7EF0", accentBg: "#1C1840", accentText: "#C4B5FD",
    border: "#32304E", shadow: "rgba(0,0,0,.55)",
    heading: "#EAE6FF", code: "#131128", quote: "#9B7EF0",
  },
  sage: {
    name: "Sage", emoji: "🌿",
    bg: "#EEF4E8", surface: "#F8FCF4", surface2: "#DFECd6", surface3: "#CDE0C4",
    text: "#182818", text2: "#42603E", text3: "#789670",
    accent: "#2E6E2E", accentBg: "#D4EDD4", accentText: "#2E6E2E",
    border: "#C4D8BC", shadow: "rgba(0,40,0,.09)",
    heading: "#101C10", code: "#DFECd6", quote: "#2E6E2E",
  },
  sepia: {
    name: "Sepia", emoji: "📜",
    bg: "#F2E8D4", surface: "#FAF3E4", surface2: "#E8DAC4", surface3: "#D8C8AA",
    text: "#3C2C1C", text2: "#6A4C34", text3: "#9A7A62",
    accent: "#9E4820", accentBg: "#F4DFD2", accentText: "#9E4820",
    border: "#CCC0A8", shadow: "rgba(60,44,28,.12)",
    heading: "#281808", code: "#E8DAC4", quote: "#9E4820",
  },
  slate: {
    name: "Slate", emoji: "🪨",
    bg: "#EEF1F6", surface: "#FFFFFF", surface2: "#E2E8F0", surface3: "#D0D8E4",
    text: "#1A2030", text2: "#526078", text3: "#90A0B0",
    accent: "#2255CC", accentBg: "#EEF3FF", accentText: "#2255CC",
    border: "#D0D8E4", shadow: "rgba(20,32,56,.10)",
    heading: "#0F1620", code: "#EEF1F6", quote: "#2255CC",
  },
};

const FONTS = [
  { n: "Lora",         css: "'Lora', Georgia, serif",                  import: "Lora:ital,wght@0,400;0,600;0,700;1,400;1,600" },
  { n: "Merriweather", css: "'Merriweather', Georgia, serif",           import: "Merriweather:ital,wght@0,300;0,400;0,700;1,400" },
  { n: "Crimson",      css: "'Crimson Text', Georgia, serif",           import: "Crimson+Text:ital,wght@0,400;0,600;1,400" },
  { n: "Georgia",      css: "Georgia, 'Times New Roman', serif",        import: null },
  { n: "Inter",        css: "'Inter', system-ui, sans-serif",           import: "Inter:wght@400;500;600;700" },
  { n: "Atkinson",     css: "'Atkinson Hyperlegible', sans-serif",      import: "Atkinson+Hyperlegible:wght@400;700" },
  { n: "Source Serif", css: "'Source Serif 4', Georgia, serif",         import: "Source+Serif+4:ital,wght@0,400;0,600;1,400" },
  { n: "Mono",         css: "'Courier New', Courier, monospace",        import: null },
];

const HLC = [
  { id: "amber",  bg: "#FEF08A", br: "#CA8A04", label: "Yellow" },
  { id: "lime",   bg: "#BBF7D0", br: "#16A34A", label: "Green" },
  { id: "sky",    bg: "#BAE6FD", br: "#0284C7", label: "Blue" },
  { id: "rose",   bg: "#FECDD3", br: "#E11D48", label: "Pink" },
  { id: "violet", bg: "#DDD6FE", br: "#7C3AED", label: "Purple" },
  { id: "orange", bg: "#FED7AA", br: "#EA580C", label: "Orange" },
];

// ═══════════════════════════════════════════════════════════════
//  CSS INJECTION
// ═══════════════════════════════════════════════════════════════
function injectStyles(theme, fontCss) {
  let el = document.getElementById("txr-styles");
  if (!el) { el = document.createElement("style"); el.id = "txr-styles"; document.head.appendChild(el); }

  const fontImports = FONTS.filter(f => f.import).map(f =>
    `@import url('https://fonts.googleapis.com/css2?family=${f.import}&display=swap');`
  ).join("\n");

  el.textContent = `
${fontImports}

:root {
  --bg:${theme.bg}; --surface:${theme.surface}; --surface2:${theme.surface2}; --surface3:${theme.surface3};
  --text:${theme.text}; --text2:${theme.text2}; --text3:${theme.text3};
  --accent:${theme.accent}; --accentBg:${theme.accentBg}; --accentText:${theme.accentText};
  --border:${theme.border}; --shadow:${theme.shadow};
  --heading:${theme.heading}; --code:${theme.code}; --quote:${theme.quote};
  --font:${fontCss};
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; background: var(--bg); color: var(--text); font-family: var(--font); -webkit-font-smoothing: antialiased; }
::-webkit-scrollbar { width: 4px; height: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 99px; }

@keyframes fadeUp    { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
@keyframes fadeIn    { from{opacity:0} to{opacity:1} }
@keyframes slideL    { from{transform:translateX(-100%)} to{transform:translateX(0)} }
@keyframes slideR    { from{transform:translateX(100%)} to{transform:translateX(0)} }
@keyframes slideDown { from{transform:translateY(-8px);opacity:0} to{transform:translateY(0);opacity:1} }
@keyframes scaleIn   { from{opacity:0;transform:scale(.95)} to{opacity:1;transform:scale(1)} }
@keyframes spin      { to{transform:rotate(360deg)} }
@keyframes blink     { 0%,100%{opacity:1} 50%{opacity:.3} }
@keyframes toastIn   { from{opacity:0;transform:translateX(20px)} to{opacity:1;transform:translateX(0)} }
@keyframes pulseRing { 0%{box-shadow:0 0 0 0 var(--accent)44} 70%{box-shadow:0 0 0 8px transparent} 100%{box-shadow:0 0 0 0 transparent} }

.fu   { animation: fadeUp .35s cubic-bezier(.2,1,.3,1) both; }
.fi   { animation: fadeIn .25s ease both; }
.spin { animation: spin .8s linear infinite; }
.blnk { animation: blink 1.4s ease infinite; }

/* ══════════════════════════════════════
   HOME
══════════════════════════════════════ */
.home {
  min-height: 100vh; min-height: 100dvh;
  overflow-y: auto; background: var(--bg);
}
.home-wrap {
  max-width: 620px; margin: 0 auto;
  padding: 56px 24px 100px;
  display: flex; flex-direction: column; align-items: center;
}
.home-logo {
  display: flex; align-items: center; gap: 12px;
  margin-bottom: 36px;
  animation: fadeUp .5s .05s both;
}
.home-logo-icon {
  width: 52px; height: 52px; border-radius: 16px;
  background: linear-gradient(135deg, var(--accent), var(--accentBg));
  display: flex; align-items: center; justify-content: center;
  font-size: 26px;
  box-shadow: 0 8px 24px var(--shadow);
}
.home-logo-text { font-size: 24px; font-weight: 800; color: var(--heading); letter-spacing: -0.5px; }
.home-logo-badge { background: var(--accent); color: #fff; font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 99px; margin-top: 2px; }

.home-h1 {
  font-size: clamp(28px, 6vw, 48px); font-weight: 800; line-height: 1.1;
  color: var(--heading); letter-spacing: -1.5px; text-align: center;
  margin-bottom: 14px; animation: fadeUp .5s .12s both;
}
.home-sub {
  font-size: clamp(13px, 2.5vw, 16px); color: var(--text2); line-height: 1.7;
  text-align: center; max-width: 480px; margin-bottom: 36px;
  animation: fadeUp .5s .18s both;
}

.drop-zone {
  width: 100%; border: 2px dashed var(--border);
  background: var(--surface); border-radius: 20px;
  padding: clamp(28px,5vw,52px) 24px;
  cursor: pointer; transition: all .22s; margin-bottom: 20px;
  text-align: center; animation: fadeUp .5s .22s both;
}
.drop-zone:hover, .drop-zone.drag {
  border-color: var(--accent); background: var(--accentBg);
  transform: scale(1.01);
}

.feat-grid {
  width: 100%; display: grid;
  grid-template-columns: repeat(auto-fill, minmax(90px, 1fr));
  gap: 8px; margin-bottom: 24px;
  animation: fadeUp .5s .28s both;
}
.feat-item {
  background: var(--surface); border: 1.5px solid var(--border);
  border-radius: 12px; padding: 12px 8px; text-align: center;
  transition: all .15s; cursor: default;
}
.feat-item:hover { border-color: var(--accent); background: var(--accentBg); transform: translateY(-2px); }

.theme-strip {
  display: flex; gap: 8px; flex-wrap: wrap; justify-content: center;
  animation: fadeUp .5s .32s both; margin-bottom: 20px;
}
.theme-dot {
  width: 36px; height: 36px; border-radius: 10px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; transition: all .18s; border: 2.5px solid transparent;
}
.theme-dot.active { transform: scale(1.15); box-shadow: 0 0 0 3px var(--accent)44; }

.key-card {
  width: 100%; background: var(--surface); border: 1.5px solid var(--border);
  border-radius: 16px; padding: 16px 20px; margin-bottom: 20px;
  animation: fadeUp .5s .26s both;
}

/* ══════════════════════════════════════
   APP SHELL
══════════════════════════════════════ */
.app { height: 100vh; height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }

/* Progress bar */
.pbar { position: fixed; top: 0; left: 0; right: 0; height: 2px; z-index: 9999; pointer-events: none; }
.pbar-fill { height: 100%; background: var(--accent); transition: width .3s ease; box-shadow: 0 0 8px var(--accent); }

/* ══════════════════════════════════════
   NAVBAR — REDESIGNED
══════════════════════════════════════ */
.navbar {
  flex-shrink: 0; position: relative; z-index: 400;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  box-shadow: 0 1px 0 var(--border), 0 2px 16px var(--shadow);
}

/* Desktop — 3 zone layout */
.nav-desktop {
  display: grid;
  grid-template-columns: minmax(0,1fr) auto minmax(0,1fr);
  align-items: center; height: 56px;
  padding: 0 16px; gap: 12px;
}
.nav-zone { display: flex; align-items: center; gap: 6px; }
.nav-zone-left  { justify-content: flex-start; }
.nav-zone-mid   { justify-content: center; flex-shrink: 0; }
.nav-zone-right { justify-content: flex-end; }

/* Nav icon button */
.nb {
  height: 34px; min-width: 34px; border-radius: 9px;
  border: 1px solid transparent; background: transparent;
  color: var(--text2); cursor: pointer; font-size: 15px;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  transition: all .14s; flex-shrink: 0; padding: 0 8px;
  font-family: var(--font); font-weight: 500;
  -webkit-tap-highlight-color: transparent;
}
.nb:hover  { background: var(--surface2); color: var(--text); border-color: var(--border); }
.nb.on     { background: var(--accentBg); color: var(--accent); border-color: var(--accent)44; }
.nb:active { transform: scale(.91); }
.nb-label  { font-size: 11px; font-weight: 600; }

/* Separator */
.nsep { width: 1px; height: 20px; background: var(--border); margin: 0 2px; flex-shrink: 0; }

/* File pill */
.file-pill {
  display: flex; align-items: center; gap: 8px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 10px; padding: 5px 12px; min-width: 0; max-width: 220px;
  cursor: default;
}
.file-pill-name {
  font-weight: 700; font-size: 12px; color: var(--heading);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.file-pill-meta { font-size: 10px; color: var(--text3); display: flex; gap: 5px; white-space: nowrap; margin-top: 1px; }

/* Inline search */
.nav-search { position: relative; width: 220px; }
.nav-search input {
  width: 100%; height: 34px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 99px; padding: 0 32px 0 34px;
  color: var(--text); font-size: 12px; font-family: var(--font);
  outline: none; transition: all .2s;
}
.nav-search input:focus { border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px var(--accentBg); }
.nav-search input::placeholder { color: var(--text3); }
.ns-ico { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text3); font-size: 12px; pointer-events: none; }
.ns-clear { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); background: none; border: none; color: var(--text3); cursor: pointer; font-size: 15px; line-height: 1; padding: 2px; border-radius: 99px; display: flex; align-items: center; }
.ns-clear:hover { color: var(--text); background: var(--surface3); }

/* Search hit badge */
.search-badge {
  position: absolute; right: 32px; top: 50%; transform: translateY(-50%);
  background: var(--accent); color: #fff; font-size: 9px; font-weight: 700;
  padding: 2px 6px; border-radius: 99px; pointer-events: none;
}

/* ── Mobile navbar ── */
.nav-mobile { display: none; }
.nav-mob-top {
  display: flex; align-items: center; height: 52px;
  padding: 0 12px; gap: 8px;
}
.nav-mob-file { flex: 1; min-width: 0; }
.nav-mob-name { font-weight: 700; font-size: 13px; color: var(--heading); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.nav-mob-meta { font-size: 10px; color: var(--text3); display: flex; gap: 4px; }
.nav-mob-acts { display: flex; gap: 4px; }

.mob-searchbar {
  padding: 6px 12px 10px; border-top: 1px solid var(--border);
  animation: slideDown .2s ease; position: relative;
}
.mob-searchbar input {
  width: 100%; height: 38px;
  background: var(--surface2); border: 1px solid var(--border);
  border-radius: 99px; padding: 0 36px 0 36px;
  color: var(--text); font-size: 13px; font-family: var(--font);
  outline: none;
}
.mob-searchbar input:focus { border-color: var(--accent); }

/* ══════════════════════════════════════
   MOBILE BOTTOM BAR
══════════════════════════════════════ */
.bottom-bar {
  display: none;
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 600;
  background: var(--surface);
  border-top: 1px solid var(--border);
  box-shadow: 0 -4px 24px var(--shadow);
  padding-bottom: env(safe-area-inset-bottom, 0);
}
.bb-inner {
  display: flex; align-items: center; justify-content: space-around;
  height: 58px; max-width: 480px; margin: 0 auto; padding: 0 4px;
}
.bb-btn {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px; flex: 1; height: 100%; cursor: pointer;
  background: none; border: none; color: var(--text3);
  font-family: var(--font); font-size: 9px; font-weight: 700; letter-spacing: .3px;
  transition: all .14s; padding: 6px 2px; border-radius: 12px;
  -webkit-tap-highlight-color: transparent; text-transform: uppercase;
}
.bb-btn .bb-ico { font-size: 19px; line-height: 1; transition: all .14s; }
.bb-btn.on { color: var(--accent); }
.bb-btn.on .bb-ico { transform: scale(1.1); }

/* ══════════════════════════════════════
   PANEL (side panel — left)
══════════════════════════════════════ */
.panel-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,.5);
  z-index: 700; backdrop-filter: blur(3px);
  animation: fadeIn .2s ease;
}
.side-panel {
  position: fixed; top: 0; left: 0; bottom: 0;
  width: min(320px, 90vw);
  background: var(--surface); border-right: 1px solid var(--border);
  z-index: 800; display: flex; flex-direction: column;
  box-shadow: 6px 0 40px var(--shadow);
  animation: slideL .28s cubic-bezier(.2,1,.3,1);
}

/* Panel header — with CLOSE X always visible */
.sp-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 14px 16px; border-bottom: 1px solid var(--border); flex-shrink: 0;
  background: var(--surface); position: sticky; top: 0; z-index: 2;
}
.sp-title { font-weight: 800; font-size: 14px; color: var(--heading); display: flex; align-items: center; gap: 7px; }
.sp-close {
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--border);
  background: var(--surface2); color: var(--text2); cursor: pointer; font-size: 16px;
  display: flex; align-items: center; justify-content: center; transition: all .13s;
  flex-shrink: 0;
}
.sp-close:hover { background: var(--surface3); color: var(--text); border-color: var(--text3); }
.sp-body { flex: 1; overflow-y: auto; padding: 14px; -webkit-overflow-scrolling: touch; }

/* Desktop inline panel */
.inline-panel {
  width: 290px; flex-shrink: 0;
  background: var(--surface); border-right: 1px solid var(--border);
  display: flex; flex-direction: column;
  animation: slideL .25s cubic-bezier(.2,1,.3,1);
  overflow: hidden;
}
.inline-panel .sp-head { position: sticky; top: 0; }
.inline-panel .sp-body { padding: 14px; }

/* ══════════════════════════════════════
   READER
══════════════════════════════════════ */
.app-body { flex: 1; display: flex; overflow: hidden; }
.reader-area { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; scroll-behavior: smooth; }
.reader-content {
  max-width: var(--col-w, 680px); margin: 0 auto;
  padding: 48px 24px 100px;
}

/* Focus mode */
.focus .navbar { opacity: .15; transition: opacity .4s; }
.focus .navbar:hover { opacity: 1; }
.focus .inline-panel { display: none !important; }
.focus .reader-content { max-width: min(600px, 90vw); }

/* ── Text blocks ── */
.para {
  position: relative; padding: 5px 48px 5px 14px;
  margin: 0 0 22px -14px; border-radius: 10px;
  border-left: 3px solid transparent; transition: background .15s, border-left-color .15s;
  cursor: default;
}
.para:hover { background: var(--surface2); }
.para.hl-amber  { background: #FEF08A1a; border-left-color: #CA8A04; }
.para.hl-lime   { background: #BBF7D01a; border-left-color: #16A34A; }
.para.hl-sky    { background: #BAE6FD1a; border-left-color: #0284C7; }
.para.hl-rose   { background: #FECDD31a; border-left-color: #E11D48; }
.para.hl-violet { background: #DDD6FE1a; border-left-color: #7C3AED; }
.para.hl-orange { background: #FED7AA1a; border-left-color: #EA580C; }

.para-acts {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  display: flex; gap: 3px; opacity: 0; pointer-events: none; transition: opacity .15s;
}
.para:hover .para-acts { opacity: 1; pointer-events: all; }

.pa {
  width: 26px; height: 26px; border-radius: 7px; border: 1px solid var(--border);
  background: var(--surface); color: var(--text2); cursor: pointer; font-size: 11px;
  display: flex; align-items: center; justify-content: center; transition: all .12s;
}
.pa:hover { background: var(--surface3); color: var(--text); }
.pa.on { background: var(--accent); color: #fff; border-color: var(--accent); }

/* Chapter */
.chapter-block { margin: 72px 0 28px; text-align: center; }
.ch-label { font-size: 9px; font-weight: 800; color: var(--accent); text-transform: uppercase; letter-spacing: 5px; margin-bottom: 12px; }
.ch-title { font-size: clamp(22px, 5vw, 34px); font-weight: 800; color: var(--heading); line-height: 1.2; }
.ch-rule  { width: 40px; height: 2px; background: var(--accent); border-radius: 99px; margin: 14px auto 0; }

/* Quote */
.block-quote {
  margin: 24px 0; padding: 18px 22px;
  border-left: 3px solid var(--quote); background: var(--accentBg);
  border-radius: 0 14px 14px 0; position: relative;
}
.block-quote p { font-style: italic; line-height: 1.85; }

/* Code */
.block-code {
  margin: 20px 0; padding: 16px 18px;
  background: var(--code); border: 1px solid var(--border);
  border-radius: 12px; font-size: 13px; line-height: 1.6;
  font-family: 'Courier New', monospace; overflow-x: auto;
  white-space: pre-wrap; word-break: break-word;
}

/* List */
.block-list { margin: 14px 0; }
.list-item { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 10px; line-height: 1.7; }
.list-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--accent); flex-shrink: 0; margin-top: 11px; }
.list-num { min-width: 20px; font-weight: 700; color: var(--accent); flex-shrink: 0; margin-top: 1px; font-size: .9em; }

/* Divider */
.block-div { margin: 44px 0; display: flex; align-items: center; gap: 14px; }
.div-line { flex: 1; height: 1px; background: var(--border); }
.div-mid { color: var(--text3); font-size: 14px; letter-spacing: 8px; }

/* Search highlight */
.shl { background: var(--accentBg); color: var(--accent); border-radius: 3px; padding: 1px 3px; font-weight: 700; }

/* ── Panel components ── */
.toc-row {
  display: block; width: 100%; text-align: left; background: transparent; border: none;
  padding: 8px 12px; cursor: pointer; color: var(--text2); font-size: 12px; font-family: var(--font);
  line-height: 1.45; border-left: 2px solid transparent; transition: all .13s; border-radius: 0 8px 8px 0;
}
.toc-row:hover { background: var(--surface2); color: var(--text); border-left-color: var(--accent); }

/* Stat cards */
.stat-grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 14px; }
.stat-c { background: var(--surface2); border-radius: 10px; padding: 11px 13px; }
.stat-k { font-size: 9px; color: var(--text3); text-transform: uppercase; letter-spacing: .8px; margin-bottom: 4px; font-weight: 700; }
.stat-v { font-size: 19px; font-weight: 800; color: var(--heading); line-height: 1.2; }

.chip { display: inline-flex; align-items: center; padding: 3px 9px; border-radius: 99px; font-size: 10px; font-weight: 700; background: var(--accentBg); color: var(--accentText); margin: 2px; }

/* AI section tabs */
.ai-tabs { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 12px; }
.ai-tab {
  padding: 5px 11px; border-radius: 99px; border: none; font-size: 11px; font-weight: 700;
  cursor: pointer; font-family: var(--font); transition: all .14s; letter-spacing: .2px;
}

/* Buttons */
.btn { border: none; border-radius: 10px; padding: 10px 16px; font-weight: 700; font-size: 13px; cursor: pointer; font-family: var(--font); transition: all .15s; display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.btn-p { background: var(--accent); color: #fff; }
.btn-p:hover { opacity: .88; transform: translateY(-1px); }
.btn-p:disabled { opacity: .4; cursor: not-allowed; transform: none; }
.btn-s { background: var(--surface2); color: var(--text); border: 1px solid var(--border); }
.btn-s:hover { background: var(--surface3); }
.btn-s:active { transform: scale(.97); }
.btn-sm { padding: 7px 12px; font-size: 12px; border-radius: 8px; }

/* Inputs */
.inp { width: 100%; background: var(--surface2); border: 1px solid var(--border); border-radius: 10px; padding: 10px 13px; color: var(--text); font-size: 13px; outline: none; font-family: var(--font); transition: all .18s; }
.inp:focus { border-color: var(--accent); background: var(--surface); box-shadow: 0 0 0 3px var(--accentBg); }
textarea.inp { resize: vertical; min-height: 90px; line-height: 1.6; }

/* Modal */
.modal-ov { position: fixed; inset: 0; background: rgba(0,0,0,.55); backdrop-filter: blur(4px); z-index: 9000; display: flex; align-items: center; justify-content: center; padding: 20px; animation: fadeIn .2s ease; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 24px; width: 100%; max-width: 460px; box-shadow: 0 28px 60px var(--shadow); animation: scaleIn .28s cubic-bezier(.2,1,.3,1); }
.modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; }
.modal-title { font-size: 16px; font-weight: 800; color: var(--heading); }

/* Selection popup */
.sel-pop {
  position: fixed; z-index: 9500; background: var(--surface); border: 1px solid var(--border);
  border-radius: 12px; padding: 5px 7px; display: flex; gap: 3px;
  box-shadow: 0 8px 32px var(--shadow); animation: fadeUp .18s ease;
  transform: translateX(-50%);
}
.sel-btn { padding: 5px 10px; border-radius: 7px; border: none; background: var(--surface2); color: var(--text); font-size: 11px; font-weight: 700; cursor: pointer; font-family: var(--font); transition: all .13s; }
.sel-btn:hover { background: var(--accent); color: #fff; }

/* Highlight picker */
.hl-picker { display: flex; gap: 5px; align-items: center; background: var(--surface); border: 1px solid var(--border); border-radius: 99px; padding: 5px 10px; box-shadow: 0 6px 24px var(--shadow); }
.hl-dot { width: 24px; height: 24px; border-radius: 7px; cursor: pointer; border: 2.5px solid transparent; transition: all .14s; }
.hl-dot.sel { border-color: var(--text); transform: scale(1.14); }

/* Chat */
.chat-u { background: var(--accent); color: #fff; border-radius: 16px 16px 4px 16px; padding: 9px 13px; font-size: 13px; max-width: 90%; align-self: flex-end; line-height: 1.5; word-break: break-word; }
.chat-b { background: var(--surface2); color: var(--text); border-radius: 16px 16px 16px 4px; padding: 9px 13px; font-size: 13px; max-width: 90%; align-self: flex-start; line-height: 1.5; word-break: break-word; }

/* Pomodoro */
.pomo-circle {
  width: 90px; height: 90px; border-radius: 50%;
  border: 3px solid var(--border); position: relative;
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 12px;
}
.pomo-svg { position: absolute; inset: -3px; transform: rotate(-90deg); }

/* Progress bar (reading) */
.read-prog { background: var(--surface2); border-radius: 999px; height: 6px; overflow: hidden; margin-bottom: 5px; }
.read-prog-fill { height: 100%; background: var(--accent); border-radius: 999px; transition: width .4s; }

/* Annotation export button */
.export-row { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 10px; }

/* ══════════════════════════════════════
   RESPONSIVE
══════════════════════════════════════ */
@media (max-width: 860px) {
  .nav-desktop  { display: none; }
  .nav-mobile   { display: block; }
  .bottom-bar   { display: block; }
  .reader-area  { padding-bottom: 72px; }
  .inline-panel { display: none !important; }
  .home-wrap    { padding: 32px 16px 100px; }
}

@media (max-width: 480px) {
  .reader-content { padding: 24px 14px 80px; }
  .home-wrap { padding: 24px 14px 100px; }
  .para { padding: 5px 44px 5px 10px; margin-left: -10px; }
  .para-acts { opacity: 1; pointer-events: all; }
  .modal { padding: 18px; }
}

@media print {
  .navbar, .inline-panel, .bottom-bar, .pbar, .para-acts { display: none !important; }
  .reader-area { overflow: visible; padding: 0; }
  .reader-content { max-width: 100%; padding: 0; }
}
  `;
}

// ═══════════════════════════════════════════════════════════════
//  CHAT BOT MESSAGE RENDERER
// ═══════════════════════════════════════════════════════════════
function BotMessage({ text }) {
  const lines = text.split("\n");
  const render = (txt) => txt.split(/(\*\*[^*]+\*\*)/g).map((p, j) =>
    p.startsWith("**") && p.endsWith("**") ? <strong key={j}>{p.slice(2, -2)}</strong> : p
  );
  return (
    <div style={{ fontSize: 13, lineHeight: 1.6 }}>
      {lines.map((line, i) => {
        if (!line.trim()) return <div key={i} style={{ height: 5 }} />;
        if (/^#+\s/.test(line)) return <div key={i} style={{ fontWeight: 800, marginBottom: 4, marginTop: i > 0 ? 8 : 0, color: "var(--heading)", fontSize: 13 }}>{line.replace(/^#+\s/, "")}</div>;
        if (/^[-*•]\s/.test(line.trim())) return (
          <div key={i} style={{ display: "flex", gap: 7, marginBottom: 3, alignItems: "flex-start" }}>
            <span style={{ color: "var(--accent)", fontWeight: 800, flexShrink: 0, marginTop: 2, fontSize: 10 }}>●</span>
            <span>{render(line.trim().replace(/^[-*•]\s/, ""))}</span>
          </div>
        );
        if (/^\d+[.)]\s/.test(line.trim())) {
          const [, n, rest] = line.trim().match(/^(\d+)[.)]\s(.*)/) || [];
          return (
            <div key={i} style={{ display: "flex", gap: 7, marginBottom: 3, alignItems: "flex-start" }}>
              <span style={{ color: "var(--accent)", fontWeight: 800, flexShrink: 0, minWidth: 16, fontSize: 11 }}>{n}.</span>
              <span>{render(rest || line)}</span>
            </div>
          );
        }
        return <p key={i} style={{ margin: "0 0 5px" }}>{render(line)}</p>;
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  DOWNLOAD HELPER
// ═══════════════════════════════════════════════════════════════
function dl(name, content, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

// ═══════════════════════════════════════════════════════════════
//  POMODORO TIMER PANEL
// ═══════════════════════════════════════════════════════════════
function PomodoroPanel() {
  const [mode, setMode] = useState("work"); // work | break | longbreak
  const DURATIONS = { work: 25 * 60, break: 5 * 60, longbreak: 15 * 60 };
  const [timeLeft, setTimeLeft] = useState(DURATIONS.work);
  const [running, setRunning] = useState(false);
  const [sessions, setSessions] = useState(0);
  const intervalRef = useRef(null);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setTimeLeft(t => {
          if (t <= 1) {
            clearInterval(intervalRef.current);
            setRunning(false);
            setSessions(s => s + 1);
            return 0;
          }
          return t - 1;
        });
      }, 1000);
    } else clearInterval(intervalRef.current);
    return () => clearInterval(intervalRef.current);
  }, [running]);

  const switchMode = (m) => { setMode(m); setTimeLeft(DURATIONS[m]); setRunning(false); };
  const reset = () => { setTimeLeft(DURATIONS[mode]); setRunning(false); };
  const mins = String(Math.floor(timeLeft / 60)).padStart(2, "0");
  const secs = String(timeLeft % 60).padStart(2, "0");
  const total = DURATIONS[mode];
  const pct = ((total - timeLeft) / total) * 100;
  const r = 40; const circ = 2 * Math.PI * r;

  return (
    <div>
      <div style={{ display: "flex", gap: 5, marginBottom: 16 }}>
        {["work", "break", "longbreak"].map(m => (
          <button key={m} className="btn btn-sm" onClick={() => switchMode(m)}
            style={{ flex: 1, background: mode === m ? "var(--accent)" : "var(--surface2)", color: mode === m ? "#fff" : "var(--text2)", border: `1px solid ${mode === m ? "var(--accent)" : "var(--border)"}`, fontSize: 10, padding: "6px 4px" }}>
            {m === "work" ? "Focus" : m === "break" ? "Short" : "Long"}
          </button>
        ))}
      </div>
      <div className="pomo-circle">
        <svg className="pomo-svg" width="96" height="96" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r={r} fill="none" stroke="var(--border)" strokeWidth="3" />
          <circle cx="48" cy="48" r={r} fill="none" stroke="var(--accent)" strokeWidth="3"
            strokeDasharray={circ} strokeDashoffset={circ - (pct / 100) * circ}
            strokeLinecap="round" style={{ transition: "stroke-dashoffset .5s" }} />
        </svg>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--heading)", fontVariantNumeric: "tabular-nums" }}>{mins}:{secs}</div>
          <div style={{ fontSize: 9, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1 }}>{mode}</div>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", marginBottom: 14 }}>
        <button className="btn btn-p btn-sm" onClick={() => setRunning(v => !v)} style={{ minWidth: 70 }}>
          {running ? "⏸ Pause" : "▶ Start"}
        </button>
        <button className="btn btn-s btn-sm" onClick={reset}>↺ Reset</button>
      </div>
      <div style={{ textAlign: "center", fontSize: 11, color: "var(--text3)" }}>
        Sessions completed: <strong style={{ color: "var(--accent)" }}>{sessions}</strong>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  TEXT-TO-SPEECH PANEL
// ═══════════════════════════════════════════════════════════════
function TTSPanel({ blocks, toast }) {
  const [speaking, setSpeaking] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1.0);
  const [pitch, setPitch] = useState(1.0);
  const [voices, setVoices] = useState([]);
  const [voiceIdx, setVoiceIdx] = useState(0);
  const [currentBlock, setCurrentBlock] = useState(0);
  const utterRef = useRef(null);
  const blocksRef = useRef(blocks);
  blocksRef.current = blocks;

  const textBlocks = useMemo(() =>
    blocks.filter(b => b.text && ["paragraph","quote","h1","h2","h3","heading","chapter","poetry"].includes(b.type)),
  [blocks]);

  useEffect(() => {
    const load = () => {
      const v = window.speechSynthesis.getVoices();
      if (v.length) setVoices(v);
    };
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => { window.speechSynthesis.cancel(); };
  }, []);

  const speak = useCallback((idx = 0) => {
    if (!textBlocks.length) return;
    window.speechSynthesis.cancel();
    const sayBlock = (i) => {
      if (i >= textBlocks.length) { setSpeaking(false); setPaused(false); setCurrentBlock(0); return; }
      setCurrentBlock(i);
      const u = new SpeechSynthesisUtterance(textBlocks[i].text.replace(/\n/g, " "));
      u.rate = speed; u.pitch = pitch;
      if (voices[voiceIdx]) u.voice = voices[voiceIdx];
      u.onend = () => sayBlock(i + 1);
      u.onerror = () => { setSpeaking(false); setPaused(false); };
      utterRef.current = u;
      window.speechSynthesis.speak(u);
      // Scroll into view
      document.getElementById(`b-${textBlocks[i].id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    setSpeaking(true); setPaused(false);
    sayBlock(idx);
  }, [textBlocks, speed, pitch, voices, voiceIdx]);

  const pause = () => { window.speechSynthesis.pause(); setPaused(true); };
  const resume = () => { window.speechSynthesis.resume(); setPaused(false); };
  const stop = () => { window.speechSynthesis.cancel(); setSpeaking(false); setPaused(false); setCurrentBlock(0); };

  const pct = textBlocks.length ? Math.round(currentBlock / textBlocks.length * 100) : 0;

  return (
    <div>
      {/* Voice selector */}
      {voices.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Voice</div>
          <select className="inp" value={voiceIdx} onChange={e => setVoiceIdx(Number(e.target.value))} style={{ fontSize: 11 }}>
            {voices.map((v, i) => <option key={i} value={i}>{v.name} ({v.lang})</option>)}
          </select>
        </div>
      )}

      {/* Speed */}
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
          <span style={{ color: "var(--text2)", fontWeight: 600 }}>Speed</span>
          <span style={{ color: "var(--accent)", fontWeight: 800 }}>{speed.toFixed(1)}×</span>
        </div>
        <input type="range" min={0.5} max={2.5} step={0.1} value={speed}
          onChange={e => setSpeed(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "var(--text3)", marginTop: 2 }}>
          <span>0.5×</span><span>1.0×</span><span>1.5×</span><span>2.0×</span><span>2.5×</span>
        </div>
      </div>

      {/* Pitch */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 5 }}>
          <span style={{ color: "var(--text2)", fontWeight: 600 }}>Pitch</span>
          <span style={{ color: "var(--accent)", fontWeight: 800 }}>{pitch.toFixed(1)}</span>
        </div>
        <input type="range" min={0.5} max={2.0} step={0.1} value={pitch}
          onChange={e => setPitch(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }} />
      </div>

      {/* Progress */}
      {speaking && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ background: "var(--surface2)", borderRadius: 999, height: 4, overflow: "hidden", marginBottom: 5 }}>
            <div style={{ height: "100%", width: `${pct}%`, background: "var(--accent)", borderRadius: 999, transition: "width .5s" }} />
          </div>
          <div style={{ fontSize: 10, color: "var(--text3)", display: "flex", justifyContent: "space-between" }}>
            <span>Paragraph {currentBlock + 1} of {textBlocks.length}</span>
            <span>{pct}%</span>
          </div>
          {textBlocks[currentBlock] && (
            <div style={{ marginTop: 8, padding: "8px 10px", background: "var(--accentBg)", borderRadius: 8, fontSize: 11, color: "var(--accentText)", lineHeight: 1.5, borderLeft: "2px solid var(--accent)" }}>
              🔊 "{textBlocks[currentBlock].text.slice(0, 80)}…"
            </div>
          )}
        </div>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 7 }}>
        {!speaking ? (
          <button className="btn btn-p" style={{ flex: 1 }} onClick={() => speak(0)}>▶ Read Aloud</button>
        ) : paused ? (
          <button className="btn btn-p" style={{ flex: 1 }} onClick={resume}>▶ Resume</button>
        ) : (
          <button className="btn btn-p" style={{ flex: 1 }} onClick={pause}>⏸ Pause</button>
        )}
        {speaking && <button className="btn btn-s" onClick={stop}>⏹ Stop</button>}
      </div>

      {speaking && currentBlock > 0 && (
        <button className="btn btn-s" style={{ width: "100%", marginTop: 7, fontSize: 11 }}
          onClick={() => speak(Math.max(0, currentBlock - 1))}>← Previous paragraph</button>
      )}

      <div style={{ marginTop: 12, padding: "8px 10px", background: "var(--surface2)", borderRadius: 8, fontSize: 10, color: "var(--text3)", lineHeight: 1.6 }}>
        💡 TTS uses your browser's built-in voices. Quality varies by browser and OS.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  WORD DEFINITION POPUP
// ═══════════════════════════════════════════════════════════════
function WordDefPopup({ word, x, y, onClose }) {
  const [def, setDef] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!word) return;
    setLoading(true); setError(null); setDef(null);
    fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word.toLowerCase())}`)
      .then(r => r.json())
      .then(data => {
        if (Array.isArray(data) && data[0]) {
          const entry = data[0];
          const meanings = entry.meanings?.slice(0, 2).map(m => ({
            pos: m.partOfSpeech,
            defs: m.definitions?.slice(0, 2).map(d => d.definition),
            synonyms: m.synonyms?.slice(0, 4) || [],
          })) || [];
          const phonetic = entry.phonetic || entry.phonetics?.find(p => p.text)?.text || "";
          setDef({ word: entry.word, phonetic, meanings });
        } else setError("No definition found");
        setLoading(false);
      })
      .catch(() => { setError("Could not fetch definition"); setLoading(false); });
  }, [word]);

  // Clamp position to viewport
  const popX = Math.max(160, Math.min(x, window.innerWidth - 160));
  const popY = Math.max(10, y - 10);

  return (
    <div style={{
      position: "fixed", left: popX, top: popY, zIndex: 9800,
      transform: "translate(-50%, -100%)",
      background: "var(--surface)", border: "1px solid var(--border)",
      borderRadius: 14, padding: "14px 16px", width: 280, maxWidth: "90vw",
      boxShadow: "0 16px 48px var(--shadow)",
      animation: "fadeUp .2s ease",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 8 }}>
        <div>
          <div style={{ fontWeight: 800, fontSize: 16, color: "var(--heading)" }}>{word}</div>
          {def?.phonetic && <div style={{ fontSize: 11, color: "var(--text3)", marginTop: 1 }}>{def.phonetic}</div>}
        </div>
        <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: 0 }}>×</button>
      </div>

      {loading && <div style={{ color: "var(--text3)", fontSize: 12, textAlign: "center", padding: 8 }}>Looking up…</div>}
      {error && <div style={{ color: "var(--text3)", fontSize: 12, textAlign: "center", padding: 8 }}>{error}</div>}
      {def && def.meanings.map((m, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 9, fontWeight: 800, color: "var(--accent)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 5 }}>{m.pos}</div>
          {m.defs.map((d, j) => (
            <div key={j} style={{ fontSize: 12, lineHeight: 1.55, color: "var(--text)", marginBottom: 4, paddingLeft: 8, borderLeft: "2px solid var(--border)" }}>
              {j + 1 > 1 ? `${j + 1}. ` : ""}{d}
            </div>
          ))}
          {m.synonyms.length > 0 && (
            <div style={{ marginTop: 5, display: "flex", gap: 4, flexWrap: "wrap" }}>
              {m.synonyms.map(s => (
                <span key={s} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 99, background: "var(--accentBg)", color: "var(--accentText)", fontWeight: 600 }}>{s}</span>
              ))}
            </div>
          )}
        </div>
      ))}

      {/* tiny caret */}
      <div style={{ position: "absolute", bottom: -7, left: "50%", transform: "translateX(-50%)", width: 12, height: 7, overflow: "hidden" }}>
        <div style={{ width: 12, height: 12, background: "var(--surface)", border: "1px solid var(--border)", transform: "rotate(45deg)", transformOrigin: "top left", marginTop: 4, marginLeft: 1 }} />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  LIBRARY — auto-save & reading history  (uses localStorage)
// ═══════════════════════════════════════════════════════════════
const LIBRARY_KEY = "txr_library_v1";
const POS_KEY     = "txr_pos_v1";

function saveToLibrary(filename, wordCount, readingTime) {
  try {
    const lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
    const existing = lib.findIndex(f => f.filename === filename);
    const entry = { filename, wordCount, readingTime, lastOpened: Date.now() };
    if (existing >= 0) lib[existing] = { ...lib[existing], ...entry };
    else lib.unshift(entry);
    localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib.slice(0, 20)));
  } catch {}
}

function updateLibraryProgress(filename, progress) {
  try {
    const lib = JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]");
    const i = lib.findIndex(f => f.filename === filename);
    if (i >= 0) { lib[i].progress = progress; localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib)); }
  } catch {}
}

function saveScrollPos(filename, scrollTop) {
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    pos[filename] = scrollTop;
    localStorage.setItem(POS_KEY, JSON.stringify(pos));
  } catch {}
}

function getSavedPos(filename) {
  try {
    const pos = JSON.parse(localStorage.getItem(POS_KEY) || "{}");
    return pos[filename] || 0;
  } catch { return 0; }
}

function LibraryPanel({ onLoadFile, currentFile }) {
  const [lib, setLib] = useState([]);

  useEffect(() => {
    try { setLib(JSON.parse(localStorage.getItem(LIBRARY_KEY) || "[]")); } catch {}
  }, [currentFile]);

  const removeEntry = (filename, e) => {
    e.stopPropagation();
    try {
      const updated = lib.filter(f => f.filename !== filename);
      localStorage.setItem(LIBRARY_KEY, JSON.stringify(updated));
      setLib(updated);
    } catch {}
  };

  if (!lib.length) return (
    <div style={{ textAlign: "center", padding: "28px 8px", color: "var(--text3)", fontSize: 12 }}>
      <div style={{ fontSize: 32, marginBottom: 8 }}>📚</div>
      No reading history yet.<br />
      <span style={{ fontSize: 11, opacity: .7 }}>Files you open will appear here.</span>
    </div>
  );

  return (
    <div>
      <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>
        Recent Files ({lib.length})
      </div>
      {lib.map(entry => (
        <div key={entry.filename} style={{
          display: "flex", alignItems: "center", gap: 10, padding: "10px 12px",
          background: entry.filename === currentFile ? "var(--accentBg)" : "var(--surface2)",
          border: `1px solid ${entry.filename === currentFile ? "var(--accent)44" : "var(--border)"}`,
          borderRadius: 10, marginBottom: 7, cursor: "pointer", transition: "all .14s",
        }} onClick={() => onLoadFile(entry.filename)}>
          <div style={{ fontSize: 22, flexShrink: 0 }}>📄</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 12, color: "var(--heading)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.filename}</div>
            <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 2, display: "flex", gap: 5 }}>
              <span>{entry.wordCount?.toLocaleString()}w</span>
              <span>·</span>
              <span>{entry.readingTime}m</span>
              <span>·</span>
              <span>{new Date(entry.lastOpened).toLocaleDateString()}</span>
            </div>
            {/* Progress bar */}
            <div style={{ background: "var(--surface3)", borderRadius: 99, height: 3, overflow: "hidden", marginTop: 5 }}>
              <div style={{ height: "100%", width: `${entry.progress || 0}%`, background: "var(--accent)", borderRadius: 99 }} />
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flexShrink: 0 }}>
            <span style={{ fontSize: 11, fontWeight: 800, color: "var(--accent)" }}>{entry.progress || 0}%</span>
            <button onClick={e => removeEntry(entry.filename, e)}
              style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 14, lineHeight: 1, padding: 0 }}>✕</button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  AMBIENT SOUNDSCAPE PANEL
// ═══════════════════════════════════════════════════════════════
const SOUNDS = [
  { id: "rain",    label: "Rain",       emoji: "🌧️", freq: [100, 200, 800],  type: "noise" },
  { id: "cafe",    label: "Café",       emoji: "☕", freq: [300, 600, 1200], type: "noise" },
  { id: "forest",  label: "Forest",     emoji: "🌲", freq: [80,  150, 400],  type: "noise" },
  { id: "ocean",   label: "Ocean",      emoji: "🌊", freq: [60,  120, 300],  type: "wave" },
  { id: "fire",    label: "Fireplace",  emoji: "🔥", freq: [40,  100, 250],  type: "noise" },
  { id: "white",   label: "White Noise",emoji: "⬜", freq: [200, 400, 800],  type: "flat" },
];

function AmbientPanel() {
  const [active, setActive] = useState(null);
  const [volume, setVolume] = useState(0.3);
  const ctxRef   = useRef(null);
  const nodesRef = useRef([]);

  const stopAll = useCallback(() => {
    nodesRef.current.forEach(n => { try { n.stop?.(); n.disconnect?.(); } catch {} });
    nodesRef.current = [];
    if (ctxRef.current) { ctxRef.current.close(); ctxRef.current = null; }
    setActive(null);
  }, []);

  const play = useCallback((sound) => {
    stopAll();
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      ctxRef.current = ctx;
      const gainNode = ctx.createGain();
      gainNode.gain.value = volume;
      gainNode.connect(ctx.destination);

      const nodes = [];
      sound.freq.forEach((freq, i) => {
        const bufSize = ctx.sampleRate * 3;
        const buf = ctx.createBuffer(1, bufSize, ctx.sampleRate);
        const data = buf.getChannelData(0);

        if (sound.type === "flat") {
          for (let j = 0; j < bufSize; j++) data[j] = (Math.random() * 2 - 1) * 0.5;
        } else if (sound.type === "wave") {
          for (let j = 0; j < bufSize; j++) {
            const wave = Math.sin(j / (ctx.sampleRate / freq) * Math.PI * 2);
            data[j] = wave * 0.3 * (Math.random() * 0.4 + 0.8);
          }
        } else {
          for (let j = 0; j < bufSize; j++) {
            data[j] = (Math.random() * 2 - 1) * (0.3 / (i + 1));
          }
        }

        const src = ctx.createBufferSource();
        src.buffer = buf; src.loop = true;
        const filter = ctx.createBiquadFilter();
        filter.type = "bandpass"; filter.frequency.value = freq; filter.Q.value = 0.5;
        src.connect(filter); filter.connect(gainNode);
        src.start(0);
        nodes.push(src, filter);
      });

      nodesRef.current = nodes;
      setActive(sound.id);
    } catch (e) { console.warn("Audio error:", e); }
  }, [volume, stopAll]);

  useEffect(() => {
    if (ctxRef.current) {
      const gain = nodesRef.current.find(n => n.gain);
      if (gain) gain.gain.value = volume;
    }
  }, [volume]);

  useEffect(() => () => stopAll(), [stopAll]);

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 7, marginBottom: 16 }}>
        {SOUNDS.map(s => (
          <button key={s.id} onClick={() => active === s.id ? stopAll() : play(s)}
            style={{
              padding: "10px 6px", borderRadius: 12, border: `1.5px solid ${active === s.id ? "var(--accent)" : "var(--border)"}`,
              background: active === s.id ? "var(--accentBg)" : "var(--surface2)",
              cursor: "pointer", transition: "all .15s", textAlign: "center",
              animation: active === s.id ? "pulseRing 2s infinite" : "none",
            }}>
            <div style={{ fontSize: 22, marginBottom: 3 }}>{s.emoji}</div>
            <div style={{ fontSize: 10, fontWeight: 700, color: active === s.id ? "var(--accent)" : "var(--text2)" }}>{s.label}</div>
          </button>
        ))}
      </div>

      {/* Volume */}
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 6 }}>
          <span style={{ color: "var(--text2)", fontWeight: 600 }}>🔊 Volume</span>
          <span style={{ color: "var(--accent)", fontWeight: 800 }}>{Math.round(volume * 100)}%</span>
        </div>
        <input type="range" min={0} max={1} step={0.05} value={volume}
          onChange={e => setVolume(parseFloat(e.target.value))}
          style={{ width: "100%", accentColor: "var(--accent)" }} />
      </div>

      {active ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", background: "var(--accentBg)", borderRadius: 9, border: "1px solid var(--accent)44" }}>
          <span className="blnk" style={{ fontSize: 14, color: "var(--accent)" }}>●</span>
          <span style={{ fontSize: 12, color: "var(--accentText)", fontWeight: 600 }}>Playing {SOUNDS.find(s => s.id === active)?.label}</span>
          <button onClick={stopAll} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 16 }}>×</button>
        </div>
      ) : (
        <div style={{ textAlign: "center", fontSize: 11, color: "var(--text3)", padding: "6px 0" }}>Tap a sound to start</div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  QUOTE CARD GENERATOR
// ═══════════════════════════════════════════════════════════════
function QuoteCardModal({ text, filename, theme, onClose }) {
  const canvasRef = useRef(null);
  const [cardTheme, setCardTheme] = useState(0);
  const [downloaded, setDownloaded] = useState(false);

  const CARD_THEMES = [
    { bg: ["#0a0a0f","#1a1040"],  text: "#e2e0f0",  accent: "#7c6af7", name: "Dark" },
    { bg: ["#F6F1E9","#EDE7DA"],  text: "#1C1610",  accent: "#B84A1A", name: "Ivory" },
    { bg: ["#0F0E0D","#201E1C"],  text: "#E8E0D4",  accent: "#D4A24A", name: "Ink" },
    { bg: ["#16142A","#272540"],  text: "#DDD8F4",  accent: "#9B7EF0", name: "Dusk" },
    { bg: ["#EEF4E8","#DFECd6"],  text: "#182818",  accent: "#2E6E2E", name: "Sage" },
  ];

  const draw = useCallback(() => {
    const c = canvasRef.current; if (!c) return;
    const ctx = c.getContext("2d");
    const ct = CARD_THEMES[cardTheme];
    const W = 800, H = 450;
    c.width = W; c.height = H;

    // Background gradient
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, ct.bg[0]); grad.addColorStop(1, ct.bg[1]);
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);

    // Decorative accent bar
    ctx.fillStyle = ct.accent; ctx.fillRect(0, 0, 5, H);

    // Quote mark
    ctx.fillStyle = ct.accent + "30"; ctx.font = "bold 160px Georgia, serif";
    ctx.fillText("", 40, 180);

    // Quote text — word-wrap
    const maxW = W - 120, lineH = 40;
    const words = text.split(" ");
    const lines = []; let cur = "";
    ctx.font = `italic 22px Georgia, serif`;
    words.forEach(w => {
      const test = cur ? cur + " " + w : w;
      if (ctx.measureText(test).width > maxW) { lines.push(cur); cur = w; }
      else cur = test;
    });
    if (cur) lines.push(cur);
    const maxLines = 6;
    const displayLines = lines.slice(0, maxLines);
    if (lines.length > maxLines) displayLines[maxLines - 1] += "…";

    const totalH = displayLines.length * lineH;
    const startY = (H - totalH) / 2 + 10;

    ctx.fillStyle = ct.text; ctx.font = `italic 22px Georgia, serif`;
    ctx.textAlign = "left";
    displayLines.forEach((line, i) => ctx.fillText(line, 60, startY + i * lineH));

    // Source line
    ctx.font = "600 13px system-ui, sans-serif";
    ctx.fillStyle = ct.accent;
    ctx.fillText(`— ${filename.replace(/\.[^.]+$/, "")}`, 60, H - 32);

    // Watermark
    ctx.textAlign = "right"; ctx.fillStyle = ct.text + "40"; ctx.font = "11px system-ui";
    ctx.fillText("TxtReader Legend", W - 24, H - 32);
  }, [cardTheme, text, filename]);

  useEffect(() => { draw(); }, [draw]);

  const download = () => {
    const link = document.createElement("a");
    link.download = "quote-card.png";
    link.href = canvasRef.current.toDataURL("image/png");
    link.click();
    setDownloaded(true);
    setTimeout(() => setDownloaded(false), 2000);
  };

  return (
    <div className="modal-ov" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 600 }} onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <div className="modal-title">🖼 Quote Card</div>
          <button className="sp-close" onClick={onClose}>✕</button>
        </div>

        {/* Preview */}
        <canvas ref={canvasRef} style={{ width: "100%", borderRadius: 10, border: "1px solid var(--border)", display: "block", marginBottom: 12 }} />

        {/* Card themes */}
        <div style={{ display: "flex", gap: 7, marginBottom: 14, flexWrap: "wrap" }}>
          {CARD_THEMES.map((ct, i) => (
            <button key={i} onClick={() => setCardTheme(i)}
              style={{
                padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${cardTheme === i ? "var(--accent)" : "var(--border)"}`,
                background: ct.bg[0], color: ct.text, fontSize: 11, fontWeight: 700, cursor: "pointer", transition: "all .14s",
              }}>{ct.name}</button>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn btn-p" style={{ flex: 1 }} onClick={download}>
            {downloaded ? "✓ Downloaded!" : "⬇ Download PNG"}
          </button>
          <button className="btn btn-s" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
//  MAIN APP
// ═══════════════════════════════════════════════════════════════
export default function App() {
  // Document state
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [stats, setStats] = useState(null);

  // Theme & typography
  const [themeKey, setThemeKey] = useState("obsidian");
  const [fontIdx, setFontIdx] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [lineH, setLineH] = useState(1.75);
  const [colW, setColW] = useState(680);
  const [focusMode, setFocusMode] = useState(false);

  // UI panels/state
  const [panel, setPanel] = useState(null);
  const [showMobSearch, setShowMobSearch] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);

  // Reader features
  const [searchQ, setSearchQ] = useState("");
  const [bookmarks, setBookmarks] = useState([]);
  const [highlights, setHighlights] = useState({});
  const [notes, setNotes] = useState({});
  const [activeNote, setActiveNote] = useState(null);
  const [noteText, setNoteText] = useState("");
  const [hlMode, setHlMode] = useState(false);
  const [hlColor, setHlColor] = useState("amber");

  // AI
  const [apiKey, setApiKey] = useState("");
  const [aiData, setAiData] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSection, setAiSection] = useState("overview");
  const [chatMsgs, setChatMsgs] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [quiz, setQuiz] = useState(null);
  const [quizAns, setQuizAns] = useState(null);

  // Word definition popup
  const [wordDef, setWordDef] = useState(null); // { word, x, y }

  // Quote card
  const [quoteCard, setQuoteCard] = useState(null);

  // Misc
  const [selPop, setSelPop] = useState(null);
  const [toasts, setToasts] = useState([]);

  const readerRef = useRef(null);
  const fileRef = useRef(null);
  const chatEndRef = useRef(null);
  const mobSearchRef = useRef(null);
  const deskSearchRef = useRef(null);

  const T = THEMES[themeKey];
  const F = FONTS[fontIdx];

  // Toast helpers
  const toast = useCallback((msg, type = "info") => {
    const id = Date.now() + Math.random();
    setToasts(p => [...p.slice(-4), { id, msg, type }]); // max 5 toasts
  }, []);
  const rmToast = useCallback(id => setToasts(p => p.filter(t => t.id !== id)), []);

  // Theme / font injection
  useEffect(() => { injectStyles(T, F.css); }, [themeKey, fontIdx]);
  useEffect(() => { document.documentElement.style.setProperty("--col-w", colW + "px"); }, [colW]);

  // ── File loading ──────────────────────────────
  const loadFile = useCallback(file => {
    if (!file) return;
    const r = new FileReader();
    r.onload = e => {
      try {
        const text = e.target.result;
        const parsed = parseDoc(text);
        const s = computeStats(text, parsed);
        setRaw(text); setFilename(file.name); setBlocks(parsed); setStats(s);
        setAiData(null); setChatMsgs([]); setBookmarks([]); setHighlights({});
        setNotes({}); setProgress(0); setPanel(null); setSearchQ("");
        // Save to library
        saveToLibrary(file.name, s.wordCount, s.readingTime);
        // Restore scroll position after render
        const savedPos = getSavedPos(file.name);
        if (savedPos > 0) {
          setTimeout(() => {
            if (readerRef.current) readerRef.current.scrollTop = savedPos;
          }, 120);
        }
        toast(`✓ Loaded "${file.name}" — ${s.wordCount.toLocaleString()} words`, "success");
      } catch (err) { toast(`Error reading file: ${err.message}`, "error"); }
    };
    r.onerror = () => toast("Failed to read file", "error");
    r.readAsText(file, "UTF-8");
  }, [toast]);

  const onDrop = useCallback(e => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files[0]); }, [loadFile]);

  // ── Scroll progress + auto-save ─────────────
  useEffect(() => {
    const el = readerRef.current; if (!el) return;
    let saveTimer = null;
    const fn = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const pct = scrollHeight > clientHeight ? Math.round(scrollTop / (scrollHeight - clientHeight) * 100) : 0;
      setProgress(pct);
      // Debounced auto-save
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (filename) {
          saveScrollPos(filename, scrollTop);
          updateLibraryProgress(filename, pct);
        }
      }, 1000);
    };
    el.addEventListener("scroll", fn, { passive: true });
    return () => { el.removeEventListener("scroll", fn); clearTimeout(saveTimer); };
  }, [blocks, filename]);

  // ── Double-click word definition ─────────────
  useEffect(() => {
    const fn = (e) => {
      const sel = window.getSelection();
      const word = sel?.toString().trim().replace(/[^a-zA-Z'-]/g, "");
      if (word && word.length >= 2 && word.length <= 30 && /^[a-zA-Z]/.test(word)) {
        try {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          setWordDef({ word, x: rect.left + rect.width / 2, y: rect.top });
          setSelPop(null);
        } catch {}
      }
    };
    document.addEventListener("dblclick", fn);
    return () => document.removeEventListener("dblclick", fn);
  }, []);

  // ── Selection popup ───────────────────────────
  useEffect(() => {
    const fn = () => setTimeout(() => {
      const sel = window.getSelection(); const txt = sel?.toString().trim();
      if (txt && txt.length > 10 && txt.length < 600) {
        try {
          const rect = sel.getRangeAt(0).getBoundingClientRect();
          const x = Math.max(80, Math.min(rect.left + rect.width / 2, window.innerWidth - 80));
          setSelPop({ x, y: rect.top - 12, txt });
        } catch { setSelPop(null); }
      } else setSelPop(null);
    }, 20);
    document.addEventListener("mouseup", fn);
    document.addEventListener("touchend", fn);
    return () => { document.removeEventListener("mouseup", fn); document.removeEventListener("touchend", fn); };
  }, []);

  // ── Search ───────────────────────────────────
  const searchHits = useMemo(() => {
    if (!searchQ.trim()) return null;
    const q = searchQ.toLowerCase(); const s = new Set();
    blocks.forEach(b => {
      const t = b.text || (b.items || []).join(" ");
      if (t.toLowerCase().includes(q)) s.add(b.id);
    });
    return s;
  }, [blocks, searchQ]);

  const hlSearch = useCallback(text => {
    if (!searchQ.trim() || !text) return text;
    const esc = searchQ.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.split(new RegExp(`(${esc})`, "gi")).map((p, i) =>
      p.toLowerCase() === searchQ.toLowerCase() ? <mark key={i} className="shl">{p}</mark> : p
    );
  }, [searchQ]);

  const tocItems = useMemo(() => blocks.filter(b => ["chapter", "h1", "h2", "heading"].includes(b.type)), [blocks]);

  const scrollTo = (id) => {
    document.getElementById(`b-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (window.innerWidth <= 860) setPanel(null);
  };

  // ── Bookmark / Highlight / Notes ─────────────
  const toggleBookmark = id => {
    setBookmarks(p => {
      const has = p.some(b => b.id === id);
      toast(has ? "Bookmark removed" : "✓ Paragraph bookmarked", has ? "info" : "success");
      return has ? p.filter(b => b.id !== id) : [...p, { id, ts: Date.now() }];
    });
  };
  const toggleHL = (id, color) => {
    setHighlights(p => {
      if (p[id] === color) { const n = { ...p }; delete n[id]; toast("Highlight removed", "info"); return n; }
      toast("✓ Highlighted", "success"); return { ...p, [id]: color };
    });
  };
  const saveNote = () => {
    if (activeNote != null) {
      if (noteText.trim()) setNotes(p => ({ ...p, [activeNote]: noteText }));
      else { setNotes(p => { const n = { ...p }; delete n[activeNote]; return n; }); }
      setActiveNote(null); setNoteText("");
      toast("✓ Note saved", "success");
    }
  };

  // ── Export helpers ────────────────────────────
  const exportHTML = () => {
    const body = blocks.map(b => {
      if (b.type === "chapter") return `<h1>${b.text}</h1>`;
      if (["h1", "heading"].includes(b.type)) return `<h2>${b.text}</h2>`;
      if (b.type === "h2") return `<h3>${b.text}</h3>`;
      if (b.type === "quote") return `<blockquote><p>${b.text}</p></blockquote>`;
      if (b.type === "code") return `<pre><code>${b.text.replace(/</g, "&lt;")}</code></pre>`;
      if (b.type === "list") return (b.ordered ? `<ol>` : `<ul>`) + (b.items || []).map(i => `<li>${i}</li>`).join("") + (b.ordered ? `</ol>` : `</ul>`);
      if (b.type === "divider") return `<hr>`;
      return `<p>${b.text}</p>`;
    }).join("\n");
    dl(filename.replace(/\.[^.]+$/, "") + ".html",
      `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${filename}</title>
<style>body{font-family:${F.css};max-width:${colW}px;margin:60px auto;padding:0 28px;font-size:${fontSize}px;line-height:${lineH};}p{margin:0 0 22px;}blockquote{border-left:3px solid #c06030;padding:12px 20px;margin:24px 0;font-style:italic;}pre{background:#f0ede6;padding:16px;border-radius:10px;overflow-x:auto;}</style>
</head><body>${body}</body></html>`, "text/html");
    toast("✓ HTML exported", "success");
  };

  const exportMD = () => {
    dl(filename.replace(/\.[^.]+$/, "") + ".md",
      blocks.map(b => {
        if (b.type === "chapter") return `# ${b.text}`;
        if (["h1", "heading"].includes(b.type)) return `## ${b.text}`;
        if (b.type === "h2") return `### ${b.text}`;
        if (b.type === "quote") return `> ${b.text}`;
        if (b.type === "code") return "```\n" + b.text + "\n```";
        if (b.type === "list") return (b.items || []).map(i => `- ${i}`).join("\n");
        if (b.type === "divider") return "---";
        return b.text || "";
      }).join("\n\n")
    );
    toast("✓ Markdown exported", "success");
  };

  const exportAnnotations = () => {
    const bms = bookmarks.map(bm => {
      const b = blocks.find(x => x.id === bm.id);
      return b ? `[BOOKMARK] ${(b.text || "").slice(0, 100)}…` : null;
    }).filter(Boolean);
    const hls = Object.entries(highlights).map(([id, color]) => {
      const b = blocks.find(x => x.id === parseInt(id));
      return b ? `[HIGHLIGHT:${color.toUpperCase()}] ${(b.text || "").slice(0, 100)}…` : null;
    }).filter(Boolean);
    const ns = Object.entries(notes).map(([id, note]) => {
      const b = blocks.find(x => x.id === parseInt(id));
      return b ? `[NOTE on: "${(b.text || "").slice(0, 60)}…"]\n${note}` : null;
    }).filter(Boolean);
    const content = `ANNOTATIONS — ${filename}\n${"─".repeat(50)}\n\nBOOKMARKS (${bms.length})\n${bms.join("\n") || "(none)"}\n\nHIGHLIGHTS (${hls.length})\n${hls.join("\n") || "(none)"}\n\nNOTES (${ns.length})\n${ns.join("\n\n") || "(none)"}`;
    dl(filename.replace(/\.[^.]+$/, "") + "-annotations.txt", content);
    toast("✓ Annotations exported", "success");
  };

  // ── AI Analysis ───────────────────────────────
  const runAI = async () => {
    if (!apiKey) { toast("Enter your Gemini API key in Settings", "warning"); return; }
    setAiLoading(true); setPanel("ai");
    try {
      toast("AI analysis started…", "info");
      const result = await callGeminiJSON(apiKey,
        `Analyze this document carefully. Return ONLY a JSON object with exactly these fields:
{"title":"","author":"unknown","genre":"","era":"","executive_summary":"5-6 sentence overview","detailed_synopsis":"10-sentence synopsis","key_themes":["","","","",""],"main_arguments":["","",""],"key_characters":["",""],"important_quotes":["","",""],"best_line":"","writing_style":"","tone":"","pov":"","mood":"3 words","sentiment":"Positive|Neutral|Negative|Mixed","difficulty":"Easy|Moderate|Advanced|Expert","target_audience":"","strengths":["","",""],"weaknesses":["",""],"unique_aspects":"","recommendations":"","words_that_matter":["","","","",""],"overall_rating":7,"overall_rating_reason":""}
Document (first 14000 chars): ${raw.slice(0, 14000)}`,
        msg => toast(msg, "error")
      );
      if (result) { setAiData(result); toast("✓ Analysis complete!", "success"); }
      else toast("Analysis failed — check API key and try again", "error");
    } finally { setAiLoading(false); }
  };

  // ── Chat ──────────────────────────────────────
  const sendChat = async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    if (!apiKey) { toast("Enter your Gemini API key in Settings", "warning"); return; }
    setChatInput(""); setChatMsgs(p => [...p, { role: "user", text: msg }]); setChatLoading(true);
    try {
      const ctx = raw.slice(0, 6000);
      const history = chatMsgs.slice(-8).map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
      const reply = await callGemini(apiKey,
        `Document excerpt (${stats?.wordCount} total words):\n${ctx}\n\nChat history:\n${history}\n\nUser: ${msg}\n\nAssistant:`,
        "You are a helpful reading assistant. Answer questions about the document clearly and concisely. Use bullet points (- item) for lists, **bold** for key terms. No HTML tags. Be direct."
      );
      setChatMsgs(p => [...p, { role: "assistant", text: reply }]);
      setTimeout(() => chatEndRef.current?.scrollIntoView({ behavior: "smooth" }), 80);
    } catch (e) { toast(`Chat error: ${e.message}`, "error"); }
    finally { setChatLoading(false); }
  };

  // ── Quiz ──────────────────────────────────────
  const genQuiz = async () => {
    if (!apiKey) { toast("Enter API key in Settings", "warning"); return; }
    setQuiz({ loading: true });
    try {
      const result = await callGeminiJSON(apiKey,
        `Create a challenging multiple-choice question about this document.
Return ONLY JSON: {"question":"","options":["A option text","B option text","C option text","D option text"],"correct":0,"explanation":"2-3 sentence explanation"}
Document: ${raw.slice(0, 3000)}`,
        msg => toast(msg, "error")
      );
      setQuiz(result || null); setQuizAns(null);
      if (result) toast("✓ Quiz ready!", "success");
    } catch (e) { toast(e.message, "error"); setQuiz(null); }
  };

  // ─── Block renderer ───────────────────────────
  const renderBlock = (block) => {
    const bm = bookmarks.some(b => b.id === block.id);
    const hl = highlights[block.id];
    const hasNote = notes[block.id];
    if (searchHits && !searchHits.has(block.id)) return null;

    const acts = (
      <div className="para-acts">
        <button className={`pa ${bm ? "on" : ""}`} onClick={() => toggleBookmark(block.id)} title="Bookmark">🔖</button>
        {hlMode && (
          <button className={`pa ${hl ? "on" : ""}`} onClick={() => toggleHL(block.id, hlColor)} title="Highlight">✏</button>
        )}
        <button className="pa" onClick={() => { setActiveNote(block.id); setNoteText(notes[block.id] || ""); }} title="Add note">📝</button>
      </div>
    );

    if (block.type === "divider") return (
      <div key={block.id} id={`b-${block.id}`} className="block-div">
        <div className="div-line" /><span className="div-mid">· · ·</span><div className="div-line" />
      </div>
    );
    if (block.type === "chapter") return (
      <div key={block.id} id={`b-${block.id}`} className="chapter-block">
        <div className="ch-label">— Chapter —</div>
        <h1 className="ch-title">{hlSearch(block.text)}</h1>
        <div className="ch-rule" />
      </div>
    );
    if (["h1", "heading"].includes(block.type)) return (
      <h2 key={block.id} id={`b-${block.id}`}
        style={{ fontSize: `${fontSize * 1.44}px`, fontWeight: 800, color: "var(--heading)", margin: "46px 0 14px", lineHeight: 1.2 }}>
        {hlSearch(block.text)}
      </h2>
    );
    if (block.type === "h2") return (
      <h3 key={block.id} id={`b-${block.id}`}
        style={{ fontSize: `${fontSize * 1.2}px`, fontWeight: 700, color: "var(--heading)", margin: "34px 0 10px" }}>
        {hlSearch(block.text)}
      </h3>
    );
    if (block.type === "h3") return (
      <h4 key={block.id} id={`b-${block.id}`}
        style={{ fontSize: `${fontSize * 1.05}px`, fontWeight: 600, color: "var(--heading)", margin: "24px 0 7px" }}>
        {hlSearch(block.text)}
      </h4>
    );
    if (block.type === "quote") return (
      <blockquote key={block.id} id={`b-${block.id}`} className="block-quote">
        <p>{hlSearch(block.text)}</p>{acts}
      </blockquote>
    );
    if (block.type === "code") return (
      <pre key={block.id} id={`b-${block.id}`} className="block-code"><code>{block.text}</code></pre>
    );
    if (block.type === "list") return (
      <div key={block.id} id={`b-${block.id}`} className="block-list">
        {(block.items || []).map((item, i) => (
          <div key={i} className="list-item">
            {block.ordered ? <span className="list-num">{i + 1}.</span> : <span className="list-dot" />}
            <span>{hlSearch(item)}</span>
          </div>
        ))}
      </div>
    );
    if (block.type === "poetry") return (
      <div key={block.id} id={`b-${block.id}`} className={`para ${hl ? `hl-${hl}` : ""}`}>
        {block.text.split("\n").map((l, i) => (
          <p key={i} style={{ textAlign: "center", margin: "0 0 5px", fontStyle: "italic" }}>{hlSearch(l)}</p>
        ))}
        {hasNote && <div style={{ marginTop: 8, padding: "6px 10px", background: "var(--accentBg)", borderRadius: 7, fontSize: 12, color: "var(--accentText)", borderLeft: "2px solid var(--accent)" }}>📝 {notes[block.id]}</div>}
        {acts}
      </div>
    );
    // Default: paragraph
    return (
      <div key={block.id} id={`b-${block.id}`}
        className={`para ${hl ? `hl-${hl}` : ""}`}
        onClick={() => { if (hlMode) toggleHL(block.id, hlColor); }}>
        <p style={{ fontSize, lineHeight: lineH, color: "var(--text)", margin: 0, textAlign: "justify" }}>{hlSearch(block.text)}</p>
        {hasNote && <div style={{ marginTop: 8, padding: "6px 10px", background: "var(--accentBg)", borderRadius: 7, fontSize: 12, color: "var(--accentText)", borderLeft: "2px solid var(--accent)" }}>📝 {notes[block.id]}</div>}
        {acts}
      </div>
    );
  };

  // ─── Panel content ─────────────────────────────
  const panelContent = useMemo(() => ({
    toc: (
      <div>
        {tocItems.length === 0
          ? <div style={{ color: "var(--text3)", fontSize: 12, padding: 16, textAlign: "center", lineHeight: 1.6 }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>📋</div>
            No headings found in this document.
          </div>
          : tocItems.map((item, i) => (
            <button key={item.id} className="toc-row" onClick={() => scrollTo(item.id)}>
              <span style={{ color: "var(--accent)", marginRight: 7, fontSize: 10, fontWeight: 800 }}>{i + 1}</span>
              {(item.text || "").slice(0, 55)}{(item.text || "").length > 55 ? "…" : ""}
            </button>
          ))
        }
      </div>
    ),

    bookmarks: (
      <div>
        {bookmarks.length === 0 && Object.keys(highlights).length === 0 && Object.keys(notes).length === 0 ? (
          <div style={{ color: "var(--text3)", fontSize: 12, textAlign: "center", padding: "28px 8px" }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📌</div>
            No bookmarks, highlights or notes yet.<br />
            <span style={{ fontSize: 11, opacity: .7 }}>Hover a paragraph to add them.</span>
          </div>
        ) : (
          <>
            {bookmarks.length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Bookmarks ({bookmarks.length})</div>
                {bookmarks.map(bm => { const b = blocks.find(x => x.id === bm.id); return b ? (
                  <button key={bm.id} className="toc-row" onClick={() => scrollTo(bm.id)}>
                    <span style={{ color: "var(--accent)", marginRight: 7 }}>🔖</span>
                    {(b.text || "").slice(0, 55)}{(b.text || "").length > 55 ? "…" : ""}
                  </button>
                ) : null; })}
              </div>
            )}
            {Object.keys(highlights).length > 0 && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Highlights ({Object.keys(highlights).length})</div>
                {Object.entries(highlights).map(([id, color]) => {
                  const b = blocks.find(x => x.id === parseInt(id));
                  const hc = HLC.find(c => c.id === color);
                  return b ? (
                    <button key={id} className="toc-row" onClick={() => scrollTo(parseInt(id))}>
                      <span style={{ display: "inline-block", width: 10, height: 10, borderRadius: 3, background: hc?.bg, marginRight: 8, flexShrink: 0, verticalAlign: "middle", border: `1px solid ${hc?.br}` }} />
                      {(b.text || "").slice(0, 55)}{(b.text || "").length > 55 ? "…" : ""}
                    </button>
                  ) : null;
                })}
              </div>
            )}
            {Object.keys(notes).length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 9, fontWeight: 800, color: "var(--text3)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Notes ({Object.keys(notes).length})</div>
                {Object.entries(notes).map(([id, note]) => {
                  const b = blocks.find(x => x.id === parseInt(id));
                  return b ? (
                    <button key={id} className="toc-row" onClick={() => scrollTo(parseInt(id))} style={{ display: "block" }}>
                      <span style={{ color: "var(--accent)", marginRight: 7 }}>📝</span>
                      <span style={{ fontSize: 11, opacity: .8 }}>{note.slice(0, 45)}{note.length > 45 ? "…" : ""}</span>
                    </button>
                  ) : null;
                })}
              </div>
            )}
            <div className="export-row">
              <button className="btn btn-s btn-sm" onClick={exportAnnotations} style={{ flex: 1 }}>⬇ Export All</button>
            </div>
          </>
        )}
      </div>
    ),

    stats: stats && (
      <div>
        <div className="stat-grid2">
          {[["Words", stats.wordCount.toLocaleString()], ["Chars", stats.charCount.toLocaleString()], ["Sentences", stats.sentenceCount.toLocaleString()], ["Paragraphs", stats.paragraphCount], ["Chapters", stats.chapterCount], ["Read time", `${stats.readingTime}m`], ["Avg sent", `${stats.avgSentLen}w`], ["Lex div", `${stats.lexDiv}%`]].map(([k, v]) => (
            <div key={k} className="stat-c"><div className="stat-k">{k}</div><div className="stat-v">{v}</div></div>
          ))}
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 8 }}>Reading Progress</div>
          <div className="read-prog"><div className="read-prog-fill" style={{ width: `${progress}%` }} /></div>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--text3)" }}>
            <span>{progress}% read</span>
            <span>~{Math.max(0, stats.readingTime - Math.round(progress / 100 * stats.readingTime))}m left</span>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 8 }}>Top Words</div>
          {stats.topWords.map(([word, count]) => (
            <div key={word} style={{ marginBottom: 7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, marginBottom: 3 }}>
                <span>{word}</span><span style={{ fontWeight: 800, color: "var(--accent)" }}>{count}×</span>
              </div>
              <div style={{ height: 3, background: "var(--surface3)", borderRadius: 2 }}>
                <div style={{ height: "100%", width: `${count / stats.topWords[0][1] * 100}%`, background: "var(--accent)", borderRadius: 2 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    ),

    ai: (
      <div>
        {!apiKey ? (
          <div>
            <div style={{ background: "var(--accentBg)", border: "1px solid var(--accent)44", borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: "var(--accent)", marginBottom: 8 }}>⚠ API Key Required</div>
              <input type="password" className="inp" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="AIza…" style={{ marginBottom: 6 }} />
              <div style={{ fontSize: 10, color: "var(--text3)" }}>Free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>aistudio.google.com</a></div>
            </div>
            <button className="btn btn-p" style={{ width: "100%" }} onClick={runAI} disabled={!apiKey}>✨ Analyze Document</button>
          </div>
        ) : aiLoading ? (
          <div style={{ textAlign: "center", padding: 40 }}>
            <div className="spin" style={{ fontSize: 34, marginBottom: 14, display: "block" }}>⚙️</div>
            <div style={{ fontWeight: 800, marginBottom: 6, color: "var(--heading)" }}>Analyzing document…</div>
            <div style={{ fontSize: 12, color: "var(--text2)" }}>May take 15–30 seconds</div>
          </div>
        ) : !aiData ? (
          <div>
            <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 14, marginBottom: 14, fontSize: 12, lineHeight: 1.65, color: "var(--text2)" }}>
              Gemini will analyze themes, writing style, characters, quotes, and more — then generate a detailed report.
            </div>
            <button className="btn btn-p" style={{ width: "100%" }} onClick={runAI}>✨ Analyze Document</button>
          </div>
        ) : (
          <div>
            <div className="ai-tabs">
              {["overview", "summary", "themes", "writing", "quotes", "critique"].map(s => (
                <button key={s} className="ai-tab" onClick={() => setAiSection(s)}
                  style={{ background: aiSection === s ? "var(--accent)" : "var(--surface2)", color: aiSection === s ? "#fff" : "var(--text2)" }}>
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.65 }}>
              {aiSection === "overview" && <div>
                <div style={{ background: "var(--surface2)", borderRadius: 12, padding: 14, marginBottom: 12 }}>
                  <div style={{ fontWeight: 800, fontSize: 14, color: "var(--heading)", marginBottom: 3 }}>{aiData.title || filename}</div>
                  <div style={{ color: "var(--text2)", fontSize: 11, marginBottom: 8 }}>{aiData.author} · {aiData.genre} · {aiData.era}</div>
                  <div>{[aiData.mood, aiData.difficulty, aiData.sentiment].filter(Boolean).map(t => <span key={t} className="chip">{t}</span>)}</div>
                </div>
                <div className="stat-grid2">
                  <div className="stat-c"><div className="stat-k">Rating</div><div className="stat-v">{aiData.overall_rating}/10</div></div>
                  <div className="stat-c"><div className="stat-k">Audience</div><div className="stat-v" style={{ fontSize: 11, lineHeight: 1.4 }}>{(aiData.target_audience || "").slice(0, 30)}</div></div>
                </div>
                {aiData.overall_rating_reason && <div style={{ fontSize: 11, color: "var(--text2)", marginTop: 10, lineHeight: 1.55, background: "var(--surface2)", padding: "10px 12px", borderRadius: 9 }}>{aiData.overall_rating_reason}</div>}
                <button className="btn btn-p" style={{ width: "100%", marginTop: 12 }} onClick={() => {
                  const d = aiData;
                  dl(`${filename}-analysis.txt`,
                    `TxtReader Legend — AI Analysis\n${"─".repeat(44)}\nFile: ${filename}\n\nTitle: ${d.title}\nAuthor: ${d.author}\nGenre: ${d.genre}\nRating: ${d.overall_rating}/10\nAudience: ${d.target_audience}\n\nEXECUTIVE SUMMARY\n${d.executive_summary}\n\nDETAILED SYNOPSIS\n${d.detailed_synopsis}\n\nKEY THEMES\n${(d.key_themes || []).map((t, i) => `${i + 1}. ${t}`).join("\n")}\n\nWRITING STYLE\n${d.writing_style}\n\nTONE: ${d.tone}\nPOV: ${d.pov}\n\nSTRENGTHS\n${(d.strengths || []).map(s => `• ${s}`).join("\n")}\n\nWEAKNESSES\n${(d.weaknesses || []).map(w => `• ${w}`).join("\n")}\n\nNOTABLE QUOTES\n${(d.important_quotes || []).map((q, i) => `${i + 1}. "${q}"`).join("\n")}\n\nBEST LINE\n"${d.best_line}"\n\nRECOMMENDATIONS\n${d.recommendations}`
                  );
                  toast("✓ Report downloaded", "success");
                }}>⬇ Download Full Report</button>
              </div>}
              {aiSection === "summary" && <div>
                {aiData.executive_summary && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Executive Summary</div><p style={{ marginTop: 6, lineHeight: 1.65 }}>{aiData.executive_summary}</p></div>}
                {aiData.detailed_synopsis && <div className="stat-c"><div className="stat-k">Detailed Synopsis</div><p style={{ marginTop: 6, lineHeight: 1.65 }}>{aiData.detailed_synopsis}</p></div>}
              </div>}
              {aiSection === "themes" && <div>
                {aiData.key_themes?.length > 0 && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Key Themes</div>{aiData.key_themes.map((t, i) => <div key={i} style={{ marginBottom: 6, paddingLeft: 8, borderLeft: "2px solid var(--accent)" }}>{t}</div>)}</div>}
                {aiData.key_characters?.length > 0 && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Characters / Entities</div>{aiData.key_characters.map((c, i) => <div key={i} style={{ marginBottom: 4 }}>• {c}</div>)}</div>}
                {aiData.main_arguments?.length > 0 && <div className="stat-c"><div className="stat-k">Main Arguments</div>{aiData.main_arguments.map((a, i) => <div key={i} style={{ marginBottom: 4 }}><strong>{i + 1}.</strong> {a}</div>)}</div>}
              </div>}
              {aiSection === "writing" && <div>
                {aiData.writing_style && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Writing Style</div><p style={{ marginTop: 5, lineHeight: 1.6 }}>{aiData.writing_style}</p></div>}
                {aiData.tone && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Tone</div><p style={{ marginTop: 5 }}>{aiData.tone}</p></div>}
                {aiData.pov && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Point of View</div><p style={{ marginTop: 5 }}>{aiData.pov}</p></div>}
                {aiData.words_that_matter?.length > 0 && <div className="stat-c"><div className="stat-k">Words That Matter</div><div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 4 }}>{aiData.words_that_matter.map(w => <span key={w} className="chip">{w}</span>)}</div></div>}
              </div>}
              {aiSection === "quotes" && <div>
                {aiData.best_line && <div className="stat-c" style={{ marginBottom: 10, background: "var(--accentBg)", borderLeft: "3px solid var(--accent)" }}><div className="stat-k">⭐ Most Memorable Line</div><p style={{ marginTop: 5, fontStyle: "italic", lineHeight: 1.65 }}>"{aiData.best_line}"</p></div>}
                {(aiData.important_quotes || []).map((q, i) => <div key={i} className="stat-c" style={{ marginBottom: 8 }}><div className="stat-k">Quote {i + 1}</div><p style={{ marginTop: 5, fontStyle: "italic", lineHeight: 1.65 }}>"{q}"</p></div>)}
              </div>}
              {aiSection === "critique" && <div>
                {aiData.strengths?.length > 0 && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k" style={{ color: "#22c55e" }}>✓ Strengths</div>{aiData.strengths.map((s, i) => <div key={i} style={{ marginBottom: 5, paddingLeft: 8, borderLeft: "2px solid #22c55e" }}>{s}</div>)}</div>}
                {aiData.weaknesses?.length > 0 && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k" style={{ color: "#ef4444" }}>⚠ Areas to Improve</div>{aiData.weaknesses.map((w, i) => <div key={i} style={{ marginBottom: 5, paddingLeft: 8, borderLeft: "2px solid #ef4444" }}>{w}</div>)}</div>}
                {aiData.unique_aspects && <div className="stat-c" style={{ marginBottom: 10 }}><div className="stat-k">Unique Aspects</div><p style={{ marginTop: 5, lineHeight: 1.6 }}>{aiData.unique_aspects}</p></div>}
                {aiData.recommendations && <div className="stat-c"><div className="stat-k">Recommendations</div><p style={{ marginTop: 5, lineHeight: 1.6 }}>{aiData.recommendations}</p></div>}
              </div>}
            </div>
            <button className="btn btn-s" style={{ width: "100%", marginTop: 12 }} onClick={() => { setAiData(null); setAiSection("overview"); toast("Analysis cleared", "info"); }}>↺ Re-analyze</button>
          </div>
        )}
      </div>
    ),

    chat: (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        {!apiKey && <div style={{ background: "var(--accentBg)", border: "1px solid var(--accent)44", borderRadius: 10, padding: 12, marginBottom: 10, fontSize: 12, flexShrink: 0 }}>
          <strong style={{ color: "var(--accent)" }}>⚠ API Key Required</strong> — enter it in Settings first.
        </div>}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 7, paddingBottom: 4 }}>
          {chatMsgs.length === 0 && <div style={{ textAlign: "center", color: "var(--text3)", padding: "28px 8px", fontSize: 12 }}>
            <div style={{ fontSize: 30, marginBottom: 8 }}>💬</div>
            Ask anything about the document.<br />
            <span style={{ fontSize: 11, opacity: .7 }}>Try: "Summarize this" · "What are the main themes?"</span>
          </div>}
          {chatMsgs.map((m, i) => m.role === "user"
            ? <div key={i} className="chat-u">{m.text}</div>
            : <div key={i} className="chat-b"><BotMessage text={m.text} /></div>
          )}
          {chatLoading && <div className="chat-b"><span className="blnk" style={{ fontSize: 20 }}>···</span></div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 10, flexShrink: 0, marginTop: 8 }}>
          <div style={{ display: "flex", gap: 6 }}>
            <textarea className="inp" value={chatInput} onChange={e => setChatInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              placeholder="Ask about your document… (Enter to send)" rows={2}
              style={{ flex: 1, resize: "none", fontSize: 12, minHeight: "unset" }} />
            <button className="btn btn-p" onClick={sendChat} disabled={!chatInput.trim() || chatLoading}
              style={{ padding: "0 12px", alignSelf: "stretch", fontSize: 16 }}>➤</button>
          </div>
          {chatMsgs.length > 0 && (
            <button className="btn btn-s btn-sm" onClick={() => setChatMsgs([])}
              style={{ marginTop: 7, fontSize: 10, padding: "4px 10px" }}>Clear chat</button>
          )}
        </div>
      </div>
    ),

    tts: <TTSPanel blocks={blocks} toast={toast} />,

    library: <LibraryPanel onLoadFile={(fname) => toast(`Re-open "${fname}" by dropping the file`, "info")} currentFile={filename} />,

    sounds: <AmbientPanel />,

    timer: <PomodoroPanel />,

    settings: (
      <div>
        {/* Theme */}
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 10, textTransform: "uppercase", letterSpacing: .8 }}>Theme</div>
          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
            {Object.entries(THEMES).map(([key, th]) => (
              <button key={key} className={`theme-dot ${themeKey === key ? "active" : ""}`}
                onClick={() => setThemeKey(key)}
                style={{ background: th.surface, border: `2.5px solid ${themeKey === key ? th.accent : th.border}` }}
                title={th.name}>{th.emoji}</button>
            ))}
          </div>
        </div>
        {/* Font */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 8, textTransform: "uppercase", letterSpacing: .8 }}>Font Family</div>
          <select className="inp" value={fontIdx} onChange={e => setFontIdx(Number(e.target.value))}>
            {FONTS.map((f, i) => <option key={f.n} value={i}>{f.n}</option>)}
          </select>
        </div>
        {/* Sliders */}
        {[["Font Size", fontSize, 12, 32, 1, setFontSize, "px"], ["Line Height", lineH, 1.3, 2.2, .05, setLineH, ""], ["Column Width", colW, 400, 900, 20, setColW, "px"]].map(([label, val, min, max, step, set, unit]) => (
          <div key={label} style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 6 }}>
              <span style={{ color: "var(--text2)", fontWeight: 600 }}>{label}</span>
              <span style={{ color: "var(--accent)", fontWeight: 800 }}>{step < 1 ? val.toFixed(2) : val}{unit}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={val}
              onChange={e => set(step < 1 ? parseFloat(Number(e.target.value).toFixed(2)) : Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent)" }} />
          </div>
        ))}
        {/* API Key */}
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 8, textTransform: "uppercase", letterSpacing: .8 }}>Gemini API Key</div>
          <input type="password" className="inp" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="AIza…" />
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 5 }}>Free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>aistudio.google.com</a></div>
        </div>
        {/* Export */}
        <div style={{ fontSize: 11, fontWeight: 800, color: "var(--heading)", marginBottom: 8, textTransform: "uppercase", letterSpacing: .8 }}>Export</div>
        <div style={{ display: "flex", gap: 7, marginBottom: 8 }}>
          <button className="btn btn-p btn-sm" style={{ flex: 1 }} onClick={exportHTML}>HTML</button>
          <button className="btn btn-s btn-sm" style={{ flex: 1 }} onClick={exportMD}>Markdown</button>
          <button className="btn btn-s btn-sm" style={{ flex: 1 }} onClick={exportAnnotations}>Notes</button>
        </div>
        {/* Quiz */}
        <button className="btn btn-s" style={{ width: "100%", marginBottom: 8 }} onClick={() => { genQuiz(); setPanel(null); }}>🧠 Generate Quiz</button>
        {/* Focus / close */}
        <button className="btn btn-s" style={{ width: "100%", marginBottom: 8 }} onClick={() => { setFocusMode(v => !v); toast(focusMode ? "Focus mode off" : "Focus mode on", "info"); }}>
          {focusMode ? "🎯 Exit Focus Mode" : "🎯 Enter Focus Mode"}
        </button>
        <button className="btn btn-s" style={{ width: "100%", color: "var(--quote)" }} onClick={() => { setRaw(""); setBlocks([]); setPanel(null); }}>✕ Close Document</button>
      </div>
    ),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [tocItems, bookmarks, highlights, notes, stats, progress, apiKey, aiLoading, aiData, aiSection, chatMsgs, chatInput, chatLoading, themeKey, fontIdx, fontSize, lineH, colW, focusMode, blocks, searchQ, hlMode, quiz, quizAns]);

  const PANEL_TITLES = {
    toc:       "📋 Contents",
    bookmarks: "📌 Saved",
    stats:     "📊 Statistics",
    ai:        "🤖 AI Analysis",
    chat:      "💬 Chat",
    tts:       "🔊 Read Aloud",
    library:   "📚 Library",
    sounds:    "🎵 Ambient Sounds",
    timer:     "⏱ Focus Timer",
    settings:  "⚙️ Settings",
  };

  const BB_ITEMS = [
    { id: "toc",      icon: "≡",  label: "Contents" },
    { id: "bookmarks",icon: "📌", label: "Saved" },
    { id: "tts",      icon: "🔊", label: "Listen" },
    { id: "ai",       icon: "🤖", label: "AI" },
    { id: "sounds",   icon: "🎵", label: "Sounds" },
    { id: "settings", icon: "⚙️", label: "More" },
  ];

  // ══════════════════════════════════════════════════
  //  LANDING PAGE
  // ══════════════════════════════════════════════════
  if (!raw) return (
    <div className="home">
      <div className="home-wrap">
        {/* Logo */}
        <div className="home-logo">
          <div className="home-logo-icon">📚</div>
          <div>
            <div className="home-logo-text">TxtReader <span style={{ color: "var(--accent)" }}>Legend</span></div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span className="home-logo-badge">v4</span>
              <span style={{ fontSize: 11, color: "var(--text3)" }}>AI-Powered Reading</span>
            </div>
          </div>
        </div>

        <h1 className="home-h1">
          Transform any text into a<br /><em style={{ color: "var(--accent)", fontStyle: "normal" }}>premium reading experience</em>
        </h1>
        <p className="home-sub">AI analysis · Read Aloud (TTS) · Beautiful typography · Smart navigation · Bookmarks · Highlights · Notes · Ambient sounds · Quote cards · Reading library · Works with any text file.</p>

        {/* Drop zone */}
        <div className={`drop-zone ${dragging ? "drag" : ""}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}>
          <div style={{ fontSize: 44, marginBottom: 12 }}>📂</div>
          <div style={{ fontWeight: 800, fontSize: "clamp(15px,4vw,18px)", color: "var(--heading)", marginBottom: 6 }}>
            {dragging ? "Release to open!" : "Drop your file here"}
          </div>
          <div style={{ color: "var(--text2)", fontSize: 13, marginBottom: 16 }}>or click to browse files</div>
          <div style={{ display: "flex", gap: 5, justifyContent: "center", flexWrap: "wrap" }}>
            {[".txt", ".md", ".log", ".json", ".csv", ".py", ".js", ".html", ".css", ".xml", ".yaml", ".sh"].map(e => (
              <span key={e} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 999, background: "var(--surface2)", color: "var(--text3)", fontWeight: 700 }}>{e}</span>
            ))}
          </div>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={e => loadFile(e.target.files[0])} />
        </div>

        {/* API key */}
        <div className="key-card">
          <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text2)", marginBottom: 8 }}>
            🤖 Gemini API Key <span style={{ fontWeight: 400, color: "var(--text3)" }}>(optional — for AI features)</span>
          </div>
          <input type="password" className="inp" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="AIza…" />
          <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 5 }}>Free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>aistudio.google.com</a></div>
        </div>

        {/* Features */}
        <div className="feat-grid">
          {[["🎨", "7 Themes"], ["🤖", "Gemini AI"], ["💬", "Chat"], ["✏️", "Highlights"], ["📌", "Bookmarks"], ["📊", "Analytics"], ["🔍", "Search"], ["📝", "Notes"], ["🧠", "Quiz"], ["📄", "Export"], ["🎯", "Focus"], ["⏱", "Pomodoro"], ["🔊", "Read Aloud"], ["📖", "Word Def"], ["📚", "Library"], ["🎵", "Sounds"], ["🖼", "Quote Cards"], ["💾", "Auto-Save"]].map(([icon, label]) => (
            <div key={label} className="feat-item">
              <div style={{ fontSize: 22, marginBottom: 4 }}>{icon}</div>
              <div style={{ fontWeight: 700, fontSize: 10, color: "var(--heading)" }}>{label}</div>
            </div>
          ))}
        </div>

        {/* Themes */}
        <div className="theme-strip">
          {Object.entries(THEMES).map(([key, th]) => (
            <button key={key} className={`theme-dot ${themeKey === key ? "active" : ""}`}
              onClick={() => setThemeKey(key)}
              style={{ background: th.surface, border: `2.5px solid ${themeKey === key ? th.accent : th.border}` }}
              title={th.name}>{th.emoji}</button>
          ))}
        </div>
      </div>

      <ToastStack toasts={toasts} remove={rmToast} />
    </div>
  );

  // ══════════════════════════════════════════════════
  //  READER APP
  // ══════════════════════════════════════════════════
  return (
    <div className={`app ${focusMode ? "focus" : ""}`}>
      {/* Progress bar */}
      <div className="pbar"><div className="pbar-fill" style={{ width: `${progress}%` }} /></div>

      {/* ═════════════════════ NAVBAR — DESKTOP ═════════════════════ */}
      <nav className="navbar">
        <div className="nav-desktop">

          {/* LEFT ZONE */}
          <div className="nav-zone nav-zone-left">
            {/* Panel toggles */}
            {tocItems.length > 0 && (
              <button className={`nb ${panel === "toc" ? "on" : ""}`}
                onClick={() => setPanel(panel === "toc" ? null : "toc")} title="Table of Contents">
                ≡
              </button>
            )}
            <button className={`nb ${panel === "bookmarks" ? "on" : ""}`}
              onClick={() => setPanel(panel === "bookmarks" ? null : "bookmarks")} title="Bookmarks & Highlights">
              📌
            </button>
            <button className={`nb ${panel === "stats" ? "on" : ""}`}
              onClick={() => setPanel(panel === "stats" ? null : "stats")} title="Statistics">
              📊
            </button>
            <button className={`nb ${panel === "library" ? "on" : ""}`}
              onClick={() => setPanel(panel === "library" ? null : "library")} title="Reading Library">
              📚
            </button>

            <div className="nsep" />

            {/* File pill */}
            <div className="file-pill">
              <span style={{ fontSize: 14 }}>📄</span>
              <div style={{ minWidth: 0 }}>
                <div className="file-pill-name" title={filename}>{filename}</div>
                <div className="file-pill-meta">
                  <span>{stats?.wordCount?.toLocaleString()}w</span>
                  <span>·</span>
                  <span>{stats?.readingTime}m</span>
                  <span>·</span>
                  <span style={{ color: "var(--accent)", fontWeight: 700 }}>{progress}%</span>
                </div>
              </div>
            </div>
          </div>

          {/* CENTER ZONE — Search */}
          <div className="nav-zone nav-zone-mid">
            <div className="nav-search">
              <span className="ns-ico">🔍</span>
              <input
                ref={deskSearchRef}
                type="text"
                placeholder="Search document…"
                value={searchQ}
                onChange={e => setSearchQ(e.target.value)}
              />
              {searchQ && searchHits && (
                <span className="search-badge">{searchHits.size}</span>
              )}
              {searchQ && <button className="ns-clear" onClick={() => setSearchQ("")}>×</button>}
            </div>
          </div>

          {/* RIGHT ZONE */}
          <div className="nav-zone nav-zone-right">
            <button className={`nb ${panel === "ai" ? "on" : ""}`}
              onClick={() => setPanel(panel === "ai" ? null : "ai")} title="AI Analysis">
              🤖
            </button>
            <button className={`nb ${panel === "chat" ? "on" : ""}`}
              onClick={() => setPanel(panel === "chat" ? null : "chat")} title="Chat with Document">
              💬
            </button>
            <button className={`nb ${panel === "tts" ? "on" : ""}`}
              onClick={() => setPanel(panel === "tts" ? null : "tts")} title="Read Aloud (TTS)">
              🔊
            </button>
            <button className={`nb ${panel === "sounds" ? "on" : ""}`}
              onClick={() => setPanel(panel === "sounds" ? null : "sounds")} title="Ambient Sounds">
              🎵
            </button>
            <button className={`nb ${panel === "timer" ? "on" : ""}`}
              onClick={() => setPanel(panel === "timer" ? null : "timer")} title="Pomodoro Timer">
              ⏱
            </button>

            <div className="nsep" />

            <button className={`nb ${hlMode ? "on" : ""}`}
              onClick={() => setHlMode(v => !v)} title={hlMode ? "Exit highlight mode" : "Highlight mode"}>
              ✏️
            </button>
            <button className={`nb ${focusMode ? "on" : ""}`}
              onClick={() => setFocusMode(v => !v)} title={focusMode ? "Exit focus mode" : "Focus mode"}>
              🎯
            </button>
            <button className="nb" onClick={exportHTML} title="Export HTML">⬇️</button>

            <div className="nsep" />

            <button className={`nb ${panel === "settings" ? "on" : ""}`}
              onClick={() => setPanel(panel === "settings" ? null : "settings")} title="Settings">
              ⚙️
            </button>
            <button className="nb" onClick={() => { setRaw(""); setBlocks([]); setPanel(null); }} title="Close document"
              style={{ fontSize: 13 }}>✕</button>
          </div>
        </div>

        {/* ═════════════════════ NAVBAR — MOBILE ═════════════════════ */}
        <div className="nav-mobile">
          <div className="nav-mob-top">
            <div style={{ fontSize: 20, marginRight: 8, flexShrink: 0 }}>📄</div>
            <div className="nav-mob-file">
              <div className="nav-mob-name">{filename}</div>
              <div className="nav-mob-meta">
                <span>{stats?.wordCount?.toLocaleString()}w</span>
                <span>·</span>
                <span>{stats?.readingTime}m</span>
                <span>·</span>
                <span style={{ color: "var(--accent)", fontWeight: 700 }}>{progress}%</span>
              </div>
            </div>
            <div className="nav-mob-acts">
              <button className={`nb ${showMobSearch ? "on" : ""}`}
                onClick={() => { setShowMobSearch(v => !v); setTimeout(() => mobSearchRef.current?.focus(), 80); }}>
                🔍
              </button>
              <button className={`nb ${hlMode ? "on" : ""}`} onClick={() => setHlMode(v => !v)}>✏️</button>
              <button className={`nb ${focusMode ? "on" : ""}`} onClick={() => setFocusMode(v => !v)}>🎯</button>
            </div>
          </div>

          {showMobSearch && (
            <div className="mob-searchbar">
              <span style={{ position: "absolute", left: 23, top: "50%", transform: "translateY(-50%)", color: "var(--text3)", fontSize: 13, pointerEvents: "none" }}>🔍</span>
              <input ref={mobSearchRef} type="text" placeholder="Search…"
                value={searchQ} onChange={e => setSearchQ(e.target.value)}
                style={{ paddingLeft: 34 }} />
              {searchQ && <button className="ns-clear" style={{ position: "absolute", right: 20, top: "50%", transform: "translateY(-50%)" }} onClick={() => setSearchQ("")}>×</button>}
            </div>
          )}
        </div>
      </nav>

      {/* Highlight color picker (floating, only in hlMode) */}
      {hlMode && (
        <div style={{ position: "fixed", top: 68, right: 16, zIndex: 600 }}>
          <div className="hl-picker">
            <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text3)", marginRight: 3 }}>Color:</span>
            {HLC.map(c => (
              <button key={c.id} className={`hl-dot ${hlColor === c.id ? "sel" : ""}`}
                style={{ background: c.bg }} onClick={() => setHlColor(c.id)} title={c.label} />
            ))}
            <button onClick={() => setHlMode(false)}
              style={{ background: "none", border: "none", color: "var(--text3)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 2px", marginLeft: 3 }}>×</button>
          </div>
        </div>
      )}

      {/* Mobile: backdrop + side panel (with X close) */}
      {panel && (
        <>
          <div className="panel-backdrop" onClick={() => setPanel(null)} style={{ display: window.innerWidth <= 860 ? "block" : "none" }} />
          <div className="side-panel" style={{ display: window.innerWidth <= 860 ? "flex" : "none" }}>
            <div className="sp-head">
              <span className="sp-title">{PANEL_TITLES[panel]}</span>
              <button className="sp-close" onClick={() => setPanel(null)}>✕</button>
            </div>
            <div className="sp-body">{panelContent[panel]}</div>
          </div>
        </>
      )}

      {/* ═══════════════ MAIN BODY ═══════════════ */}
      <div className="app-body">
        {/* Desktop: inline panel alongside reader */}
        {panel && (
          <div className="inline-panel">
            <div className="sp-head">
              <span className="sp-title">{PANEL_TITLES[panel]}</span>
              <button className="sp-close" onClick={() => setPanel(null)}>✕</button>
            </div>
            <div className="sp-body">{panelContent[panel]}</div>
          </div>
        )}

        {/* Reader */}
        <div className="reader-area" ref={readerRef}>
          <div className="reader-content fu">
            {blocks.map(renderBlock)}

            {/* End of document */}
            <div style={{ marginTop: 80, marginBottom: 40, textAlign: "center" }}>
              <div style={{ fontSize: 18, letterSpacing: 14, color: "var(--border)", marginBottom: 16 }}>···</div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "var(--heading)", marginBottom: 6 }}>End of Document</div>
              <div style={{ color: "var(--text3)", fontSize: 12, marginBottom: 22 }}>
                {stats?.wordCount?.toLocaleString()} words · {blocks.length} sections · {stats?.readingTime} min read
              </div>
              <div style={{ fontSize: 11, color: "var(--text3)", marginBottom: 16, opacity: .7 }}>
                💡 Double-click any word for its definition · Select text for quote cards
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap" }}>
                <button className="btn btn-p" onClick={() => readerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>↑ Back to Top</button>
                <button className="btn btn-s" onClick={exportHTML}>Export HTML</button>
                <button className="btn btn-s" onClick={() => { setRaw(""); setBlocks([]); }}>Open New File</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══════════════ MOBILE BOTTOM BAR ═══════════════ */}
      <div className="bottom-bar">
        <div className="bb-inner">
          {BB_ITEMS.map(item => (
            <button key={item.id} className={`bb-btn ${panel === item.id ? "on" : ""}`}
              onClick={() => setPanel(panel === item.id ? null : item.id)}>
              <span className="bb-ico">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═══════════════ SELECTION POPUP ═══════════════ */}
      {selPop && (
        <div className="sel-pop" style={{ left: selPop.x, top: selPop.y }}>
          <button className="sel-btn" onClick={() => { setPanel("chat"); setChatInput(`Explain this passage: "${selPop.txt.slice(0, 160)}"`); setSelPop(null); window.getSelection()?.removeAllRanges(); }}>Explain</button>
          <button className="sel-btn" onClick={() => { setPanel("chat"); setChatInput(`Summarize: "${selPop.txt.slice(0, 160)}"`); setSelPop(null); window.getSelection()?.removeAllRanges(); }}>Summarize</button>
          <button className="sel-btn" onClick={() => { setQuoteCard(selPop.txt); setSelPop(null); window.getSelection()?.removeAllRanges(); }}>🖼 Card</button>
          <button className="sel-btn" onClick={() => { navigator.clipboard?.writeText(selPop.txt); toast("✓ Copied!", "success"); setSelPop(null); window.getSelection()?.removeAllRanges(); }}>Copy</button>
          <button onClick={() => { setSelPop(null); window.getSelection()?.removeAllRanges(); }}
            style={{ background: "none", border: "none", fontSize: 16, cursor: "pointer", color: "var(--text3)", padding: "0 3px", lineHeight: 1 }}>×</button>
        </div>
      )}

      {/* ═══════════════ NOTE MODAL ═══════════════ */}
      {activeNote != null && (
        <div className="modal-ov" onClick={() => setActiveNote(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">📝 Note</div>
              <button className="sp-close" onClick={() => setActiveNote(null)}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: "var(--text3)", marginBottom: 10, lineHeight: 1.5, padding: "8px 10px", background: "var(--surface2)", borderRadius: 8 }}>
              "{(blocks.find(b => b.id === activeNote)?.text || "").slice(0, 80)}…"
            </div>
            <textarea className="inp" value={noteText} onChange={e => setNoteText(e.target.value)}
              placeholder="Write your note here… (leave empty to delete)" autoFocus />
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 14 }}>
              <button className="btn btn-s" onClick={() => setActiveNote(null)}>Cancel</button>
              <button className="btn btn-p" onClick={saveNote}>Save Note</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══════════════ QUIZ MODAL ═══════════════ */}
      {quiz && (
        <div className="modal-ov" onClick={() => setQuiz(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-head">
              <div className="modal-title">🧠 Quiz</div>
              <button className="sp-close" onClick={() => setQuiz(null)}>✕</button>
            </div>
            {quiz.loading ? (
              <div style={{ textAlign: "center", padding: 32 }}>
                <div className="spin" style={{ fontSize: 28, display: "block", marginBottom: 12 }}>⚙️</div>
                <div style={{ color: "var(--text2)", fontSize: 13 }}>Generating question…</div>
              </div>
            ) : (
              <>
                <p style={{ fontSize: 14, fontWeight: 700, marginBottom: 18, lineHeight: 1.55, color: "var(--heading)" }}>{quiz.question}</p>
                {(quiz.options || []).map((opt, i) => {
                  const isC = i === quiz.correct, isW = quizAns === i && !isC, show = quizAns != null;
                  return (
                    <button key={i} disabled={show} onClick={() => setQuizAns(i)}
                      style={{
                        width: "100%", textAlign: "left", padding: "10px 14px", marginBottom: 7,
                        borderRadius: 9, border: `1.5px solid ${show ? (isC ? "#22c55e" : isW ? "#ef4444" : "var(--border)") : "var(--border)"}`,
                        background: show ? (isC ? "#22c55e15" : isW ? "#ef444415" : "var(--surface)") : "var(--surface)",
                        cursor: show ? "default" : "pointer", fontFamily: "var(--font)", fontSize: 13, color: "var(--text)",
                        transition: "all .15s"
                      }}>
                      <span style={{ fontWeight: 800, marginRight: 8, color: "var(--accent)", fontSize: 12 }}>{["A", "B", "C", "D"][i]}</span>
                      {opt}
                      {show && isC && <span style={{ marginLeft: 8, color: "#22c55e", fontWeight: 800 }}>✓</span>}
                      {show && isW && <span style={{ marginLeft: 8, color: "#ef4444", fontWeight: 800 }}>✗</span>}
                    </button>
                  );
                })}
                {quizAns != null && (
                  <div style={{ marginTop: 12, padding: "12px 14px", background: "var(--accentBg)", borderRadius: 9, fontSize: 12, lineHeight: 1.6, borderLeft: "3px solid var(--accent)" }}>
                    <strong style={{ color: "var(--accent)" }}>Explanation: </strong>{quiz.explanation}
                  </div>
                )}
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 16 }}>
                  <button className="btn btn-s" onClick={() => setQuiz(null)}>Close</button>
                  <button className="btn btn-p" onClick={genQuiz}>Next Question →</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} remove={rmToast} />

      {/* ═══════════════ WORD DEFINITION POPUP ═══════════════ */}
      {wordDef && (
        <WordDefPopup
          word={wordDef.word}
          x={wordDef.x}
          y={wordDef.y}
          onClose={() => setWordDef(null)}
        />
      )}

      {/* ═══════════════ QUOTE CARD MODAL ═══════════════ */}
      {quoteCard && (
        <QuoteCardModal
          text={quoteCard}
          filename={filename}
          theme={T}
          onClose={() => setQuoteCard(null)}
        />
      )}
    </div>
  );
}