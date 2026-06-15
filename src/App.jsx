import { useState, useEffect, useRef, useCallback } from "react";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection, doc, getDocs, setDoc, deleteDoc, onSnapshot, writeBatch,
} from "firebase/firestore";
import { auth, db, provider } from "./firebase";

// ─── Constants ───────────────────────────────────────────────────────────────
const PRI = [
  { id:"urgent", label:"🔴 Urgent", bar:"border-l-red-500",    badge:"bg-red-100 text-red-700",      dot:"bg-red-500"     },
  { id:"high",   label:"🟠 High",   bar:"border-l-orange-400", badge:"bg-orange-100 text-orange-700", dot:"bg-orange-400"  },
  { id:"medium", label:"🟡 Medium", bar:"border-l-amber-400",  badge:"bg-amber-100 text-amber-700",   dot:"bg-amber-400"   },
  { id:"low",    label:"🟢 Low",    bar:"border-l-emerald-400",badge:"bg-emerald-100 text-emerald-700",dot:"bg-emerald-400"},
];
const TCATS = ["Work","Personal","Ideas","Research","Meeting","Learning","Other"];
const NCATS = ["Work","Personal","Ideas","Reference","Meeting","Research","Journal","Other"];
const BLANK_T = {title:"",notes:"",category:"Work",priority:"medium",status:"todo",progress:0,dueDate:""};
const BLANK_N = {title:"",content:"",category:"Work",pinned:false};

const pc   = id => PRI.find(p=>p.id===id)||PRI[2];
const fmt  = iso => iso ? new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
const uid  = () => Date.now().toString(36)+Math.random().toString(36).slice(2);
const today= () => new Date().toISOString().split("T")[0];

// ─── Gemini API helper ────────────────────────────────────────────────────────
const GEMINI_KEY = import.meta.env.VITE_GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

async function askGemini(prompt, maxTokens = 600) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user,    setUser]   = useState(undefined); // undefined = loading
  const [tasks,   setTasks]  = useState([]);
  const [notes,   setNotes]  = useState([]);
  const [cfg,     setCfg]    = useState({time:"08:00"});
  const [lastEmail,setLE]    = useState("");
  const [tab,     setTab]    = useState("tasks");
  const [toast,   setToast]  = useState(null);
  const [brief,   setBrief]  = useState("");
  const [bLoad,   setBLoad]  = useState(false);
  const [copied,  setCopied] = useState(false);

  // Task UI
  const [fPri,  setFPri]  = useState("all");
  const [fCat,  setFCat]  = useState("all");
  const [fStat, setFStat] = useState("active");
  const [tSearch,setTS]   = useState("");
  const [showTF, setSTF]  = useState(false);
  const [editTid,setETid] = useState(null);
  const [tForm,  setTForm]= useState(BLANK_T);
  const [expId,  setExpId]= useState(null);
  const [delTid, setDTid] = useState(null);

  // Note UI
  const [nSearch,setNS]   = useState("");
  const [nCat,   setNC]   = useState("all");
  const [showNF, setSNF]  = useState(false);
  const [editNid,setENid] = useState(null);
  const [nForm,  setNForm]= useState(BLANK_N);
  const [viewNid,setVNid] = useState(null);
  const [delNid, setDNid] = useState(null);

  // Settings UI
  const [showCfg, setShowCfg] = useState(false);
  const [cfgForm, setCfgForm] = useState({time:"08:00"});

  // AI Key UI
  const [showKey,  setShowKey]  = useState(false);
  const [keyInput, setKeyInput] = useState("");

  // Import
  const [impTxt, setIT]  = useState("");
  const [impLoad,setIL]  = useState(false);
  const [impRes, setIR]  = useState(null);

  // Refs for auto-email
  const cRef  = useRef(cfg);
  const leRef = useRef(lastEmail);
  useEffect(()=>{cRef.current=cfg},[cfg]);
  useEffect(()=>{leRef.current=lastEmail},[lastEmail]);

  // ── Auth listener ────────────────────────────────────────────────────────
  useEffect(()=>{
    const unsub = onAuthStateChanged(auth, u => setUser(u ?? null));
    return unsub;
  },[]);

  // ── Firestore paths ──────────────────────────────────────────────────────
  const tasksCol = user ? collection(db, "users", user.uid, "tasks") : null;
  const notesCol = user ? collection(db, "users", user.uid, "notes") : null;
  const cfgDoc   = user ? doc(db, "users", user.uid, "settings", "config") : null;

  // ── Load from Firestore when user signs in ───────────────────────────────
  useEffect(()=>{
    if(!user) return;
    // Subscribe to tasks
    const unsubT = onSnapshot(collection(db,"users",user.uid,"tasks"), snap=>{
      setTasks(snap.docs.map(d=>({id:d.id,...d.data()})));
    });
    // Subscribe to notes
    const unsubN = onSnapshot(collection(db,"users",user.uid,"notes"), snap=>{
      setNotes(snap.docs.map(d=>({id:d.id,...d.data()})));
    });
    // Load config once
    getDocs(collection(db,"users",user.uid,"settings")).then(snap=>{
      const cfg = snap.docs.find(d=>d.id==="config")?.data();
      if(cfg){ setCfg(cfg); setCfgForm(cfg); }
    });
    return ()=>{ unsubT(); unsubN(); };
  },[user]);

  const showT = (msg,type="ok")=>{setToast({msg,type});setTimeout(()=>setToast(null),3000)};

  // ── Firestore write helpers ───────────────────────────────────────────────
  const saveTask = async task => {
    if(!user) return;
    const {id,...data} = task;
    await setDoc(doc(db,"users",user.uid,"tasks",id), data);
  };
  const removeTask = async id => {
    if(!user) return;
    await deleteDoc(doc(db,"users",user.uid,"tasks",id));
  };
  const saveNote = async note => {
    if(!user) return;
    const {id,...data} = note;
    await setDoc(doc(db,"users",user.uid,"notes",id), data);
  };
  const removeNote = async id => {
    if(!user) return;
    await deleteDoc(doc(db,"users",user.uid,"notes",id));
  };
  const saveConfig = async c => {
    if(!user) return;
    await setDoc(doc(db,"users",user.uid,"settings","config"), c);
  };

  // ── Tasks CRUD ───────────────────────────────────────────────────────────
  const addT = async () => {
    const t = {...tForm, id:uid(), dateAdded:new Date().toISOString(), completedAt:null};
    await saveTask(t);
    closeTF();
  };
  const saveT = async () => {
    const updated = tasks.map(t=>t.id===editTid?{...t,...tForm}:t).find(t=>t.id===editTid);
    if(updated) await saveTask(updated);
    closeTF();
  };
  const delT = async id => {
    await removeTask(id);
    if(expId===id) setExpId(null);
    setDTid(null);
  };
  const closeTF = ()=>{ setSTF(false); setETid(null); setTForm(BLANK_T); };
  const openTF  = t=>{ setTForm({title:t.title,notes:t.notes||"",category:t.category,priority:t.priority,status:t.status,progress:t.progress,dueDate:t.dueDate||""}); setETid(t.id); setSTF(true); };

  const cycleS = async id => {
    const task = tasks.find(t=>t.id===id); if(!task) return;
    const n = task.status==="todo"?"inprogress":task.status==="inprogress"?"done":"todo";
    const updated = {...task, status:n, progress:n==="done"?100:task.progress, completedAt:n==="done"?new Date().toISOString():null};
    await saveTask(updated);
  };
  const setProg = async (id, v) => {
    const task = tasks.find(t=>t.id===id); if(!task) return;
    const s = v===100?"done":v>0?"inprogress":"todo";
    await saveTask({...task, progress:v, status:s, completedAt:s==="done"?new Date().toISOString():null});
  };

  // ── Notes CRUD ───────────────────────────────────────────────────────────
  const addN = async () => {
    const n = {...nForm, id:uid(), dateCreated:new Date().toISOString(), dateModified:new Date().toISOString()};
    await saveNote(n); closeNF();
  };
  const saveN = async () => {
    const updated = notes.find(n=>n.id===editNid); if(!updated) return;
    await saveNote({...updated,...nForm, dateModified:new Date().toISOString()});
    closeNF(); if(viewNid===editNid) setVNid(null);
  };
  const delN = async id => { await removeNote(id); setDNid(null); if(viewNid===id) setVNid(null); };
  const closeNF = ()=>{ setSNF(false); setENid(null); setNForm(BLANK_N); };
  const openNF  = n=>{ setNForm({title:n.title,content:n.content,category:n.category,pinned:n.pinned}); setENid(n.id); setSNF(true); };
  const pinN = async id => {
    const n = notes.find(n=>n.id===id); if(!n) return;
    await saveNote({...n, pinned:!n.pinned});
  };

  // ── Report builder ───────────────────────────────────────────────────────
  const buildReport = useCallback(()=>{
    const active = tasks.filter(x=>x.status!=="done");
    const lines = [`📋 Daily Report — ${new Date().toDateString()}`,
      `Active: ${active.length} | Done: ${tasks.filter(x=>x.status==="done").length}`,``];
    const by = {urgent:[],high:[],medium:[],low:[]};
    active.forEach(x=>by[x.priority]?.push(x));
    Object.entries(by).forEach(([p,list])=>{
      if(!list.length) return;
      lines.push(`— ${p.toUpperCase()} —`);
      list.forEach(x=>{ lines.push(`  ${x.status==="inprogress"?"[~]":"[ ]"} ${x.title} (${x.category}) ${x.progress}%`); if(x.dueDate) lines.push(`     Due: ${fmt(x.dueDate+"T00:00:00")}`); if(x.notes) lines.push(`     Note: ${x.notes}`); });
      lines.push(``);
    });
    const pinned = notes.filter(x=>x.pinned);
    if(pinned.length){ lines.push(`— 📌 PINNED NOTES —`); pinned.forEach(x=>{ lines.push(`  ${x.title}`); lines.push(`  ${x.content?.slice(0,150)||""}`); lines.push(``); }); }
    if(brief){ lines.push(`— AI BRIEF —`); lines.push(brief); }
    return lines.join("\n");
  },[tasks,notes,brief]);

  // ── AI Daily Brief (Gemini) ───────────────────────────────────────────────
  const genBrief = async () => {
    setBLoad(true); setBrief("");
    const active = tasks.filter(t=>t.status!=="done");
    const prompt = `Today: ${new Date().toDateString()}. Write a focused daily brief.\n\n${active.map(t=>`• [${t.priority.toUpperCase()}] ${t.title} (${t.category}) ${t.progress}%${t.dueDate?` due ${t.dueDate}`:""}${t.notes?` — ${t.notes}`:""}`).join("\n")}\n\nSections: 🔥 Top 3 Focus | ⚡ Quick Wins | 📅 Urgent/Overdue | 💬 Motivation. Under 200 words.`;
    try {
      const text = await askGemini(prompt, 600);
      setBrief(text);
    } catch(e) {
      setBrief("⚠ Error calling Gemini. Check your API key in Settings.");
    }
    setBLoad(false);
  };

  // ── AI Smart Import (Gemini) ──────────────────────────────────────────────
  const doImport = async () => {
    if(!impTxt.trim()) return; setIL(true); setIR(null);
    const prompt = `Parse these notes into tasks. Return ONLY a valid JSON array, no markdown fences, no explanation:\n[{"title":"","notes":"","category":"Work","priority":"medium","dueDate":""}]\nPriority values: urgent/high/medium/low. Category values: ${TCATS.join("/")}\n\nNotes:\n${impTxt}`;
    try {
      const raw  = await askGemini(prompt, 2000);
      const clean = raw.replace(/```json|```/g,"").trim();
      const p    = JSON.parse(clean);
      setIR(Array.isArray(p)?p:"error");
    } catch { setIR("error"); }
    setIL(false);
  };

  const confirmImport = async () => {
    if(!Array.isArray(impRes)) return;
    await Promise.all(impRes.map(t=>saveTask({...t, id:uid(), status:"todo", progress:0, dateAdded:new Date().toISOString(), completedAt:null})));
    setIT(""); setIR(null); setTab("tasks"); showT(`✅ Added ${impRes.length} tasks!`);
  };

  // ── Auto-email reminder (mailto fallback) ────────────────────────────────
  const emailReport = () => {
    const report = buildReport();
    const subject = encodeURIComponent(`📋 Daily Report — ${new Date().toDateString()}`);
    const body    = encodeURIComponent(report);
    window.open(`mailto:${user?.email||""}?subject=${subject}&body=${body}`);
  };

  // ── Filtered lists ───────────────────────────────────────────────────────
  const visTasks = [...tasks]
    .sort((a,b)=>{
      const o={urgent:0,high:1,medium:2,low:3};
      if(a.status==="done"&&b.status!=="done") return 1;
      if(b.status==="done"&&a.status!=="done") return -1;
      return o[a.priority]-o[b.priority];
    })
    .filter(t=>{
      if(fStat==="active"&&t.status==="done") return false;
      if(fStat==="done"&&t.status!=="done")   return false;
      if(fPri!=="all"&&t.priority!==fPri)     return false;
      if(fCat!=="all"&&t.category!==fCat)     return false;
      if(tSearch){const q=tSearch.toLowerCase();if(!t.title.toLowerCase().includes(q)&&!(t.notes||"").toLowerCase().includes(q)) return false;}
      return true;
    });

  const visNotes = [...notes]
    .sort((a,b)=>{
      if(a.pinned&&!b.pinned) return -1;
      if(!a.pinned&&b.pinned) return 1;
      return new Date(b.dateModified)-new Date(a.dateModified);
    })
    .filter(n=>{
      if(nCat!=="all"&&n.category!==nCat) return false;
      if(nSearch){const q=nSearch.toLowerCase();if(!n.title.toLowerCase().includes(q)&&!n.content.toLowerCase().includes(q)) return false;}
      return true;
    });

  const stats = {
    urgent: tasks.filter(t=>t.priority==="urgent"&&t.status!=="done").length,
    active: tasks.filter(t=>t.status!=="done").length,
    done:   tasks.filter(t=>t.status==="done").length,
    overdue:tasks.filter(t=>t.dueDate&&t.dueDate<today()&&t.status!=="done").length,
  };
  const viewNote = notes.find(n=>n.id===viewNid);

  const copyR = () => {
    navigator.clipboard.writeText(buildReport()).then(()=>{setCopied(true);setTimeout(()=>setCopied(false),2000)});
  };

  // ─── Loading state ────────────────────────────────────────────────────────
  if(user === undefined) return(
    <div className="min-h-screen bg-stone-50 flex items-center justify-center">
      <p className="text-slate-400 animate-pulse text-sm">Loading…</p>
    </div>
  );

  // ─── Sign-in screen ───────────────────────────────────────────────────────
  if(user === null) return(
    <div className="min-h-screen bg-gradient-to-br from-violet-50 to-stone-50 flex items-center justify-center p-6">
      <div className="bg-white rounded-3xl shadow-xl p-10 max-w-sm w-full text-center">
        <div className="text-5xl mb-4">📋</div>
        <h1 className="text-2xl font-bold text-slate-800 mb-2">My Scheduler</h1>
        <p className="text-slate-400 text-sm mb-8">Tasks · Notes · AI Summaries</p>
        <button
          onClick={()=>signInWithPopup(auth,provider).catch(()=>{})}
          className="w-full flex items-center justify-center gap-3 bg-white border-2 border-slate-200 hover:border-violet-400 hover:bg-violet-50 text-slate-700 font-semibold rounded-2xl px-6 py-3.5 transition-all shadow-sm"
        >
          <svg className="w-5 h-5" viewBox="0 0 24 24">
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
          </svg>
          Continue with Google
        </button>
        <p className="text-xs text-slate-400 mt-6">Your data syncs across all your devices</p>
      </div>
    </div>
  );

  // ─── Main App ─────────────────────────────────────────────────────────────
  return(
  <div className="min-h-screen bg-stone-50 font-sans">

    {/* Toast */}
    {toast&&<div className={`fixed top-4 right-4 z-[100] px-4 py-3 rounded-xl shadow-lg text-sm font-semibold text-white ${toast.type==="err"?"bg-red-600":"bg-emerald-600"}`}>{toast.msg}</div>}

    {/* Header */}
    <header className="bg-white border-b border-slate-200 sticky top-0 z-40 shadow-sm px-4 py-3">
      <div className="max-w-3xl mx-auto flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <img src={user.photoURL} alt="" className="w-8 h-8 rounded-full hidden sm:block" referrerPolicy="no-referrer"/>
          <div>
            <h1 className="text-lg font-bold text-slate-900">📋 My Scheduler</h1>
            <p className="text-xs text-slate-400">{new Date().toDateString()}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {stats.urgent>0&&<span className="hidden sm:flex items-center gap-1 text-xs font-semibold bg-red-50 text-red-600 border border-red-200 px-2 py-1 rounded-full"><span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-pulse"/>{stats.urgent} urgent</span>}
          {stats.overdue>0&&<span className="hidden sm:block text-xs font-semibold bg-orange-50 text-orange-600 border border-orange-200 px-2 py-1 rounded-full">⚠ {stats.overdue}</span>}
          <span className="text-xs bg-slate-100 text-slate-600 px-2 py-1 rounded-full font-medium">{stats.done}/{tasks.length}</span>
          <button onClick={()=>setShowCfg(true)} className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-xl">⚙️</button>
          {tab==="tasks"&&<button onClick={()=>{setETid(null);setTForm(BLANK_T);setSTF(true)}} className="bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold px-3 py-2 rounded-xl">+ Task</button>}
          {tab==="notes"&&<button onClick={()=>{setENid(null);setNForm(BLANK_N);setSNF(true)}} className="bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold px-3 py-2 rounded-xl">+ Note</button>}
        </div>
      </div>
    </header>

    {/* Tabs */}
    <div className="bg-white border-b border-slate-200 px-4">
      <div className="max-w-3xl mx-auto flex overflow-x-auto">
        {[{id:"tasks",l:"📝 Tasks"},{id:"notes",l:"📓 Notes"},{id:"daily",l:"☀️ Daily"},{id:"import",l:"✨ Import"}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab===t.id?"border-violet-600 text-violet-700":"border-transparent text-slate-500 hover:text-slate-700"}`}>{t.l}</button>
        ))}
      </div>
    </div>

    <main className="max-w-3xl mx-auto px-4 py-5">

      {/* ── TASKS ── */}
      {tab==="tasks"&&<>
        <div className="flex flex-wrap gap-2 mb-4">
          <input value={tSearch} onChange={e=>setTS(e.target.value)} placeholder="Search…" className="flex-1 min-w-32 px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"/>
          <select value={fStat} onChange={e=>setFStat(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="active">Active</option><option value="done">Done</option><option value="all">All</option></select>
          <select value={fPri}  onChange={e=>setFPri(e.target.value)}  className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="all">All Priorities</option>{PRI.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <select value={fCat}  onChange={e=>setFCat(e.target.value)}  className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="all">All Categories</option>{TCATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
        </div>
        {visTasks.length===0?(
          <div className="text-center py-20"><p className="text-5xl mb-3">{tasks.length===0?"🗒️":"🔍"}</p><p className="text-slate-400 text-sm">{tasks.length===0?"No tasks yet — tap + Task":"No tasks match filters"}</p></div>
        ):(
          <div className="space-y-2">
            {visTasks.map(task=>{
              const p=pc(task.priority),done=task.status==="done",inProg=task.status==="inprogress",exp=expId===task.id,ov=task.dueDate&&task.dueDate<today()&&!done;
              return<div key={task.id} className={`bg-white rounded-2xl border-l-4 border border-slate-200 shadow-sm ${p.bar} ${done?"opacity-60":""}`}>
                <div className="p-4">
                  <div className="flex items-start gap-3">
                    <button onClick={()=>cycleS(task.id)} className={`mt-0.5 w-5 h-5 rounded-full border-2 flex-shrink-0 flex items-center justify-center text-xs font-bold transition-all ${done?"bg-emerald-500 border-emerald-500 text-white":inProg?"bg-violet-100 border-violet-400 text-violet-600":"border-slate-300 hover:border-violet-400"}`}>{done?"✓":inProg?"◑":""}</button>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start gap-2 justify-between">
                        <div className="flex flex-wrap items-center gap-1.5 flex-1">
                          <span className={`font-semibold text-sm ${done?"line-through text-slate-400":"text-slate-800"}`}>{task.title}</span>
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.badge}`}>{p.label}</span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{task.category}</span>
                        </div>
                        <div className="flex gap-0.5 flex-shrink-0">
                          <button onClick={()=>openTF(task)} className="p-1.5 text-slate-300 hover:text-violet-600 hover:bg-violet-50 rounded-lg text-xs">✏️</button>
                          <button onClick={()=>setDTid(task.id)} className="p-1.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-lg text-xs">🗑️</button>
                          <button onClick={()=>setExpId(exp?null:task.id)} className={`p-1.5 text-slate-300 hover:text-slate-600 rounded-lg text-xs ${exp?"bg-slate-100":""}`}>{exp?"▲":"▼"}</button>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2 mt-1 text-xs text-slate-400">
                        <span>Added {fmt(task.dateAdded)}</span>
                        {task.dueDate&&<span className={ov?"text-red-500 font-medium":""}>{ov?"⚠ Overdue · ":"Due "}{fmt(task.dueDate+"T00:00:00")}</span>}
                        {done&&task.completedAt&&<span className="text-emerald-500">✓ Done {fmt(task.completedAt)}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex-1 bg-slate-100 rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all ${done?"bg-emerald-400":task.progress>60?"bg-violet-500":task.progress>30?"bg-amber-400":"bg-slate-300"}`} style={{width:`${task.progress}%`}}/></div>
                        <span className="text-xs text-slate-400 w-7 text-right">{task.progress}%</span>
                      </div>
                    </div>
                  </div>
                </div>
                {exp&&<div className="border-t border-slate-100 bg-slate-50 rounded-b-2xl px-4 py-4">
                  {task.notes?<><p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Notes</p><p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap mb-4">{task.notes}</p></>:<p className="text-xs text-slate-400 italic mb-4">No notes.</p>}
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Progress · {task.progress}%</p>
                  <input type="range" min="0" max="100" step="5" value={task.progress} onChange={e=>setProg(task.id,+e.target.value)} className="w-full accent-violet-600"/>
                </div>}
              </div>;
            })}
          </div>
        )}
      </>}

      {/* ── NOTES ── */}
      {tab==="notes"&&<>
        <div className="flex flex-wrap gap-2 mb-4">
          <input value={nSearch} onChange={e=>setNS(e.target.value)} placeholder="Search notes…" className="flex-1 min-w-32 px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"/>
          <select value={nCat} onChange={e=>setNC(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="all">All</option>{NCATS.map(c=><option key={c} value={c}>{c}</option>)}</select>
        </div>
        {visNotes.length===0?(
          <div className="text-center py-20"><p className="text-5xl mb-3">📓</p><p className="text-slate-400 text-sm">{notes.length===0?"No notes yet — tap + Note":"No notes match search"}</p></div>
        ):(
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {visNotes.map(note=>(
              <div key={note.id} onClick={()=>setVNid(note.id)} className="bg-white border border-slate-200 rounded-2xl p-4 cursor-pointer hover:shadow-md transition-all group relative">
                {note.pinned&&<span className="absolute top-3 right-9 text-amber-500 text-sm">📌</span>}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-semibold text-slate-800 text-sm flex-1 pr-5 leading-snug">{note.title||"Untitled"}</h3>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 flex-shrink-0">
                    <button onClick={e=>{e.stopPropagation();openNF(note)}} className="p-1 text-slate-400 hover:text-violet-600 text-xs">✏️</button>
                    <button onClick={e=>{e.stopPropagation();setDNid(note.id)}} className="p-1 text-slate-400 hover:text-red-500 text-xs">🗑️</button>
                  </div>
                </div>
                {note.content&&<p className="text-xs text-slate-500 leading-relaxed mb-3 line-clamp-3">{note.content.slice(0,140)}{note.content.length>140?"…":""}</p>}
                <div className="flex items-center justify-between">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{note.category}</span>
                  <span className="text-xs text-slate-400">{fmt(note.dateModified)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </>}

      {/* ── DAILY ── */}
      {tab==="daily"&&<>
        <div className="flex items-center justify-between gap-3 mb-5 flex-wrap">
          <div><h2 className="text-lg font-bold text-slate-800">☀️ Daily Brief</h2><p className="text-xs text-slate-400">{new Date().toDateString()}</p></div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={copyR} className={`text-sm px-3 py-2 rounded-xl border font-medium transition-colors ${copied?"bg-emerald-50 border-emerald-300 text-emerald-700":"border-slate-200 text-slate-600 hover:bg-slate-50"}`}>{copied?"✓ Copied":"📋 Copy"}</button>
            <button onClick={emailReport} className="text-sm px-3 py-2 rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 font-medium">📧 Email Me</button>
            <button onClick={genBrief} disabled={bLoad||stats.active===0} className="text-sm px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-700 text-white font-medium disabled:opacity-50">{bLoad?"Generating…":"✨ AI Brief"}</button>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          {PRI.map(p=>{const c=tasks.filter(t=>t.priority===p.id&&t.status!=="done").length;return<div key={p.id} className="bg-white border border-slate-200 rounded-2xl p-3 text-center"><div className="flex items-center justify-center gap-1.5 mb-1"><span className={`w-2 h-2 rounded-full ${p.dot}`}/><span className="text-xs font-semibold text-slate-500">{p.id}</span></div><p className="text-2xl font-bold text-slate-800">{c}</p></div>})}
        </div>

        {(()=>{const dueT=tasks.filter(t=>t.dueDate===today()&&t.status!=="done"),ov=tasks.filter(t=>t.dueDate&&t.dueDate<today()&&t.status!=="done");if(!dueT.length&&!ov.length)return null;return<div className="grid gap-3 mb-4 sm:grid-cols-2">
          {ov.length>0&&<div className="bg-red-50 border border-red-200 rounded-2xl p-4"><p className="text-sm font-semibold text-red-700 mb-2">⚠ Overdue ({ov.length})</p><ul className="space-y-1">{ov.map(t=><li key={t.id} className="flex items-center gap-2 text-xs text-red-800"><span className={`w-1.5 h-1.5 rounded-full ${pc(t.priority).dot}`}/>{t.title}<span className="ml-auto">{fmt(t.dueDate+"T00:00:00")}</span></li>)}</ul></div>}
          {dueT.length>0&&<div className="bg-amber-50 border border-amber-200 rounded-2xl p-4"><p className="text-sm font-semibold text-amber-700 mb-2">📅 Due Today ({dueT.length})</p><ul className="space-y-1">{dueT.map(t=><li key={t.id} className="flex items-center gap-2 text-xs text-amber-800"><span className={`w-1.5 h-1.5 rounded-full ${pc(t.priority).dot}`}/>{t.title}</li>)}</ul></div>}
        </div>})()}

        <div className="bg-white border border-slate-200 rounded-2xl p-4 mb-4">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Active Tasks</p>
          {stats.active===0?<p className="text-slate-400 text-sm text-center py-4">🎉 All done!</p>:
            <div className="space-y-2">{[...tasks].sort((a,b)=>({urgent:0,high:1,medium:2,low:3})[a.priority]-({urgent:0,high:1,medium:2,low:3})[b.priority]).filter(t=>t.status!=="done").map(t=><div key={t.id} className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full flex-shrink-0 ${pc(t.priority).dot}`}/><span className="text-sm text-slate-700 flex-1 truncate">{t.title}</span><span className="text-xs text-slate-400">{t.category}</span><div className="w-12 bg-slate-100 rounded-full h-1.5"><div className="h-1.5 rounded-full bg-violet-400" style={{width:`${t.progress}%`}}/></div><span className="text-xs text-slate-400 w-6 text-right">{t.progress}%</span></div>)}</div>}
        </div>

        {bLoad&&<div className="bg-white border border-slate-200 rounded-2xl p-8 text-center mb-4"><p className="text-3xl animate-pulse mb-2">✨</p><p className="text-slate-500 text-sm">Gemini is thinking…</p></div>}
        {brief&&!bLoad&&<div className="bg-white border border-slate-200 rounded-2xl p-5 mb-4">
          <div className="flex items-center gap-2 mb-3">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">AI Brief</p>
            <span className="text-xs bg-blue-50 text-blue-600 border border-blue-100 px-1.5 py-0.5 rounded-full">Gemini</span>
          </div>
          <p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{brief}</p>
        </div>}
      </>}

      {/* ── IMPORT ── */}
      {tab==="import"&&<>
        <div className="mb-4"><h2 className="text-lg font-bold text-slate-800 mb-1">✨ Smart Import</h2><p className="text-slate-400 text-sm">Paste raw notes or brain-dumps. Gemini will extract and categorize tasks.</p></div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5 mb-4">
          <textarea value={impTxt} onChange={e=>setIT(e.target.value)} rows={7} placeholder={"Paste your notes here…\n\n– Fix the login bug ASAP\n– Call Sarah about project\n– Research new framework\n– Team sync next week"} className="w-full text-sm text-slate-700 resize-none focus:outline-none placeholder-slate-300 leading-relaxed"/>
          <div className="flex justify-end mt-3 pt-3 border-t border-slate-100">
            <button onClick={doImport} disabled={impLoad||!impTxt.trim()} className="bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold px-5 py-2 rounded-xl disabled:opacity-50">{impLoad?"🤖 Parsing…":"✨ Parse with AI"}</button>
          </div>
        </div>
        {impLoad&&<div className="bg-white border border-slate-200 rounded-2xl p-8 text-center"><p className="text-3xl animate-pulse mb-2">🤖</p><p className="text-slate-500 text-sm">Gemini is reading your notes…</p></div>}
        {impRes==="error"&&<div className="bg-red-50 border border-red-200 rounded-2xl p-4 text-sm text-red-700">⚠ Couldn't parse. Try rephrasing or add tasks manually.</div>}
        {Array.isArray(impRes)&&!impLoad&&<div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <p className="text-sm font-semibold text-slate-700">Found {impRes.length} tasks</p>
            <div className="flex gap-2"><button onClick={()=>setIR(null)} className="text-sm px-3 py-1.5 border border-slate-200 rounded-xl text-slate-600 hover:bg-slate-50">Discard</button><button onClick={confirmImport} className="text-sm px-4 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-medium">✓ Add All</button></div>
          </div>
          <div className="space-y-2">
            {impRes.map((t,i)=>{const p=pc(t.priority);return<div key={i} className={`border-l-4 ${p.bar} bg-slate-50 rounded-xl p-3`}><div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium text-slate-800">{t.title}</span><span className={`text-xs px-2 py-0.5 rounded-full font-medium ${p.badge}`}>{p.label}</span><span className="text-xs px-2 py-0.5 rounded-full bg-slate-200 text-slate-600">{t.category}</span></div>{t.notes&&<p className="text-xs text-slate-500 mt-1">{t.notes}</p>}</div>})}
          </div>
        </div>}
      </>}
    </main>

    {/* Settings Modal */}
    {showCfg&&<div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
        <div className="p-5 border-b border-slate-100 flex justify-between"><h2 className="text-base font-bold">⚙️ Settings</h2><button onClick={()=>setShowCfg(false)} className="text-slate-400 text-xl">×</button></div>
        <div className="p-5 space-y-5">
          <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl">
            <img src={user.photoURL} alt="" className="w-10 h-10 rounded-full" referrerPolicy="no-referrer"/>
            <div><p className="text-sm font-semibold text-slate-800">{user.displayName}</p><p className="text-xs text-slate-400">{user.email}</p></div>
          </div>
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Gemini API Key</label>
            <div className="flex gap-2">
              <input type={showKey?"text":"password"} value={keyInput||import.meta.env.VITE_GEMINI_API_KEY||""} onChange={e=>setKeyInput(e.target.value)} placeholder="AIza…" className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              <button onClick={()=>setShowKey(s=>!s)} className="px-3 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-500 hover:bg-slate-50">{showKey?"Hide":"Show"}</button>
            </div>
            <p className="text-xs text-slate-400 mt-1">Get yours free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-violet-600 underline">aistudio.google.com</a></p>
          </div>
        </div>
        <div className="p-5 border-t border-slate-100 flex justify-between items-center">
          <button onClick={()=>signOut(auth)} className="text-sm text-red-500 hover:text-red-700 font-medium">Sign out</button>
          <div className="flex gap-2">
            <button onClick={()=>setShowCfg(false)} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">Close</button>
          </div>
        </div>
      </div>
    </div>}

    {/* Task Form */}
    {showTF&&<div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-slate-100 flex justify-between"><h2 className="text-base font-bold">{editTid?"Edit Task":"New Task"}</h2><button onClick={closeTF} className="text-slate-400 text-xl">×</button></div>
        <div className="p-5 space-y-4">
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Title *</label><input type="text" value={tForm.title} onChange={e=>setTForm({...tForm,title:e.target.value})} placeholder="What needs to be done?" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Priority</label><select value={tForm.priority} onChange={e=>setTForm({...tForm,priority:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200">{PRI.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select></div>
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Category</label><select value={tForm.category} onChange={e=>setTForm({...tForm,category:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200">{TCATS.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Status</label><select value={tForm.status} onChange={e=>setTForm({...tForm,status:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="todo">To Do</option><option value="inprogress">In Progress</option><option value="done">Done</option></select></div>
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Due Date</label><input type="date" value={tForm.dueDate} onChange={e=>setTForm({...tForm,dueDate:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/></div>
          </div>
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Progress — {tForm.progress}%</label><input type="range" min="0" max="100" step="5" value={tForm.progress} onChange={e=>setTForm({...tForm,progress:+e.target.value})} className="w-full accent-violet-600"/></div>
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Notes</label><textarea value={tForm.notes} onChange={e=>setTForm({...tForm,notes:e.target.value})} rows={3} placeholder="Context, links, sub-tasks…" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-200"/></div>
        </div>
        <div className="p-5 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={closeTF} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={editTid?saveT:addT} disabled={!tForm.title.trim()} className="px-6 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">{editTid?"Save":"Add Task"}</button>
        </div>
      </div>
    </div>}

    {/* Note Form */}
    {showNF&&<div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-slate-100 flex justify-between"><h2 className="text-base font-bold">{editNid?"Edit Note":"New Note"}</h2><button onClick={closeNF} className="text-slate-400 text-xl">×</button></div>
        <div className="p-5 space-y-4">
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Title</label><input type="text" value={nForm.title} onChange={e=>setNForm({...nForm,title:e.target.value})} placeholder="Note title…" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/></div>
          <div className="grid grid-cols-2 gap-3 items-end">
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Category</label><select value={nForm.category} onChange={e=>setNForm({...nForm,category:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200">{NCATS.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
            <label className="flex items-center gap-2 cursor-pointer pb-1"><input type="checkbox" checked={nForm.pinned} onChange={e=>setNForm({...nForm,pinned:e.target.checked})} className="w-4 h-4 accent-violet-600"/><span className="text-sm text-slate-700">📌 Pin</span></label>
          </div>
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Content</label><textarea value={nForm.content} onChange={e=>setNForm({...nForm,content:e.target.value})} rows={8} placeholder="Write your note…" className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm resize-none focus:outline-none focus:ring-2 focus:ring-violet-200 leading-relaxed"/></div>
        </div>
        <div className="p-5 border-t border-slate-100 flex justify-end gap-2">
          <button onClick={closeNF} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={editNid?saveN:addN} disabled={!nForm.title.trim()&&!nForm.content.trim()} className="px-6 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold disabled:opacity-50">{editNid?"Save":"Add Note"}</button>
        </div>
      </div>
    </div>}

    {/* View Note */}
    {viewNote&&<div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-5 border-b border-slate-100 flex items-start justify-between">
          <div><h2 className="text-base font-bold">{viewNote.title||"Untitled"}</h2><p className="text-xs text-slate-400 mt-0.5">{viewNote.category} · {fmt(viewNote.dateModified)}</p></div>
          <div className="flex items-center gap-1 ml-2">
            <button onClick={()=>pinN(viewNote.id)} className="p-1.5 text-slate-300 hover:text-amber-500 rounded-lg text-sm">{viewNote.pinned?"📌":"📍"}</button>
            <button onClick={()=>{openNF(viewNote);setVNid(null)}} className="p-1.5 text-slate-300 hover:text-violet-600 rounded-lg text-sm">✏️</button>
            <button onClick={()=>setVNid(null)} className="p-1.5 text-slate-400 hover:text-slate-600 text-xl leading-none ml-1">×</button>
          </div>
        </div>
        <div className="p-5 overflow-y-auto"><p className="text-sm text-slate-700 whitespace-pre-wrap leading-relaxed">{viewNote.content||<span className="text-slate-400 italic">Empty note.</span>}</p></div>
      </div>
    </div>}

    {/* Delete Confirm */}
    {(delTid||delNid)&&<div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <p className="text-base font-semibold mb-2">Delete {delTid?"task":"note"}?</p>
        <p className="text-sm text-slate-500 mb-5">"{delTid?tasks.find(t=>t.id===delTid)?.title:notes.find(n=>n.id===delNid)?.title}" will be removed.</p>
        <div className="flex justify-end gap-2">
          <button onClick={()=>{setDTid(null);setDNid(null)}} className="px-4 py-2 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50">Cancel</button>
          <button onClick={()=>delTid?delT(delTid):delN(delNid)} className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-semibold">Delete</button>
        </div>
      </div>
    </div>}

  </div>);
}
