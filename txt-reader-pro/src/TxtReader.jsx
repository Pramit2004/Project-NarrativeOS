import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// ════════════════════════════════════════════════════════════════
// GEMINI AI — gemini-2.5-flash
// ════════════════════════════════════════════════════════════════
async function gemini(apiKey, prompt, system = "") {
  try {
    const body = {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 4096 },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    );
    const d = await res.json();
    if (d.error) throw new Error(d.error.message);
    return d.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (e) {
    return `[AI Error: ${e.message}]`;
  }
}

async function geminiJSON(apiKey, prompt) {
  const raw = await gemini(apiKey, prompt,
    "You are a precise JSON-generating AI. Respond ONLY with a valid JSON object. No markdown, no backticks, no extra text before or after the JSON.");
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned);
  } catch {
    // Try to extract JSON from within the response
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) { try { return JSON.parse(match[0]); } catch {} }
    return null;
  }
}

// ════════════════════════════════════════════════════════════════
// TEXT SANITIZER
// ════════════════════════════════════════════════════════════════
function sanitize(raw) {
  return raw
    .replace(/\\n/g, "\n").replace(/\\t/g, "\t")
    .replace(/\\r/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// ════════════════════════════════════════════════════════════════
// DOCUMENT PARSER
// ════════════════════════════════════════════════════════════════
function parseDoc(rawInput) {
  const lines = sanitize(rawInput).split("\n");
  const blocks = [];
  let id = 0;
  let i = 0;
  const nid = () => ++id;

  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }

    if (/^(chapter|part|book|volume|prologue|epilogue|interlude|act)\s*[\dIVX:.\-–—]/i.test(t)) {
      blocks.push({ id: nid(), type: "chapter", text: t }); i++; continue;
    }
    if (/^###\s+/.test(t)) { blocks.push({ id: nid(), type: "h3", text: t.replace(/^#+\s*/, "") }); i++; continue; }
    if (/^##\s+/.test(t))  { blocks.push({ id: nid(), type: "h2", text: t.replace(/^#+\s*/, "") }); i++; continue; }
    if (/^#\s+/.test(t))   { blocks.push({ id: nid(), type: "h1", text: t.replace(/^#+\s*/, "") }); i++; continue; }
    if (t === t.toUpperCase() && t.length > 3 && t.length < 65 && /[A-Z]/.test(t) && !/[.?!,;]$/.test(t) && t.split(/\s+/).length < 9) {
      blocks.push({ id: nid(), type: "heading", text: t }); i++; continue;
    }
    if (/^[-=*_~]{3,}\s*$/.test(t)) { blocks.push({ id: nid(), type: "divider" }); i++; continue; }
    if (/^[>❝""]/.test(t)) {
      const ql = [];
      while (i < lines.length && lines[i].trim() && /^[>❝""]/.test(lines[i].trim())) {
        ql.push(lines[i].trim().replace(/^[>❝""]\s*/, "")); i++;
      }
      blocks.push({ id: nid(), type: "quote", text: ql.join(" ") }); continue;
    }
    if (/^```/.test(t)) {
      const cl = []; i++;
      while (i < lines.length && !/^```/.test(lines[i].trim())) { cl.push(lines[i]); i++; }
      i++;
      blocks.push({ id: nid(), type: "code", text: cl.join("\n") }); continue;
    }
    if (/^[\s]*[-*•·◦▸▹→➤✓✗]\s/.test(line) || /^[\s]*\d+[.)]\s/.test(line)) {
      const items = [];
      while (i < lines.length && lines[i].trim() &&
        (/^[\s]*[-*•·◦▸▹→➤✓✗]\s/.test(lines[i]) || /^[\s]*\d+[.)]\s/.test(lines[i]))) {
        items.push(lines[i].trim().replace(/^[-*•·◦▸▹→➤✓✗]\s+/, "").replace(/^\d+[.)]\s+/, "")); i++;
      }
      blocks.push({ id: nid(), type: "list", items }); continue;
    }
    const pl = [];
    while (i < lines.length && lines[i].trim()) {
      const lt = lines[i].trim();
      if (/^#{1,6}\s/.test(lt) || /^[-=*_~]{3,}$/.test(lt) || /^[>❝""]/.test(lt) || /^```/.test(lt) || /^(chapter|part)\s*[\dIVX]/i.test(lt)) break;
      pl.push(lt); i++;
    }
    if (pl.length) blocks.push({ id: nid(), type: "paragraph", text: pl.join(" ") });
  }
  return blocks;
}

// ════════════════════════════════════════════════════════════════
// STATS ENGINE
// ════════════════════════════════════════════════════════════════
const STOPS = new Set("the be to of and a in that have it for on with he as you do at this but his by from they we say her she or an will my one all would there their what so up out if about who get which go me when make can like time no just him know take people into year your good some could them see other than then now look only come its over think also back after use two how our work first well way even new want because any these give day most us".split(" "));

function computeStats(raw, blocks) {
  const words = raw.match(/\b\w+\b/g) || [];
  const sentences = (raw.match(/[^.!?]+[.!?]+/g) || []).filter(s => s.trim().length > 5);
  const freq = {};
  words.forEach(w => {
    const lw = w.toLowerCase();
    if (lw.length > 3 && !STOPS.has(lw) && !/^\d+$/.test(lw)) freq[lw] = (freq[lw] || 0) + 1;
  });
  const topWords = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const unique = new Set(words.map(w => w.toLowerCase())).size;
  return {
    wordCount: words.length,
    charCount: raw.length,
    sentenceCount: sentences.length,
    paragraphCount: blocks.filter(b => b.type === "paragraph").length,
    chapterCount: blocks.filter(b => b.type === "chapter").length,
    blockCount: blocks.length,
    readingTime: Math.max(1, Math.ceil(words.length / 238)),
    avgSentLen: sentences.length ? Math.round(words.length / sentences.length) : 0,
    unique,
    lexDiv: words.length ? Math.round((unique / words.length) * 100) : 0,
    topWords,
  };
}

// ════════════════════════════════════════════════════════════════
// THEMES
// ════════════════════════════════════════════════════════════════
const THEMES = {
  cream:  { name:"Cream",  e:"☀️", bg:"#F7F3EC", s1:"#FFFFFF", s2:"#EEE9DF", s3:"#E0D9CC", tx:"#28221A", t2:"#6B5E4E", t3:"#A8998A", ac:"#C0521A", ab:"#FDF2EB", at:"#C0521A", bd:"#DDD5C8", sh:"rgba(40,34,26,.12)", hd:"#1C1710", qb:"#C0521A", cd:"#EDEBE5" },
  noir:   { name:"Noir",   e:"🌑", bg:"#111010", s1:"#1A1919", s2:"#222121", s3:"#2E2C2C", tx:"#EAE4D8", t2:"#9A9080", t3:"#5A5248", ac:"#E2B84A", ab:"#1E1900", at:"#E2B84A", bd:"#2E2C2C", sh:"rgba(0,0,0,.7)",    hd:"#F5EDD8", qb:"#E2B84A", cd:"#161515" },
  dusk:   { name:"Dusk",   e:"🌆", bg:"#18162A", s1:"#211E34", s2:"#2A263F", s3:"#333050", tx:"#E0D8F5", t2:"#8A80AA", t3:"#524870", ac:"#9D7EF5", ab:"#1E1840", at:"#C4B5FD", bd:"#343050", sh:"rgba(0,0,0,.6)",    hd:"#EDE8FF", qb:"#9D7EF5", cd:"#13111F" },
  forest: { name:"Forest", e:"🌲", bg:"#EDF3E8", s1:"#FAFFF7", s2:"#E0EDD8", s3:"#CDE3C8", tx:"#1A2E1A", t2:"#476644", t3:"#7A9A76", ac:"#2D6B2D", ab:"#D4EAD4", at:"#2D6B2D", bd:"#C4D8BE", sh:"rgba(0,40,0,.1)",  hd:"#122012", qb:"#2D6B2D", cd:"#E0EDD8" },
  slate:  { name:"Slate",  e:"🪨", bg:"#F0F2F5", s1:"#FFFFFF", s2:"#E4E8EE", s3:"#D4DAE4", tx:"#1E2530", t2:"#5A6470", t3:"#9AA2AE", ac:"#2563EB", ab:"#EEF3FF", at:"#2563EB", bd:"#D4D9E2", sh:"rgba(30,37,48,.1)", hd:"#111820", qb:"#2563EB", cd:"#EEF0F4" },
};

const FONTS = [
  { n:"Lora",         css:"'Lora', Georgia, serif" },
  { n:"Merriweather", css:"'Merriweather', Georgia, serif" },
  { n:"Crimson",      css:"'Crimson Text', Georgia, serif" },
  { n:"Georgia",      css:"Georgia, serif" },
  { n:"Palatino",     css:"Palatino, 'Book Antiqua', serif" },
  { n:"Mono",         css:"'Courier New', monospace" },
];

const HLC = [
  { id:"yellow", bg:"#FFF176", br:"#F9A825" },
  { id:"green",  bg:"#A5D6A7", br:"#43A047" },
  { id:"blue",   bg:"#90CAF9", br:"#1E88E5" },
  { id:"pink",   bg:"#F48FB1", br:"#E91E63" },
  { id:"orange", bg:"#FFCC80", br:"#FB8C00" },
];

// ════════════════════════════════════════════════════════════════
// CSS INJECTION
// ════════════════════════════════════════════════════════════════
function injectCSS(T, fontCSS) {
  let el = document.getElementById("txr-v4");
  if (!el) { el = document.createElement("style"); el.id = "txr-v4"; document.head.appendChild(el); }
  el.textContent = `
@import url('https://fonts.googleapis.com/css2?family=Lora:ital,wght@0,400;0,600;0,700;1,400;1,600&family=Merriweather:ital,wght@0,300;0,400;0,700;1,400&family=Crimson+Text:ital,wght@0,400;0,600;1,400&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden}
body{background:${T.bg};color:${T.tx};font-family:${fontCSS}}
::-webkit-scrollbar{width:4px;height:4px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:${T.bd};border-radius:99px}

@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes slideRight{from{opacity:0;transform:translateX(-12px)}to{opacity:1;transform:translateX(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}

.fu{animation:fadeUp .3s cubic-bezier(.2,1,.3,1) both}
.sr{animation:slideRight .3s cubic-bezier(.2,1,.3,1) both}
.spin{animation:spin .8s linear infinite}
.pulse{animation:pulse 1.5s ease infinite}

/* ─ toolbar button ─ */
.tb{display:inline-flex;align-items:center;justify-content:center;
  width:36px;height:36px;border-radius:8px;border:1.5px solid ${T.bd};
  background:transparent;color:${T.t2};cursor:pointer;flex-shrink:0;
  transition:background .14s,color .14s,border-color .14s,transform .1s;
  -webkit-tap-highlight-color:transparent}
.tb:hover{background:${T.s2};color:${T.tx};border-color:${T.t3}}
.tb:active{transform:scale(.9)}
.tb.on{background:${T.ab};color:${T.ac};border-color:${T.ac}}
@media(max-width:640px){.tb{width:40px;height:40px;border-radius:10px}}

/* ─ panel ─ */
.panel{
  position:fixed;top:0;left:0;bottom:0;
  width:min(320px,90vw);
  background:${T.s1};border-right:1.5px solid ${T.bd};
  z-index:300;display:flex;flex-direction:column;overflow:hidden;
  box-shadow:4px 0 32px ${T.sh};
  transition:transform .28s cubic-bezier(.2,1,.3,1)}
.panel.open{transform:translateX(0)}
.panel.closed{transform:translateX(-100%)}

/* desktop: inline panel */
@media(min-width:900px){
  .panel{position:relative;top:auto;left:auto;bottom:auto;
    box-shadow:none;transform:none!important;
    flex-shrink:0;width:290px}
  .backdrop{display:none!important}
}

/* ─ backdrop ─ */
.backdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:290;
  opacity:0;pointer-events:none;transition:opacity .28s}
.backdrop.show{opacity:1;pointer-events:all}

/* ─ paragraph block ─ */
.rp{position:relative;padding:3px 42px 3px 12px;
  margin:0 0 20px -12px;border-radius:8px;
  border-left:3px solid transparent;transition:background .14s}
.rp:hover{background:${T.s2}}
.rp.hl-yellow{background:#FFF17632!important;border-left-color:#F9A825!important}
.rp.hl-green {background:#A5D6A732!important;border-left-color:#43A047!important}
.rp.hl-blue  {background:#90CAF932!important;border-left-color:#1E88E5!important}
.rp.hl-pink  {background:#F48FB132!important;border-left-color:#E91E63!important}
.rp.hl-orange{background:#FFCC8032!important;border-left-color:#FB8C00!important}
.rp .pa{position:absolute;right:6px;top:50%;transform:translateY(-50%);
  display:flex;gap:3px;opacity:0;pointer-events:none;transition:opacity .15s}
.rp:hover .pa{opacity:1;pointer-events:all}
@media(max-width:640px){.rp .pa{opacity:1;pointer-events:all}}
.pb{width:22px;height:22px;border-radius:5px;
  border:1.5px solid ${T.bd};background:${T.s1};
  color:${T.t2};cursor:pointer;font-size:10px;
  display:flex;align-items:center;justify-content:center;
  transition:all .13s;padding:0;line-height:1}
.pb:hover{background:${T.s3};color:${T.tx}}

/* ─ toc item ─ */
.ti{display:block;width:100%;text-align:left;background:transparent;border:none;
  padding:8px 16px;cursor:pointer;color:${T.t2};font-size:13px;line-height:1.5;
  border-left:3px solid transparent;transition:all .14s;
  -webkit-tap-highlight-color:transparent}
.ti:hover,.ti:focus{background:${T.s2};color:${T.tx};border-left-color:${T.ac};outline:none}

/* ─ bubbles ─ */
.bu{align-self:flex-end;background:${T.ac};color:#fff;
  border-radius:16px 16px 4px 16px;padding:10px 14px;
  max-width:85%;font-size:13px;line-height:1.6;word-break:break-word}
.ba{align-self:flex-start;background:${T.s2};color:${T.tx};
  border-radius:16px 16px 16px 4px;padding:10px 14px;
  max-width:85%;font-size:13px;line-height:1.6;word-break:break-word}

/* ─ range ─ */
input[type=range]{-webkit-appearance:none;width:100%;height:4px;
  border-radius:2px;background:${T.bd};outline:none;cursor:pointer;display:block}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;
  width:16px;height:16px;border-radius:50%;background:${T.ac};cursor:pointer;
  box-shadow:0 0 0 3px ${T.ab}}

/* ─ chip ─ */
.chip{display:inline-flex;align-items:center;padding:3px 10px;border-radius:999px;
  font-size:11px;font-weight:600;background:${T.ab};color:${T.at};margin:2px}

/* ─ mark ─ */
mark.sm{background:${T.ab};color:${T.at};border-radius:2px;padding:0 2px;font-weight:700}

/* ─ toggle ─ */
.tog{width:42px;height:24px;border-radius:999px;border:none;cursor:pointer;
  position:relative;flex-shrink:0;transition:background .2s;-webkit-tap-highlight-color:transparent}
.tog::after{content:'';position:absolute;width:18px;height:18px;border-radius:50%;
  background:#fff;top:3px;transition:left .2s;box-shadow:0 1px 4px rgba(0,0,0,.25)}
.tog.on{background:${T.ac}}.tog.on::after{left:21px}
.tog.off{background:${T.bd}}.tog.off::after{left:3px}

/* ─ selection popup ─ */
.sp{position:fixed;z-index:9000;background:${T.s1};border:1.5px solid ${T.bd};
  border-radius:12px;padding:6px 8px;display:flex;gap:5px;align-items:center;
  box-shadow:0 8px 28px ${T.sh};animation:fadeUp .18s ease;transform:translateX(-50%)}

/* ─ section label ─ */
.sl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;
  color:${T.t3};padding:14px 16px 6px}

/* ─ ai section ─ */
.ais{background:${T.s2};border-radius:12px;padding:14px;margin-bottom:10px}
.ait{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;
  color:${T.t3};margin-bottom:8px}

/* ─ input ─ */
.inp{width:100%;background:${T.s2};border:1.5px solid ${T.bd};border-radius:9px;
  padding:9px 12px;color:${T.tx};font-size:13px;outline:none;
  transition:border-color .14s;font-family:inherit}
.inp:focus{border-color:${T.ac}}

/* ─ responsive layout ─ */
.app{height:100vh;height:100dvh;display:flex;flex-direction:column}
.app-body{flex:1;display:flex;overflow:hidden;position:relative}
.reader{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
.rc{max-width:var(--col-w,700px);margin:0 auto;padding:52px 24px}
@media(max-width:900px){.rc{padding:40px 20px}}
@media(max-width:600px){.rc{padding:28px 14px}}

/* header */
.hdr{position:sticky;top:3px;z-index:200;background:${T.s1};
  border-bottom:1.5px solid ${T.bd};box-shadow:0 2px 12px ${T.sh}}
.hdr-inner{display:flex;align-items:center;gap:6px;
  padding:0 10px;height:54px;min-width:0;overflow-x:auto;
  -webkit-overflow-scrolling:touch;scrollbar-width:none}
.hdr-inner::-webkit-scrollbar{display:none}
@media(max-width:640px){.hdr-inner{height:52px;padding:0 8px;gap:4px}}

/* progress bar */
.prog{position:fixed;top:0;left:0;right:0;height:3px;
  background:${T.bd};z-index:9999;pointer-events:none}
.prog-fill{height:100%;background:${T.ac};transition:width .15s;
  border-radius:0 2px 2px 0;box-shadow:0 0 6px ${T.ac}}

/* stat grid */
.sg{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}
.sc{background:${T.s2};border-radius:10px;padding:11px 12px}
.sv{font-size:20px;font-weight:700;color:${T.hd};line-height:1}
.sk{font-size:10px;color:${T.t3};text-transform:uppercase;letter-spacing:.8px;margin-bottom:4px}

/* modal */
.modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:8000;
  display:flex;align-items:center;justify-content:center;padding:16px}
.modal{background:${T.s1};border:1.5px solid ${T.bd};border-radius:18px;
  padding:24px;width:100%;max-width:420px;box-shadow:0 20px 60px ${T.sh}}

/* AI analysis sections */
.ai-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:10px}
@media(max-width:400px){.ai-grid{grid-template-columns:1fr}}

/* landing responsive */
.land{min-height:100vh;min-height:100dvh;
  display:flex;align-items:center;justify-content:center;
  padding:20px 16px;overflow-y:auto}
.land-box{max-width:560px;width:100%;text-align:center}
.feat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:22px}
@media(max-width:480px){.feat-grid{grid-template-columns:repeat(2,1fr)}}

/* quiz option */
.qopt{display:block;width:100%;text-align:left;margin-bottom:7px;
  padding:9px 12px;border-radius:9px;cursor:pointer;
  font-size:13px;line-height:1.4;border:1.5px solid ${T.bd};
  background:${T.s1};color:${T.tx};font-family:inherit;
  transition:all .14s;-webkit-tap-highlight-color:transparent}
.qopt:hover{border-color:${T.ac};background:${T.ab}}

/* panel scroll area */
.pscroll{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
`;
}

// ════════════════════════════════════════════════════════════════
// DOWNLOAD HELPERS
// ════════════════════════════════════════════════════════════════
function dlFile(name, content, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = name; a.click();
}

// ════════════════════════════════════════════════════════════════
// MAIN APP
// ════════════════════════════════════════════════════════════════
export default function App() {
  const [raw, setRaw] = useState("");
  const [filename, setFilename] = useState("");
  const [blocks, setBlocks] = useState([]);
  const [stats, setStats] = useState(null);
  const [themeKey, setThemeKey] = useState("cream");
  const [fontIdx, setFontIdx] = useState(0);
  const [fontSize, setFontSize] = useState(18);
  const [lh, setLh] = useState(1.85);
  const [colW, setColW] = useState(700);
  const [panel, setPanel] = useState(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [query, setQuery] = useState("");
  const [qActive, setQActive] = useState(false);
  const [bookmarks, setBookmarks] = useState([]);
  const [highlights, setHighlights] = useState({});
  const [notes, setNotes] = useState({});
  const [activeNote, setActiveNote] = useState(null);
  const [noteVal, setNoteVal] = useState("");
  const [hlMode, setHlMode] = useState(false);
  const [hlColor, setHlColor] = useState("yellow");
  const [typewriter, setTypewriter] = useState(false);
  const [gemKey, setGemKey] = useState("");
  const [aiData, setAiData] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiSection, setAiSection] = useState("overview");
  const [chat, setChat] = useState([]);
  const [chatIn, setChatIn] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [quiz, setQuiz] = useState(null);
  const [quizAns, setQuizAns] = useState(null);
  const [selPop, setSelPop] = useState(null);

  const readerRef = useRef(null);
  const fileRef = useRef(null);
  const chatEnd = useRef(null);

  const T = THEMES[themeKey];
  const F = FONTS[fontIdx];

  useEffect(() => { injectCSS(T, F.css); }, [themeKey, fontIdx]);
  useEffect(() => {
    document.documentElement.style.setProperty("--col-w", colW + "px");
  }, [colW]);

  // ── File load ──
  const loadFile = useCallback((file) => {
    if (!file) return;
    const r = new FileReader();
    r.onload = e => {
      const text = e.target.result;
      const parsed = parseDoc(text);
      setRaw(text); setFilename(file.name); setBlocks(parsed);
      setStats(computeStats(text, parsed));
      setAiData(null); setChat([]); setBookmarks([]);
      setHighlights({}); setNotes({}); setProgress(0);
      setPanel(null); setQuery("");
    };
    r.readAsText(file, "UTF-8");
  }, []);

  // ── Progress ──
  useEffect(() => {
    const el = readerRef.current;
    if (!el) return;
    const fn = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      setProgress(scrollHeight > clientHeight ? Math.round((scrollTop / (scrollHeight - clientHeight)) * 100) : 0);
    };
    el.addEventListener("scroll", fn, { passive: true });
    return () => el.removeEventListener("scroll", fn);
  }, [blocks]);

  // ── Selection popup ──
  useEffect(() => {
    const fn = () => setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (text && text.length > 8 && text.length < 1000) {
        const rect = sel.getRangeAt(0).getBoundingClientRect();
        setSelPop({ x: Math.max(80, Math.min(rect.left + rect.width / 2, window.innerWidth - 80)), y: rect.top - 8, text });
      } else setSelPop(null);
    }, 15);
    document.addEventListener("mouseup", fn);
    return () => document.removeEventListener("mouseup", fn);
  }, []);

  // ── Search ──
  const searchIds = useMemo(() => {
    if (!query.trim()) return null;
    const q = query.toLowerCase();
    return new Set(blocks.filter(b => (b.text || (b.items || []).join(" ")).toLowerCase().includes(q)).map(b => b.id));
  }, [blocks, query]);

  const hlText = useCallback((text) => {
    if (!query.trim() || !text) return text;
    const esc = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.split(new RegExp(`(${esc})`, "gi")).map((p, i) =>
      p.toLowerCase() === query.toLowerCase() ? <mark key={i} className="sm">{p}</mark> : p
    );
  }, [query]);

  const tocItems = useMemo(() => blocks.filter(b => ["chapter","h1","h2","heading"].includes(b.type)), [blocks]);

  // ── AI: Deep Analysis ──
  // Splits large docs into chunks and makes multiple calls
  const runAnalysis = async () => {
    if (!gemKey) { alert("Enter your Gemini API key first (Settings panel)."); return; }
    setAiLoading(true);
    setPanel("ai");

    const docLen = raw.length;
    // Use up to 12000 chars for comprehensive analysis
    const fullSnippet = raw.slice(0, 12000);
    const midSnippet = docLen > 12000 ? raw.slice(Math.floor(docLen / 2) - 2000, Math.floor(docLen / 2) + 2000) : "";
    const endSnippet = docLen > 8000 ? raw.slice(-3000) : "";

    const result = await geminiJSON(gemKey, `You are a world-class literary analyst. Analyze this document COMPREHENSIVELY and return a detailed JSON object.

DOCUMENT BEGINNING (first 12000 chars):
${fullSnippet}

${midSnippet ? `DOCUMENT MIDDLE SECTION:\n${midSnippet}` : ""}

${endSnippet ? `DOCUMENT END:\n${endSnippet}` : ""}

TOTAL DOCUMENT STATS: ${stats?.wordCount} words, ${stats?.paragraphCount} paragraphs, ${stats?.chapterCount} chapters, estimated ${stats?.readingTime} minutes to read.

Return this EXACT JSON structure with rich, detailed content for every field:
{
  "title": "Full inferred title of the document",
  "subtitle": "Subtitle or tagline if present, else empty string",
  "author": "Author name if detectable, else 'Unknown'",
  "genre": "Specific genre or document type (e.g. Literary Fiction, Technical Manual, Personal Essay, Academic Paper)",
  "subgenre": "More specific subgenre or style",
  "era": "Estimated time period of writing",
  "language": "Language and writing register",
  "origin": "Likely origin or context of this document",

  "executive_summary": "Compelling 5-7 sentence executive summary covering the entire document arc, key arguments, and conclusion",
  "detailed_synopsis": "Comprehensive 10-12 sentence synopsis covering beginning, middle, and end of the document. Cover all major themes, events, or arguments in detail.",
  "opening_analysis": "2-3 sentences analyzing how the document opens and its effectiveness",
  "conclusion_analysis": "2-3 sentences analyzing how the document concludes",

  "key_themes": ["theme 1 with 1 sentence explanation", "theme 2 with explanation", "theme 3", "theme 4", "theme 5"],
  "main_arguments": ["argument or point 1", "argument 2", "argument 3", "argument 4"],
  "key_characters": ["character/person name and their role in 1 sentence", "character 2"],
  "key_concepts": ["concept 1 explained briefly", "concept 2", "concept 3", "concept 4"],
  "important_quotes": ["verbatim quote 1 under 100 chars", "verbatim quote 2", "verbatim quote 3"],

  "writing_style": "3-4 sentence detailed analysis of the writing style, voice, and technique",
  "tone": "Detailed description of the emotional and rhetorical tone",
  "pov": "Point of view and narrative perspective",
  "sentence_structure": "Analysis of sentence complexity and variety",
  "vocabulary_level": "Assessment of vocabulary sophistication",

  "mood": "3-word emotional tone",
  "sentiment": "Positive / Neutral / Negative / Mixed",
  "difficulty": "Easy / Moderate / Advanced / Expert",
  "target_audience": "Detailed description of ideal reader",
  "content_warnings": ["any content warnings if applicable"],

  "strengths": ["strength 1 with explanation", "strength 2", "strength 3"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "unique_aspects": "What makes this document distinctive or memorable",
  "recommendations": "Who should read this and why in 2 sentences",

  "structure_analysis": "How the document is organized and whether it's effective",
  "progression": "How ideas or narrative develops from start to finish",

  "words_that_matter": ["word1", "word2", "word3", "word4", "word5", "word6", "word7", "word8"],
  "key_phrases": ["memorable phrase 1", "phrase 2", "phrase 3", "phrase 4"],

  "best_line": "The single most memorable or impactful sentence from the document (verbatim, under 200 chars)",
  "opening_hook_score": 7,
  "overall_rating": 7,
  "overall_rating_reason": "1-2 sentence explanation of the rating"
}`);

    setAiData(result);
    setAiLoading(false);
  };

  // ── AI Download ──
  const dlSummary = () => {
    if (!aiData) return;
    const d = aiData;
    const content = `╔══════════════════════════════════════════════════════════════╗
  AI ANALYSIS REPORT — Generated by TxtReader Pro
  Powered by Google Gemini 2.5 Flash
  Date: ${new Date().toLocaleString()}
╚══════════════════════════════════════════════════════════════╝

FILE: ${filename}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

DOCUMENT IDENTITY
━━━━━━━━━━━━━━━━━
Title:       ${d.title || "—"}
Subtitle:    ${d.subtitle || "—"}
Author:      ${d.author || "—"}
Genre:       ${d.genre || "—"} ${d.subgenre ? `(${d.subgenre})` : ""}
Era:         ${d.era || "—"}
Language:    ${d.language || "—"}
Origin:      ${d.origin || "—"}

RATINGS
━━━━━━━
Overall Rating:    ${d.overall_rating || "—"}/10
Opening Hook:      ${d.opening_hook_score || "—"}/10
Difficulty:        ${d.difficulty || "—"}
Sentiment:         ${d.sentiment || "—"}
Mood:              ${d.mood || "—"}

DOCUMENT STATS
━━━━━━━━━━━━━━
Words:             ${stats?.wordCount?.toLocaleString() || "—"}
Characters:        ${stats?.charCount?.toLocaleString() || "—"}
Paragraphs:        ${stats?.paragraphCount || "—"}
Chapters:          ${stats?.chapterCount || "—"}
Estimated Read:    ${stats?.readingTime || "—"} minutes
Avg Sentence Len:  ${stats?.avgSentLen || "—"} words
Lexical Diversity: ${stats?.lexDiv || "—"}%

EXECUTIVE SUMMARY
━━━━━━━━━━━━━━━━━
${d.executive_summary || "—"}

DETAILED SYNOPSIS
━━━━━━━━━━━━━━━━━
${d.detailed_synopsis || "—"}

OPENING ANALYSIS
━━━━━━━━━━━━━━━━
${d.opening_analysis || "—"}

CONCLUSION ANALYSIS
━━━━━━━━━━━━━━━━━━━
${d.conclusion_analysis || "—"}

KEY THEMES
━━━━━━━━━━
${(d.key_themes || []).map((t, i) => `${i + 1}. ${t}`).join("\n") || "—"}

MAIN ARGUMENTS / KEY POINTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━
${(d.main_arguments || []).map((a, i) => `${i + 1}. ${a}`).join("\n") || "—"}

KEY CHARACTERS / PEOPLE
━━━━━━━━━━━━━━━━━━━━━━━
${(d.key_characters || []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "None detected"}

KEY CONCEPTS
━━━━━━━━━━━━
${(d.key_concepts || []).map((c, i) => `${i + 1}. ${c}`).join("\n") || "—"}

IMPORTANT QUOTES
━━━━━━━━━━━━━━━━
${(d.important_quotes || []).map((q, i) => `${i + 1}. "${q}"`).join("\n") || "—"}

MOST MEMORABLE LINE
━━━━━━━━━━━━━━━━━━━
"${d.best_line || "—"}"

WRITING ANALYSIS
━━━━━━━━━━━━━━━━
Writing Style:      ${d.writing_style || "—"}
Tone:               ${d.tone || "—"}
Point of View:      ${d.pov || "—"}
Sentence Structure: ${d.sentence_structure || "—"}
Vocabulary Level:   ${d.vocabulary_level || "—"}

STRUCTURE
━━━━━━━━━
Structure Analysis: ${d.structure_analysis || "—"}
Progression:        ${d.progression || "—"}

STRENGTHS
━━━━━━━━━
${(d.strengths || []).map((s, i) => `${i + 1}. ${s}`).join("\n") || "—"}

AREAS FOR IMPROVEMENT
━━━━━━━━━━━━━━━━━━━━━
${(d.weaknesses || []).map((w, i) => `${i + 1}. ${w}`).join("\n") || "—"}

WHAT MAKES IT UNIQUE
━━━━━━━━━━━━━━━━━━━━
${d.unique_aspects || "—"}

TARGET AUDIENCE
━━━━━━━━━━━━━━━
${d.target_audience || "—"}

RECOMMENDATION
━━━━━━━━━━━━━━
${d.recommendations || "—"}

OVERALL RATING: ${d.overall_rating || "?"}/10
${d.overall_rating_reason || ""}

KEY VOCABULARY
━━━━━━━━━━━━━━
Words: ${(d.words_that_matter || []).join(", ")}
Phrases: ${(d.key_phrases || []).join(" | ")}

TOP WORDS BY FREQUENCY
━━━━━━━━━━━━━━━━━━━━━━
${(stats?.topWords || []).map(([w, c]) => `${w}: ${c}x`).join("  |  ")}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generated by TxtReader Pro v4 · Powered by Google Gemini 2.5 Flash
${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`;
    dlFile(`${filename}-ai-analysis.txt`, content);
  };

  // ── Chat ──
  const sendChat = async (override) => {
    const msg = override || chatIn.trim();
    if (!msg || chatLoading) return;
    if (!gemKey) { alert("Enter your Gemini API key first."); return; }
    setChatIn("");
    const updated = [...chat, { r: "u", t: msg }];
    setChat(updated);
    setChatLoading(true);
    const ctx = raw.slice(0, 8000);
    const hist = updated.slice(-10).map(m => `${m.r === "u" ? "User" : "AI"}: ${m.t}`).join("\n");
    const reply = await gemini(gemKey,
      `You are an expert reading assistant helping a user understand a document.\n\nDocument (excerpt, ${stats?.wordCount} words total):\n${ctx}\n\nConversation:\n${hist}\n\nAssistant:`,
      "Be helpful, insightful, and concise. If asked for a list use numbered points."
    );
    setChat([...updated, { r: "a", t: reply }]);
    setChatLoading(false);
    setTimeout(() => chatEnd.current?.scrollIntoView({ behavior: "smooth" }), 80);
  };

  const runQuiz = async () => {
    if (!gemKey) { alert("Enter your Gemini API key first."); return; }
    setQuiz({ loading: true });
    const q = await geminiJSON(gemKey,
      `Create a challenging multiple-choice question about this document. Return JSON:
{"question":"string","options":["A","B","C","D"],"correct":0,"explanation":"string explaining why correct"}
Document: ${raw.slice(0, 4000)}`);
    setQuiz(q || null);
    setQuizAns(null);
  };

  const exportHTML = () => {
    const body = blocks.map(b => {
      if (b.type === "chapter") return `<h1 class="chapter">${b.text}</h1>`;
      if (b.type === "h1" || b.type === "heading") return `<h2>${b.text}</h2>`;
      if (b.type === "h2") return `<h3>${b.text}</h3>`;
      if (b.type === "h3") return `<h4>${b.text}</h4>`;
      if (b.type === "quote") return `<blockquote><p>${b.text}</p></blockquote>`;
      if (b.type === "code") return `<pre><code>${(b.text||"").replace(/</g,"&lt;")}</code></pre>`;
      if (b.type === "list") return `<ul>${(b.items||[]).map(i=>`<li>${i}</li>`).join("")}</ul>`;
      if (b.type === "divider") return `<hr>`;
      if (b.type === "paragraph") return `<p>${b.text}</p>`;
      return "";
    }).join("\n");
    dlFile(filename.replace(/\.[^.]+$/, "") + "-formatted.html", `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${filename}</title>
<style>body{font-family:${F.css};max-width:${colW}px;margin:60px auto;padding:0 28px;background:${T.bg};color:${T.tx};line-height:${lh};font-size:${fontSize}px}
h1.chapter{text-align:center;font-size:2.2em;margin:60px 0 30px;border-bottom:2px solid ${T.ac}40;padding-bottom:16px}
h2{font-size:1.5em;margin:44px 0 16px;border-bottom:1px solid ${T.bd};padding-bottom:8px}
h3{font-size:1.2em;margin:32px 0 12px}h4{font-size:1.05em;margin:24px 0 8px}
p{margin:0 0 20px;text-align:justify}
blockquote{border-left:4px solid ${T.ac};padding:12px 20px;margin:24px 0;background:${T.ab};border-radius:0 10px 10px 0;font-style:italic}
pre{background:${T.cd};padding:16px;border-radius:10px;overflow-x:auto;font-size:13px;margin:20px 0}
ul{margin:14px 0;padding-left:22px}li{margin-bottom:8px}hr{border:none;border-top:1px solid ${T.bd};margin:36px 0}
</style></head><body>${body}
<hr><p style="text-align:center;opacity:.4;font-size:11px">Exported with TxtReader Pro · ${new Date().toLocaleDateString()}</p>
</body></html>`, "text/html");
  };

  const toggleBM = (id) => setBookmarks(p => p.some(b => b.blockId === id) ? p.filter(b => b.blockId !== id) : [...p, { id: Date.now(), blockId: id }]);
  const scrollTo = (id) => document.getElementById(`b${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  const openPanel = (name) => setPanel(p => p === name ? null : name);

  // ── Render Block ──
  const renderBlock = (b) => {
    const bm = bookmarks.some(x => x.blockId === b.id);
    const hlc = highlights[b.id];
    const inSearch = !searchIds || searchIds.has(b.id);
    const hasNote = !!notes[b.id];
    const op = inSearch ? 1 : 0.18;

    const Actions = () => (
      <div className="pa">
        <button className="pb" title={bm ? "Remove bookmark" : "Bookmark"} onClick={() => toggleBM(b.id)}>
          {bm ? "🔖" : "◻"}
        </button>
        {HLC.map(c => (
          <button key={c.id} className="pb" onClick={() => setHighlights(h => ({ ...h, [b.id]: h[b.id] === c.id ? undefined : c.id }))}
            style={{ background: hlc === c.id ? c.bg : "transparent", border: `1.5px solid ${hlc === c.id ? c.br : T.bd}`, width: 18, height: 18, borderRadius: 4 }}>
            <span style={{ display: "block", width: 10, height: 10, borderRadius: 2, background: c.bg, margin: "auto" }} />
          </button>
        ))}
        <button className="pb" title="Note" onClick={() => { setActiveNote(b.id); setNoteVal(notes[b.id] || ""); }}>✏</button>
      </div>
    );

    const s = { opacity: op, transition: "opacity .2s" };

    if (b.type === "divider") return (
      <div key={b.id} id={`b${b.id}`} style={{ margin: "40px 0", display: "flex", alignItems: "center", gap: 12, ...s }}>
        <div style={{ flex: 1, height: 1, background: T.bd }} />
        <span style={{ color: T.t3, fontSize: 16, letterSpacing: 8 }}>· · ·</span>
        <div style={{ flex: 1, height: 1, background: T.bd }} />
      </div>
    );

    if (b.type === "chapter") return (
      <div key={b.id} id={`b${b.id}`} style={{ margin: "64px 0 28px", textAlign: "center", ...s }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.ac, textTransform: "uppercase", letterSpacing: 4, marginBottom: 8 }}>— Chapter —</div>
        <h1 style={{ fontSize: `${fontSize * 2}px`, fontWeight: 700, color: T.hd, lineHeight: 1.2, letterSpacing: "-0.5px" }}>{hlText(b.text)}</h1>
        <div style={{ width: 52, height: 3, background: T.ac, borderRadius: 999, margin: "16px auto 0" }} />
      </div>
    );

    if (b.type === "h1" || b.type === "heading") return (
      <h2 key={b.id} id={`b${b.id}`} style={{ fontSize: `${fontSize * 1.5}px`, fontWeight: 700, color: T.hd, margin: "48px 0 16px", lineHeight: 1.25, paddingBottom: 10, borderBottom: `1.5px solid ${T.bd}`, ...s }}>
        {hlText(b.text)}
      </h2>
    );

    if (b.type === "h2") return (
      <h3 key={b.id} id={`b${b.id}`} style={{ fontSize: `${fontSize * 1.22}px`, fontWeight: 700, color: T.hd, margin: "36px 0 12px", lineHeight: 1.3, ...s }}>
        {hlText(b.text)}
      </h3>
    );

    if (b.type === "h3") return (
      <h4 key={b.id} id={`b${b.id}`} style={{ fontSize: `${fontSize * 1.06}px`, fontWeight: 600, color: T.hd, margin: "26px 0 8px", lineHeight: 1.4, ...s }}>
        {hlText(b.text)}
      </h4>
    );

    if (b.type === "quote") return (
      <blockquote key={b.id} id={`b${b.id}`} style={{ margin: "28px 0", padding: "16px 20px", borderLeft: `4px solid ${T.qb}`, background: T.ab, borderRadius: "0 12px 12px 0", ...s }}>
        <p style={{ fontSize: `${fontSize * 1.03}px`, fontStyle: "italic", color: T.tx, lineHeight: lh, margin: 0, opacity: .92 }}>{hlText(b.text)}</p>
      </blockquote>
    );

    if (b.type === "code") return (
      <pre key={b.id} id={`b${b.id}`} style={{ margin: "22px 0", padding: "16px 18px", background: T.cd, border: `1.5px solid ${T.bd}`, borderRadius: 10, fontSize: 13, lineHeight: 1.6, color: T.tx, overflowX: "auto", fontFamily: "'Courier New',monospace", whiteSpace: "pre-wrap", wordBreak: "break-word", ...s }}>
        {b.text}
      </pre>
    );

    if (b.type === "list") return (
      <ul key={b.id} id={`b${b.id}`} style={{ margin: "16px 0", padding: 0, listStyle: "none", ...s }}>
        {(b.items || []).map((item, i) => (
          <li key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 10, fontSize, lineHeight: lh, color: T.tx }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.ac, flexShrink: 0, marginTop: `${fontSize * .42}px` }} />
            <span>{hlText(item)}</span>
          </li>
        ))}
      </ul>
    );

    return (
      <div key={b.id} id={`b${b.id}`}
        className={`rp ${hlc ? `hl-${hlc}` : ""}`}
        style={{ ...s, cursor: hlMode ? "pointer" : "text" }}
        onClick={() => hlMode && setHighlights(h => ({ ...h, [b.id]: h[b.id] === hlColor ? undefined : hlColor }))}>
        <p style={{ fontSize, lineHeight: lh, color: T.tx, margin: 0, textAlign: "justify", hyphens: "auto" }}>{hlText(b.text)}</p>
        {hasNote && <div style={{ marginTop: 6, padding: "5px 10px", background: T.ab, borderRadius: 7, fontSize: 12, color: T.at, fontStyle: "italic" }}>📝 {notes[b.id]}</div>}
        <Actions />
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════
  // AI ANALYSIS PANEL — structured sections
  // ════════════════════════════════════════════════════════════════
  const aiSections = [
    { id: "overview", label: "Overview" },
    { id: "summary", label: "Summary" },
    { id: "themes", label: "Themes" },
    { id: "writing", label: "Writing" },
    { id: "quotes", label: "Quotes" },
    { id: "critique", label: "Critique" },
    { id: "quiz", label: "Quiz" },
  ];

  const renderAI = () => {
    if (!gemKey) return (
      <div style={{ padding: "12px 16px" }}>
        <div style={{ background: T.ab, border: `1.5px solid ${T.ac}`, borderRadius: 10, padding: "12px 14px", marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.ac, marginBottom: 8 }}>⚠️ Gemini API Key Required</div>
          <input type="password" value={gemKey} onChange={e => setGemKey(e.target.value)} placeholder="AIza…" className="inp" style={{ fontSize: 12 }} />
          <div style={{ fontSize: 11, color: T.t3, marginTop: 6 }}>Get free key: aistudio.google.com</div>
        </div>
        <button onClick={runAnalysis} style={{ width: "100%", background: T.ac, color: "#fff", border: "none", borderRadius: 11, padding: "13px", cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: F.css }}>
          ✨ Analyze with Gemini 2.5 Flash
        </button>
      </div>
    );

    if (!aiData && !aiLoading) return (
      <div style={{ padding: "12px 16px" }}>
        <div style={{ background: T.s2, borderRadius: 12, padding: 14, marginBottom: 12, fontSize: 13, color: T.t2, lineHeight: 1.65 }}>
          Gemini will perform a <strong style={{ color: T.tx }}>deep, comprehensive analysis</strong> — extracting every insight possible: full synopsis, themes, characters, writing style, key quotes, critique, and more.
        </div>
        <button onClick={runAnalysis} style={{ width: "100%", background: T.ac, color: "#fff", border: "none", borderRadius: 11, padding: "13px", cursor: "pointer", fontSize: 15, fontWeight: 700, fontFamily: F.css }}>
          ✨ Analyze with Gemini 2.5 Flash
        </button>
      </div>
    );

    if (aiLoading) return (
      <div style={{ padding: "40px 16px", textAlign: "center" }}>
        <div className="spin" style={{ display: "inline-block", fontSize: 36, marginBottom: 16 }}>⚙️</div>
        <div style={{ fontWeight: 700, fontSize: 15, color: T.hd, marginBottom: 6 }}>Deep Analysis in Progress</div>
        <div style={{ color: T.t2, fontSize: 13, lineHeight: 1.6 }}>Gemini 2.5 Flash is reading<br />your entire document…</div>
      </div>
    );

    const d = aiData;

    return (
      <div className="fu">
        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, padding: "8px 12px", flexWrap: "wrap", borderBottom: `1px solid ${T.bd}` }}>
          {aiSections.map(s => (
            <button key={s.id} onClick={() => setAiSection(s.id)}
              style={{ padding: "4px 10px", borderRadius: 20, border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, fontFamily: F.css, background: aiSection === s.id ? T.ac : T.s2, color: aiSection === s.id ? "#fff" : T.t2, transition: "all .14s" }}>
              {s.label}
            </button>
          ))}
        </div>

        <div className="pscroll" style={{ padding: "12px 16px" }}>

          {/* OVERVIEW */}
          {aiSection === "overview" && (
            <div>
              {/* Identity card */}
              <div className="ais">
                <div style={{ fontWeight: 700, fontSize: 16, color: T.hd, marginBottom: 3 }}>{d.title}</div>
                {d.subtitle && <div style={{ fontSize: 13, color: T.t2, marginBottom: 6 }}>{d.subtitle}</div>}
                <div style={{ fontSize: 12, color: T.t3, marginBottom: 10 }}>
                  {[d.author, d.genre, d.subgenre, d.era].filter(Boolean).join(" · ")}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
                  {[d.mood, d.difficulty, d.sentiment].filter(Boolean).map(t => <span key={t} className="chip">{t}</span>)}
                </div>
                {d.language && <div style={{ fontSize: 12, color: T.t3 }}>Language: {d.language}</div>}
                {d.origin && <div style={{ fontSize: 12, color: T.t3, marginTop: 2 }}>Context: {d.origin}</div>}
              </div>

              {/* Ratings */}
              <div className="ai-grid">
                <div className="sc">
                  <div className="sk">Overall</div>
                  <div className="sv">{d.overall_rating || "—"}<span style={{ fontSize: 13, fontWeight: 400, color: T.t3 }}>/10</span></div>
                </div>
                <div className="sc">
                  <div className="sk">Opening</div>
                  <div className="sv">{d.opening_hook_score || "—"}<span style={{ fontSize: 13, fontWeight: 400, color: T.t3 }}>/10</span></div>
                </div>
              </div>
              {d.overall_rating_reason && (
                <div style={{ fontSize: 12, color: T.t2, fontStyle: "italic", marginBottom: 10, lineHeight: 1.6 }}>{d.overall_rating_reason}</div>
              )}

              {/* Target audience */}
              {d.target_audience && (
                <div className="ais">
                  <div className="ait">Target Audience</div>
                  <div style={{ fontSize: 13, color: T.tx, lineHeight: 1.6 }}>{d.target_audience}</div>
                </div>
              )}

              {/* Download button */}
              <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                <button onClick={dlSummary} style={{ flex: 1, background: T.ac, color: "#fff", border: "none", borderRadius: 10, padding: "10px 12px", cursor: "pointer", fontFamily: F.css, fontSize: 13, fontWeight: 700 }}>
                  ⬇ Download Full Report
                </button>
                <button onClick={runAnalysis} style={{ background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "10px 12px", cursor: "pointer", color: T.t2, fontSize: 14 }}>🔄</button>
              </div>
            </div>
          )}

          {/* SUMMARY */}
          {aiSection === "summary" && (
            <div>
              {d.executive_summary && (
                <div className="ais">
                  <div className="ait">Executive Summary</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.75 }}>{d.executive_summary}</p>
                </div>
              )}
              {d.detailed_synopsis && (
                <div className="ais">
                  <div className="ait">Full Synopsis</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.75 }}>{d.detailed_synopsis}</p>
                </div>
              )}
              {d.opening_analysis && (
                <div className="ais">
                  <div className="ait">Opening</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.opening_analysis}</p>
                </div>
              )}
              {d.conclusion_analysis && (
                <div className="ais">
                  <div className="ait">Conclusion</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.conclusion_analysis}</p>
                </div>
              )}
              {d.progression && (
                <div className="ais">
                  <div className="ait">How It Develops</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.progression}</p>
                </div>
              )}
            </div>
          )}

          {/* THEMES */}
          {aiSection === "themes" && (
            <div>
              {(d.key_themes || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Key Themes</div>
                  {d.key_themes.map((t, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                      <span style={{ background: T.ac, color: "#fff", borderRadius: 999, width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{i + 1}</span>
                      <span style={{ fontSize: 13, color: T.tx, lineHeight: 1.6 }}>{t}</span>
                    </div>
                  ))}
                </div>
              )}
              {(d.main_arguments || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Main Arguments / Key Points</div>
                  {d.main_arguments.map((a, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, marginBottom: 9, alignItems: "flex-start" }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: T.ac, flexShrink: 0, marginTop: 6 }} />
                      <span style={{ fontSize: 13, color: T.tx, lineHeight: 1.6 }}>{a}</span>
                    </div>
                  ))}
                </div>
              )}
              {(d.key_concepts || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Key Concepts</div>
                  {d.key_concepts.map((c, i) => (
                    <div key={i} style={{ fontSize: 13, color: T.tx, lineHeight: 1.6, marginBottom: 7, paddingLeft: 12, borderLeft: `2px solid ${T.ac}` }}>{c}</div>
                  ))}
                </div>
              )}
              {(d.key_characters || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Key Characters / People</div>
                  {d.key_characters.map((c, i) => (
                    <div key={i} style={{ fontSize: 13, color: T.tx, lineHeight: 1.6, marginBottom: 8, display: "flex", gap: 8 }}>
                      <span style={{ fontSize: 14 }}>👤</span>
                      <span>{c}</span>
                    </div>
                  ))}
                </div>
              )}
              {(d.words_that_matter || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Words That Matter</div>
                  <div>{d.words_that_matter.map(w => <span key={w} style={{ display: "inline-block", margin: 2, padding: "3px 10px", borderRadius: 999, background: T.s3, color: T.t2, fontSize: 12, fontWeight: 600 }}>{w}</span>)}</div>
                </div>
              )}
              {(d.key_phrases || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Key Phrases</div>
                  {d.key_phrases.map((p, i) => (
                    <div key={i} style={{ fontSize: 12, fontStyle: "italic", color: T.t2, marginBottom: 5, padding: "4px 10px", background: T.s3, borderRadius: 6 }}>"{p}"</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* WRITING */}
          {aiSection === "writing" && (
            <div>
              {d.writing_style && (
                <div className="ais">
                  <div className="ait">Writing Style</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.72 }}>{d.writing_style}</p>
                </div>
              )}
              {d.tone && (
                <div className="ais">
                  <div className="ait">Tone</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.tone}</p>
                </div>
              )}
              {d.pov && (
                <div className="ais">
                  <div className="ait">Point of View</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.pov}</p>
                </div>
              )}
              {d.sentence_structure && (
                <div className="ais">
                  <div className="ait">Sentence Structure</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.sentence_structure}</p>
                </div>
              )}
              {d.vocabulary_level && (
                <div className="ais">
                  <div className="ait">Vocabulary</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.vocabulary_level}</p>
                </div>
              )}
              {d.structure_analysis && (
                <div className="ais">
                  <div className="ait">Document Structure</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.structure_analysis}</p>
                </div>
              )}
              {d.unique_aspects && (
                <div className="ais">
                  <div className="ait">What Makes It Unique</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.unique_aspects}</p>
                </div>
              )}
            </div>
          )}

          {/* QUOTES */}
          {aiSection === "quotes" && (
            <div>
              {d.best_line && (
                <div style={{ borderLeft: `4px solid ${T.qb}`, padding: "14px 18px", background: T.ab, borderRadius: "0 14px 14px 0", marginBottom: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: T.ac, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>⭐ Most Memorable Line</div>
                  <p style={{ fontSize: 14, fontStyle: "italic", color: T.tx, lineHeight: 1.7, fontWeight: 500 }}>"{d.best_line}"</p>
                </div>
              )}
              {(d.important_quotes || []).map((q, i) => (
                <div key={i} style={{ borderLeft: `3px solid ${T.bd}`, padding: "12px 16px", background: T.s2, borderRadius: "0 10px 10px 0", marginBottom: 10 }}>
                  <div style={{ fontSize: 10, color: T.t3, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>Quote {i + 1}</div>
                  <p style={{ fontSize: 13, fontStyle: "italic", color: T.tx, lineHeight: 1.65 }}>"{q}"</p>
                </div>
              ))}
              {(d.key_phrases || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Key Phrases</div>
                  {d.key_phrases.map((p, i) => (
                    <div key={i} style={{ fontSize: 13, fontStyle: "italic", color: T.t2, marginBottom: 6, padding: "6px 12px", background: T.s3, borderRadius: 7 }}>"{p}"</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* CRITIQUE */}
          {aiSection === "critique" && (
            <div>
              {(d.strengths || []).length > 0 && (
                <div className="ais">
                  <div className="ait" style={{ color: "#43A047" }}>✅ Strengths</div>
                  {d.strengths.map((s, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
                      <span style={{ color: "#43A047", fontSize: 14, flexShrink: 0 }}>+</span>
                      <span style={{ fontSize: 13, color: T.tx, lineHeight: 1.6 }}>{s}</span>
                    </div>
                  ))}
                </div>
              )}
              {(d.weaknesses || []).length > 0 && (
                <div className="ais">
                  <div className="ait" style={{ color: "#E53935" }}>⚠️ Areas for Improvement</div>
                  {d.weaknesses.map((w, i) => (
                    <div key={i} style={{ display: "flex", gap: 10, marginBottom: 9 }}>
                      <span style={{ color: "#E53935", fontSize: 14, flexShrink: 0 }}>−</span>
                      <span style={{ fontSize: 13, color: T.tx, lineHeight: 1.6 }}>{w}</span>
                    </div>
                  ))}
                </div>
              )}
              {d.recommendations && (
                <div className="ais">
                  <div className="ait">Recommendation</div>
                  <p style={{ fontSize: 13, color: T.tx, lineHeight: 1.7 }}>{d.recommendations}</p>
                </div>
              )}
              {(d.content_warnings || []).length > 0 && (
                <div className="ais">
                  <div className="ait">Content Notes</div>
                  {d.content_warnings.map((w, i) => <div key={i} style={{ fontSize: 13, color: T.t2, marginBottom: 4 }}>• {w}</div>)}
                </div>
              )}
            </div>
          )}

          {/* QUIZ */}
          {aiSection === "quiz" && (
            <div>
              <div style={{ fontSize: 13, color: T.t2, lineHeight: 1.6, marginBottom: 12 }}>
                Test your understanding of the document with AI-generated questions.
              </div>
              {!quiz && (
                <button onClick={runQuiz} style={{ width: "100%", background: T.ac, color: "#fff", border: "none", borderRadius: 11, padding: "12px", cursor: "pointer", fontFamily: F.css, fontSize: 14, fontWeight: 700 }}>
                  🧠 Generate Quiz Question
                </button>
              )}
              {quiz?.loading && <div className="pulse" style={{ color: T.t2, fontSize: 13, textAlign: "center", padding: "20px 0" }}>Generating quiz…</div>}
              {quiz && !quiz.loading && (
                <div>
                  <div className="ais">
                    <div className="ait">Question</div>
                    <p style={{ fontSize: 14, fontWeight: 600, color: T.hd, lineHeight: 1.5, marginBottom: 14 }}>{quiz.question}</p>
                    {(quiz.options || []).map((opt, i) => {
                      let bg = T.s1, bc = T.bd, col = T.tx;
                      if (quizAns !== null) {
                        if (i === quiz.correct) { bg = "#A5D6A740"; bc = "#43A047"; }
                        else if (i === quizAns) { bg = "#F48FB140"; bc = "#E91E63"; }
                      }
                      return (
                        <button key={i} className="qopt" onClick={() => setQuizAns(i)} style={{ background: bg, borderColor: bc, color: col }}>
                          <span style={{ fontWeight: 700, color: T.ac, marginRight: 8 }}>{["A", "B", "C", "D"][i]}.</span>{opt}
                        </button>
                      );
                    })}
                    {quizAns !== null && (
                      <div style={{ marginTop: 10, padding: "10px 12px", background: T.ab, borderRadius: 9, fontSize: 12, color: T.tx, lineHeight: 1.65 }}>
                        {quizAns === quiz.correct ? "✅ Correct! " : "❌ Not quite. "}{quiz.explanation}
                      </div>
                    )}
                  </div>
                  <button onClick={runQuiz} style={{ width: "100%", background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "9px", cursor: "pointer", color: T.t2, fontSize: 13, fontFamily: F.css }}>
                    Next Question →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  // ════════════════════════════════════════════════════════════════
  // LANDING SCREEN
  // ════════════════════════════════════════════════════════════════
  if (!raw) return (
    <div className="land" style={{ background: T.bg, color: T.tx, fontFamily: F.css }}>
      <div className="land-box">
        <div style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: "9px 20px", background: T.s1, border: `1.5px solid ${T.bd}`, borderRadius: 999, marginBottom: 24, boxShadow: `0 4px 20px ${T.sh}` }}>
          <span style={{ fontSize: 24 }}>📖</span>
          <span style={{ fontWeight: 700, fontSize: 18, color: T.hd }}>TxtReader <span style={{ color: T.ac }}>Pro</span></span>
          <span style={{ fontSize: 9, background: T.ab, color: T.ac, padding: "2px 7px", borderRadius: 999, fontWeight: 700 }}>v4</span>
        </div>

        <h1 style={{ fontSize: "clamp(24px,6vw,42px)", fontWeight: 700, color: T.hd, letterSpacing: "-1px", lineHeight: 1.15, marginBottom: 12 }}>
          Read any text file<br />like a <span style={{ color: T.ac }}>premium book</span>
        </h1>
        <p style={{ color: T.t2, fontSize: "clamp(13px,3vw,16px)", lineHeight: 1.7, marginBottom: 28, maxWidth: 420, margin: "0 auto 28px" }}>
          Deep AI analysis, chat with your document, highlight, bookmark, and export — all beautifully rendered on any device.
        </p>

        {/* Drop zone */}
        <div
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); loadFile(e.dataTransfer.files[0]); }}
          onClick={() => fileRef.current?.click()}
          style={{ border: `2px dashed ${dragging ? T.ac : T.bd}`, background: dragging ? T.ab : T.s1, borderRadius: 18, padding: "clamp(28px,6vw,44px) 24px", cursor: "pointer", transition: "all .2s", marginBottom: 18 }}>
          <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
          <div style={{ fontWeight: 700, fontSize: "clamp(14px,4vw,17px)", color: T.hd, marginBottom: 5 }}>
            {dragging ? "Release to open" : "Drop your file here"}
          </div>
          <div style={{ color: T.t2, fontSize: 13, marginBottom: 12 }}>or tap to browse</div>
          <div style={{ display: "flex", gap: 4, justifyContent: "center", flexWrap: "wrap" }}>
            {[".txt", ".md", ".log", ".json", ".csv", ".py", ".js", ".yaml", ".xml"].map(e => (
              <span key={e} style={{ fontSize: 10, padding: "2px 7px", borderRadius: 999, background: T.s2, color: T.t3, fontWeight: 600 }}>{e}</span>
            ))}
          </div>
          <input ref={fileRef} type="file" style={{ display: "none" }} onChange={e => loadFile(e.target.files[0])} />
        </div>

        {/* Gemini key */}
        <div style={{ background: T.s1, border: `1.5px solid ${T.bd}`, borderRadius: 14, padding: "14px 16px", marginBottom: 18, textAlign: "left" }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.t2, marginBottom: 7 }}>
            🤖 Gemini API Key <span style={{ fontWeight: 400, color: T.t3 }}>(for AI features)</span>
          </div>
          <input type="password" value={gemKey} onChange={e => setGemKey(e.target.value)} placeholder="AIza…" className="inp" style={{ fontSize: 13 }} />
          <div style={{ fontSize: 11, color: T.t3, marginTop: 5 }}>Free at aistudio.google.com · Never stored externally</div>
        </div>

        {/* Features */}
        <div className="feat-grid">
          {[["🎨", "5 Themes"], ["🤖", "Gemini AI"], ["💬", "Chat w/ Doc"], ["✏️", "Highlight × 5"], ["🔖", "Bookmarks"], ["📊", "Analytics"], ["🔍", "Search"], ["💾", "Export"], ["🧠", "Quiz"]].map(([e, l]) => (
            <div key={l} style={{ background: T.s1, border: `1.5px solid ${T.bd}`, borderRadius: 11, padding: "11px 10px", textAlign: "left" }}>
              <div style={{ fontSize: 20, marginBottom: 4 }}>{e}</div>
              <div style={{ fontWeight: 600, fontSize: 11, color: T.hd }}>{l}</div>
            </div>
          ))}
        </div>

        {/* Theme picker */}
        <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
          {Object.entries(THEMES).map(([k, t]) => (
            <button key={k} onClick={() => setThemeKey(k)} title={t.name}
              style={{ width: 38, height: 38, borderRadius: 10, background: t.s1, border: `2.5px solid ${themeKey === k ? t.ac : t.bd}`, cursor: "pointer", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", transition: "all .15s" }}>
              {t.e}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  // ════════════════════════════════════════════════════════════════
  // READER SCREEN
  // ════════════════════════════════════════════════════════════════
  const panelOpen = !!panel && !focusMode;

  return (
    <div className="app" style={{ background: T.bg, color: T.tx, fontFamily: F.css }}>

      {/* Selection popup */}
      {selPop && (
        <div className="sp" style={{ left: selPop.x, top: selPop.y }}>
          <span style={{ fontSize: 11, color: T.t3, whiteSpace: "nowrap" }}>✨</span>
          <button onClick={() => { setPanel("chat"); setChatIn(`Explain this passage: "${selPop.text.slice(0, 280)}"`); setSelPop(null); }}
            style={{ background: T.ac, color: "#fff", border: "none", borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontWeight: 700, fontFamily: F.css }}>Explain</button>
          <button onClick={() => { setPanel("chat"); setChatIn(`Summarize this: "${selPop.text.slice(0, 280)}"`); setSelPop(null); }}
            style={{ background: T.s2, color: T.tx, border: `1px solid ${T.bd}`, borderRadius: 7, padding: "4px 10px", cursor: "pointer", fontSize: 12, fontFamily: F.css }}>Summarize</button>
          <button onClick={() => setSelPop(null)} style={{ background: "none", border: "none", color: T.t3, cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "0 2px" }}>×</button>
        </div>
      )}

      {/* Note modal */}
      {activeNote !== null && (
        <div className="modal-bg" onClick={() => setActiveNote(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div style={{ fontWeight: 700, fontSize: 15, color: T.hd, marginBottom: 14 }}>📝 Add Note</div>
            <textarea value={noteVal} onChange={e => setNoteVal(e.target.value)} placeholder="Your note…"
              autoFocus
              style={{ width: "100%", minHeight: 90, background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "10px 12px", color: T.tx, fontSize: 14, outline: "none", resize: "vertical", fontFamily: F.css, lineHeight: 1.6 }} />
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "flex-end" }}>
              <button onClick={() => setActiveNote(null)}
                style={{ background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 9, padding: "8px 16px", cursor: "pointer", color: T.t2, fontSize: 13, fontFamily: F.css }}>Cancel</button>
              <button onClick={() => { setNotes(n => ({ ...n, [activeNote]: noteVal })); setActiveNote(null); }}
                style={{ background: T.ac, border: "none", borderRadius: 9, padding: "8px 18px", cursor: "pointer", color: "#fff", fontSize: 13, fontWeight: 700, fontFamily: F.css }}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Progress bar */}
      <div className="prog"><div className="prog-fill" style={{ width: `${progress}%` }} /></div>

      {/* ── HEADER ── */}
      {!focusMode && (
        <div className="hdr">
          <div className="hdr-inner">
            <span style={{ fontSize: 20, flexShrink: 0 }}>📖</span>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: T.hd, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {filename.length > 24 ? filename.slice(0, 24) + "…" : filename}
              </div>
              <div style={{ fontSize: 10, color: T.t3 }}>{stats?.wordCount?.toLocaleString()}w · {stats?.readingTime}m · {progress}%</div>
            </div>

            {/* Search */}
            <div style={{ position: "relative", flexShrink: 0 }}>
              <span style={{ position: "absolute", left: 8, top: "50%", transform: "translateY(-50%)", fontSize: 12, color: T.t3, pointerEvents: "none" }}>🔍</span>
              <input value={query} onChange={e => setQuery(e.target.value)}
                onFocus={() => setQActive(true)} onBlur={() => setQActive(false)}
                placeholder="Search…"
                style={{ width: qActive ? 150 : 90, background: T.s2, border: `1.5px solid ${qActive ? T.ac : T.bd}`, borderRadius: 8, padding: "6px 26px 6px 26px", color: T.tx, fontSize: 13, outline: "none", transition: "width .2s,border-color .15s", fontFamily: F.css }} />
              {query && <button onClick={() => setQuery("")} style={{ position: "absolute", right: 7, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: T.t3, fontSize: 14, lineHeight: 1 }}>×</button>}
            </div>

            {/* Highlight toggle */}
            <button className={`tb ${hlMode ? "on" : ""}`} title="Highlight mode" onClick={() => setHlMode(h => !h)}>✏️</button>
            {hlMode && (
              <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
                {HLC.map(c => (
                  <button key={c.id} onClick={() => setHlColor(c.id)}
                    style={{ width: 20, height: 20, borderRadius: 5, background: c.bg, border: `2.5px solid ${hlColor === c.id ? T.tx : c.br}`, cursor: "pointer", flexShrink: 0, padding: 0 }} />
                ))}
              </div>
            )}

            {/* Panel buttons */}
            {tocItems.length > 0 && <button className={`tb ${panel === "toc" ? "on" : ""}`} title="Contents" onClick={() => openPanel("toc")}>≡</button>}
            <button className={`tb ${panel === "bookmarks" ? "on" : ""}`} title="Bookmarks" onClick={() => openPanel("bookmarks")}>🔖</button>
            <button className={`tb ${panel === "stats" ? "on" : ""}`} title="Stats" onClick={() => openPanel("stats")}>📊</button>
            <button className={`tb ${panel === "ai" ? "on" : ""}`} title="AI Analysis" onClick={() => openPanel("ai")}>🤖</button>
            <button className={`tb ${panel === "chat" ? "on" : ""}`} title="Chat" onClick={() => openPanel("chat")}>💬</button>
            <button className={`tb ${panel === "settings" ? "on" : ""}`} title="Settings" onClick={() => openPanel("settings")}>⚙️</button>
            <button className="tb" title="Focus Mode" onClick={() => setFocusMode(true)}>🎯</button>
            <button className="tb" title="Export HTML" onClick={exportHTML}>⬇</button>
            <button className="tb" title="Close" onClick={() => { setRaw(""); setBlocks([]); }}>✕</button>
          </div>
        </div>
      )}

      {/* Focus mode exit */}
      {focusMode && (
        <div style={{ position: "fixed", top: 12, right: 12, zIndex: 400, display: "flex", gap: 8 }}>
          <div style={{ background: T.s1, border: `1.5px solid ${T.bd}`, borderRadius: 9, padding: "5px 12px", fontSize: 12, color: T.t2 }}>
            {progress}% · ~{Math.max(0, stats.readingTime - Math.round(progress / 100 * stats.readingTime))}m left
          </div>
          <button className="tb" onClick={() => setFocusMode(false)}>✕</button>
        </div>
      )}

      {/* ── BODY ── */}
      <div className="app-body">

        {/* Backdrop (mobile) */}
        <div className={`backdrop ${panelOpen ? "show" : ""}`} onClick={() => setPanel(null)} />

        {/* ── PANEL ── */}
        <div className={`panel ${panelOpen ? "open" : "closed"}`} style={{ top: focusMode ? 0 : undefined }}>
          {/* Panel header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: `1.5px solid ${T.bd}`, flexShrink: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: T.hd }}>
              {{ toc: "Contents", bookmarks: "Bookmarks & Highlights", stats: "Analytics", ai: "AI Analysis", chat: "Chat with Doc", settings: "Settings" }[panel]}
            </div>
            <button onClick={() => setPanel(null)} className="tb" style={{ width: 28, height: 28 }}>✕</button>
          </div>

          <div className="pscroll">

            {/* TOC */}
            {panel === "toc" && (
              <div style={{ paddingTop: 8 }}>
                {tocItems.length === 0
                  ? <div style={{ padding: "12px 16px", color: T.t3, fontSize: 13 }}>No headings detected in this document.</div>
                  : tocItems.map((b, i) => (
                    <button key={b.id} className="ti" style={{ paddingLeft: b.type === "h2" ? 28 : 16 }} onClick={() => { scrollTo(b.id); setPanel(null); }}>
                      <span style={{ color: T.ac, marginRight: 8, fontSize: 10, fontWeight: 700 }}>{i + 1}</span>
                      {(b.text || "").slice(0, 52)}{(b.text || "").length > 52 ? "…" : ""}
                    </button>
                  ))
                }
              </div>
            )}

            {/* BOOKMARKS */}
            {panel === "bookmarks" && (
              <div>
                {bookmarks.length === 0 && Object.keys(highlights).length === 0 ? (
                  <div style={{ padding: "14px 16px" }}>
                    <div style={{ background: T.s2, borderRadius: 12, padding: "14px", fontSize: 13, color: T.t2, lineHeight: 1.75 }}>
                      <div style={{ fontWeight: 700, color: T.hd, marginBottom: 8 }}>How to use</div>
                      <div style={{ marginBottom: 6 }}><strong>🔖 Bookmark:</strong> Hover a paragraph → click ◻ button that appears on the right side</div>
                      <div><strong>✏️ Highlight:</strong> Click ✏️ in toolbar → pick a color → tap any paragraph</div>
                    </div>
                  </div>
                ) : null}
                {bookmarks.length > 0 && (
                  <div>
                    <div className="sl">Bookmarks ({bookmarks.length})</div>
                    {bookmarks.map(bm => {
                      const b = blocks.find(b => b.id === bm.blockId);
                      return (
                        <button key={bm.id} className="ti" style={{ borderLeft: `3px solid ${T.ac}`, paddingLeft: 13 }}
                          onClick={() => { scrollTo(bm.blockId); setPanel(null); }}>
                          <div style={{ fontSize: 10, color: T.ac, fontWeight: 700, marginBottom: 3 }}>🔖 Bookmark</div>
                          <div style={{ fontSize: 12, color: T.t2, lineHeight: 1.5 }}>{(b?.text || (b?.items || [])[0] || "").slice(0, 72)}…</div>
                        </button>
                      );
                    })}
                  </div>
                )}
                {Object.keys(highlights).filter(k => highlights[k]).length > 0 && (
                  <div>
                    <div className="sl">Highlights ({Object.keys(highlights).filter(k => highlights[k]).length})</div>
                    {Object.entries(highlights).filter(([, c]) => c).map(([id, cid]) => {
                      const b = blocks.find(b => b.id === parseInt(id));
                      const c = HLC.find(c => c.id === cid);
                      return b ? (
                        <button key={id} className="ti" style={{ borderLeft: `3px solid ${c?.bg}` }}
                          onClick={() => { scrollTo(b.id); setPanel(null); }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                            <span style={{ width: 10, height: 10, borderRadius: 3, background: c?.bg, border: `1px solid ${c?.br}`, flexShrink: 0 }} />
                            <span style={{ fontSize: 10, color: T.t3, fontWeight: 700 }}>{c?.id.toUpperCase()}</span>
                          </div>
                          <div style={{ fontSize: 12, color: T.t2, lineHeight: 1.5 }}>{(b.text || "").slice(0, 68)}…</div>
                        </button>
                      ) : null;
                    })}
                  </div>
                )}
              </div>
            )}

            {/* STATS */}
            {panel === "stats" && stats && (
              <div style={{ padding: "14px 16px" }}>
                <div className="sg">
                  {[["Words", stats.wordCount.toLocaleString()], ["Chars", stats.charCount.toLocaleString()], ["Sentences", stats.sentenceCount.toLocaleString()], ["Paragraphs", stats.paragraphCount], ["Chapters", stats.chapterCount], ["Read Time", `${stats.readingTime}m`], ["Avg Sent", `${stats.avgSentLen}w`], ["Lex. Rich.", `${stats.lexDiv}%`]].map(([l, v]) => (
                    <div key={l} className="sc">
                      <div className="sk">{l}</div>
                      <div className="sv">{v}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontWeight: 600, fontSize: 11, color: T.t3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 10 }}>Top Words</div>
                {stats.topWords.map(([w, c]) => (
                  <div key={w} style={{ marginBottom: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                      <span style={{ color: T.tx }}>{w}</span>
                      <span style={{ fontWeight: 700, color: T.ac }}>{c}×</span>
                    </div>
                    <div style={{ height: 4, background: T.s3, borderRadius: 2 }}>
                      <div style={{ height: "100%", width: `${(c / stats.topWords[0][1]) * 100}%`, background: T.ac, borderRadius: 2, transition: "width .5s" }} />
                    </div>
                  </div>
                ))}
                <div style={{ marginTop: 16 }}>
                  <div style={{ fontWeight: 600, fontSize: 11, color: T.t3, textTransform: "uppercase", letterSpacing: 1, marginBottom: 8 }}>Reading Progress</div>
                  <div style={{ background: T.s2, borderRadius: 999, height: 10, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${progress}%`, background: T.ac, borderRadius: 999, transition: "width .3s" }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: T.t3, marginTop: 5 }}>
                    <span>{progress}% read</span>
                    <span>~{Math.max(0, stats.readingTime - Math.round(progress / 100 * stats.readingTime))}m remaining</span>
                  </div>
                </div>
              </div>
            )}

            {/* AI */}
            {panel === "ai" && renderAI()}

            {/* CHAT */}
            {panel === "chat" && (
              <div style={{ display: "flex", flexDirection: "column", height: "calc(100% - 0px)", minHeight: 300 }}>
                {!gemKey && (
                  <div style={{ padding: "10px 16px" }}>
                    <div style={{ background: T.ab, border: `1.5px solid ${T.ac}`, borderRadius: 10, padding: "10px 12px", fontSize: 12, color: T.at }}>
                      ⚠️ Enter Gemini API key in Settings panel.
                    </div>
                  </div>
                )}
                <div style={{ flex: 1, overflowY: "auto", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
                  {chat.length === 0 && (
                    <div>
                      <div style={{ color: T.t3, fontSize: 12, marginBottom: 10 }}>Ask anything about your document:</div>
                      {["What is the main idea?", "Summarize in 5 bullet points", "What's the tone of writing?", "List all key characters", "What are the most important arguments?"].map(q => (
                        <button key={q} onClick={() => sendChat(q)}
                          style={{ display: "block", width: "100%", textAlign: "left", background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 9, padding: "9px 12px", marginBottom: 6, cursor: "pointer", color: T.t2, fontSize: 12, fontFamily: F.css, lineHeight: 1.5 }}>
                          {q}
                        </button>
                      ))}
                    </div>
                  )}
                  {chat.map((m, i) => <div key={i} className={m.r === "u" ? "bu" : "ba"}>{m.t}</div>)}
                  {chatLoading && <div className="ba pulse" style={{ color: T.t2, fontSize: 13 }}>Thinking…</div>}
                  <div ref={chatEnd} />
                </div>
                <div style={{ padding: "10px 12px", borderTop: `1.5px solid ${T.bd}`, display: "flex", gap: 8, alignItems: "flex-end", flexShrink: 0 }}>
                  <textarea value={chatIn} onChange={e => setChatIn(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                    placeholder="Ask anything… (Enter to send)" rows={2}
                    style={{ flex: 1, background: T.s2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "9px 12px", color: T.tx, fontFamily: F.css, fontSize: 13, outline: "none", resize: "none", lineHeight: 1.5 }} />
                  <button onClick={() => sendChat()} disabled={!chatIn.trim() || chatLoading}
                    style={{ width: 38, height: 38, borderRadius: 10, background: T.ac, border: "none", cursor: "pointer", color: "#fff", fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center", opacity: chatLoading ? .5 : 1, flexShrink: 0 }}>→</button>
                </div>
              </div>
            )}

            {/* SETTINGS */}
            {panel === "settings" && (
              <div style={{ padding: "14px 16px" }}>
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.t2, marginBottom: 8 }}>Theme</div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    {Object.entries(THEMES).map(([k, t]) => (
                      <button key={k} onClick={() => setThemeKey(k)} title={t.name}
                        style={{ width: 44, height: 44, borderRadius: 12, background: t.s1, border: `2.5px solid ${themeKey === k ? t.ac : t.bd}`, cursor: "pointer", fontSize: 22, display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {t.e}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ marginBottom: 18 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.t2, marginBottom: 8 }}>Font Family</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {FONTS.map((f, i) => (
                      <button key={f.n} onClick={() => setFontIdx(i)}
                        style={{ background: fontIdx === i ? T.ab : T.s2, color: fontIdx === i ? T.ac : T.t2, border: `1.5px solid ${fontIdx === i ? T.ac : T.bd}`, borderRadius: 9, padding: "8px 12px", cursor: "pointer", fontFamily: f.css, fontSize: 14, textAlign: "left", fontWeight: fontIdx === i ? 700 : 400 }}>
                        {f.n}
                      </button>
                    ))}
                  </div>
                </div>
                {[{ l: "Font Size", v: fontSize, s: setFontSize, min: 13, max: 28, step: 1, d: `${fontSize}px` }, { l: "Line Height", v: lh, s: setLh, min: 1.3, max: 2.4, step: .05, d: lh.toFixed(2) }, { l: "Column Width", v: colW, s: setColW, min: 340, max: 960, step: 20, d: `${colW}px` }].map(({ l, v, s, min, max, step, d }) => (
                  <div key={l} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, fontWeight: 600, color: T.t2, marginBottom: 8 }}>
                      <span>{l}</span><span style={{ color: T.ac, fontWeight: 700 }}>{d}</span>
                    </div>
                    <input type="range" min={min} max={max} step={step} value={v} onChange={e => s(Number(e.target.value))} />
                  </div>
                ))}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: T.t2 }}>Typewriter Mode</div>
                    <div style={{ fontSize: 11, color: T.t3 }}>Focus on current line</div>
                  </div>
                  <button className={`tog ${typewriter ? "on" : "off"}`} onClick={() => setTypewriter(t => !t)} />
                </div>
                <div style={{ marginTop: 18 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.t2, marginBottom: 7 }}>Gemini API Key</div>
                  <input type="password" value={gemKey} onChange={e => setGemKey(e.target.value)} placeholder="AIza…" className="inp" style={{ fontSize: 12 }} />
                  <div style={{ fontSize: 11, color: T.t3, marginTop: 5 }}>Get free key: aistudio.google.com</div>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── READER ── */}
        <div className="reader" ref={readerRef}>
          <div className="rc fu">
            {searchIds !== null && searchIds.size === 0 && (
              <div style={{ textAlign: "center", padding: "60px 0", color: T.t3 }}>
                <div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div>
                <div style={{ fontSize: 16, fontWeight: 600 }}>No results for "{query}"</div>
              </div>
            )}

            {blocks.map(renderBlock)}

            {/* End */}
            <div style={{ margin: "80px 0 40px", padding: "32px 0", borderTop: `1.5px solid ${T.bd}`, textAlign: "center" }}>
              <div style={{ fontSize: 20, letterSpacing: 14, color: T.bd, marginBottom: 14 }}>· · ·</div>
              <div style={{ fontWeight: 700, fontSize: "clamp(15px,4vw,18px)", color: T.hd, marginBottom: 5 }}>End of Document</div>
              <div style={{ color: T.t3, fontSize: 13, marginBottom: 22 }}>{stats?.wordCount?.toLocaleString()} words · {blocks.length} sections · {stats?.readingTime}m read</div>
              <div style={{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
                <button onClick={() => readerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
                  style={{ background: T.ac, color: "#fff", border: "none", borderRadius: 10, padding: "9px 20px", cursor: "pointer", fontSize: 14, fontFamily: F.css, fontWeight: 600 }}>↑ Top</button>
                <button onClick={exportHTML}
                  style={{ background: T.s1, color: T.t2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "9px 20px", cursor: "pointer", fontSize: 14, fontFamily: F.css }}>Export HTML</button>
                {aiData && <button onClick={dlSummary}
                  style={{ background: T.s1, color: T.t2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "9px 20px", cursor: "pointer", fontSize: 14, fontFamily: F.css }}>⬇ AI Report</button>}
                <button onClick={() => { setRaw(""); setBlocks([]); }}
                  style={{ background: T.s1, color: T.t2, border: `1.5px solid ${T.bd}`, borderRadius: 10, padding: "9px 20px", cursor: "pointer", fontSize: 14, fontFamily: F.css }}>New File</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}