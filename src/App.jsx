import { useState, useEffect, useRef, useCallback } from "react";
import { signInWithPopup, signOut, onAuthStateChanged } from "firebase/auth";
import {
  collection, doc, getDocs, setDoc, deleteDoc, onSnapshot,
} from "firebase/firestore";
import { auth, db, provider } from "./firebase";

// ─── Runtime AI keys (can be overridden in Settings UI) ──────────────────────
let runtimeGeminiKey = localStorage.getItem("gemini_key") || "";
let runtimeClaudeKey = localStorage.getItem("claude_key") || "";

// ─── Constants ───────────────────────────────────────────────────────────────
const PRI = [
  { id:"urgent", label:"🔴 Urgent", bar:"border-l-red-500",    badge:"bg-red-100 text-red-700",      dot:"bg-red-500"     },
  { id:"high",   label:"🟠 High",   bar:"border-l-orange-400", badge:"bg-orange-100 text-orange-700", dot:"bg-orange-400"  },
  { id:"medium", label:"🟡 Medium", bar:"border-l-amber-400",  badge:"bg-amber-100 text-amber-700",   dot:"bg-amber-400"   },
  { id:"low",    label:"🟢 Low",    bar:"border-l-emerald-400",badge:"bg-emerald-100 text-emerald-700",dot:"bg-emerald-400"},
];
const DEFAULT_TCATS = ["Work","Personal","Ideas","Research","Meeting","Learning","Other"];
const NCATS = ["Work","Personal","Ideas","Reference","Meeting","Research","Journal","Other"];
const BLANK_T = {title:"",notes:"",category:"Work",priority:"medium",status:"todo",progress:0,dueDate:"",remindAt:"",subtasks:[]};
const BLANK_N = {title:"",content:"",category:"Work",pinned:false};

const pc   = id => PRI.find(p=>p.id===id)||PRI[2];
const fmt  = iso => iso ? new Date(iso).toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}) : "";
const uid  = () => Date.now().toString(36)+Math.random().toString(36).slice(2);
const today= () => new Date().toISOString().split("T")[0];
const calcDuration = (dateAdded, dueDate) => {
  if(!dateAdded || !dueDate) return null;
  const days = Math.round((new Date(dueDate+"T00:00:00") - new Date(dateAdded)) / 86400000);
  return days < 0 ? null : days === 0 ? "same day" : days === 1 ? "1 day" : `${days} days`;
};

// ─── VAPID push helper ────────────────────────────────────────────────────────
const VAPID_PUB = import.meta.env.VITE_VAPID_PUBLIC_KEY ||
  "BAAKJlAxDdofuJZIxwmljTawQSKlis5-4ZfKJflsamih3ECcyBJOz5NzzI1PNel1yXB2sVy08PdWNkBTTvqVdds";

function urlBase64ToUint8Array(b64) {
  const pad = "=".repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g,"+").replace(/_/g,"/"));
  return Uint8Array.from([...raw].map(c=>c.charCodeAt(0)));
}

// ─── Gemini API helper ────────────────────────────────────────────────────────
const GEMINI_KEY_ENV = import.meta.env.VITE_GEMINI_API_KEY || "";

function getGeminiUrl() {
  const key = runtimeGeminiKey || GEMINI_KEY_ENV;
  return `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
}

async function askGemini(prompt, maxTokens = 600) {
  const res = await fetch(getGeminiUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.find(p => p.text)?.text ?? "";
}

async function askClaude(prompt, maxTokens = 600) {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, apiKey: runtimeClaudeKey, maxTokens }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Claude error ${res.status}`);
  return data.text ?? "";
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user,    setUser]   = useState(undefined);
  const [tasks,   setTasks]  = useState([]);
  const [notes,   setNotes]  = useState([]);
  const [cfg,     setCfg]    = useState({time:"08:00"});
  const [lastEmail,setLE]    = useState("");
  const [tab,     setTab]    = useState("home");
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
  const [showKey,  setShowKey]  = useState(false);
  const [keyInput, setKeyInput] = useState(runtimeGeminiKey||"");
  const [claudeKeyInput, setClaudeKeyInput] = useState(runtimeClaudeKey||"");
  const [showClaudeKey, setShowClaudeKey] = useState(false);

  // AI provider
  const [aiProvider, setAiProvider] = useState(localStorage.getItem("ai_provider")||"gemini");

  // Dynamic task categories
  const [taskCats,    setTaskCats]    = useState(DEFAULT_TCATS);
  const [newCatInput, setNewCatInput] = useState("");

  // Subtask inline input
  const [newSubInput,    setNewSubInput]    = useState({});
  const [newSubSubInput, setNewSubSubInput] = useState({});
  const [subDetail,    setSubDetail]    = useState({});
  const [subSubDetail, setSubSubDetail] = useState({});
  // Google Calendar state
  const [gcalToken,    setGcalToken]    = useState(null);
  const [gcalEvents,   setGcalEvents]   = useState([]);
  const [gcalSyncing,  setGcalSyncing]  = useState(false);
  const [gcalLastSync, setGcalLastSync] = useState(null);
  const [gcalError,    setGcalError]    = useState(null);

  // Import
  const [impTxt, setIT]  = useState("");
  const [impLoad,setIL]  = useState(false);
  const [impRes, setIR]  = useState(null);

  // ── Notifications state ──────────────────────────────────────────────────
  const [notifPerm, setNotifPerm] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "denied"
  );

  // ── Push subscription state ──────────────────────────────────────────────
  const [pushSub,     setPushSub]     = useState(null);
  const [pushLoading, setPushLoading] = useState(false);

  // ── AI Chat state ────────────────────────────────────────────────────────
  const WELCOME = "Hi! I'm your AI assistant 👋\n\nYou can:\n• Tell me tasks — \"Finish report by Friday\"\n• Save notes — \"Note: meeting moved to 3pm\"\n• Ask questions — \"What are my urgent tasks?\"\n• Draft emails — \"Email team about project delay\"\n• Search the web — \"Find best productivity tips\"";
  const [chatMsgs,    setChatMsgs]    = useState([{role:"ai", text:WELCOME}]);
  const [chatInput,   setChatInput]   = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [pendingActions, setPendingActions] = useState([]);
  const chatEndRef = useRef(null);

  // Refs for auto-email
  const cRef  = useRef(cfg);
  const leRef = useRef(lastEmail);
  useEffect(()=>{cRef.current=cfg},[cfg]);
  useEffect(()=>{leRef.current=lastEmail},[lastEmail]);

  // Auto-scroll chat
  useEffect(()=>{
    chatEndRef.current?.scrollIntoView({behavior:"smooth"});
  },[chatMsgs, chatLoading]);

  // ── Auth listener ────────────────────────────────────────────────────────
  useEffect(()=>{
    const unsub = onAuthStateChanged(auth, u => setUser(u ?? null));
    return unsub;
  },[]);

  // ── Service worker registration + check existing push subscription ────────
  useEffect(()=>{
    if(!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").then(async reg=>{
      const existing = await reg.pushManager.getSubscription();
      if(existing) setPushSub(existing);
    }).catch(()=>{});
  },[]);

  // ── Notification helpers ─────────────────────────────────────────────────
  const requestNotifPermission = async () => {
    if(typeof Notification === "undefined") return;
    const perm = await Notification.requestPermission();
    setNotifPerm(perm);
    if(perm === "granted") showT("🔔 Notifications enabled!");
  };

  // ── Web Push subscribe / unsubscribe ─────────────────────────────────────
  const subscribePush = async () => {
    setPushLoading(true);
    try {
      const perm = await Notification.requestPermission();
      setNotifPerm(perm);
      if(perm !== "granted"){ showT("Please allow notifications first","err"); return; }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUB),
      });
      setPushSub(sub);
      const newCfg = {...cfg, pushSubscription: sub.toJSON()};
      setCfg(newCfg); setCfgForm(newCfg);
      await saveConfig(newCfg);
      await setDoc(doc(db,"subscribedUsers",user.uid),{uid:user.uid,updatedAt:new Date().toISOString()});
      showT("🔔 Push notifications enabled!");
    } catch(e){ showT("Push setup failed: "+e.message,"err"); }
    setPushLoading(false);
  };

  const unsubscribePush = async () => {
    setPushLoading(true);
    try {
      await pushSub?.unsubscribe();
      setPushSub(null);
      const newCfg = {...cfg, pushSubscription: null};
      setCfg(newCfg); setCfgForm(newCfg);
      await saveConfig(newCfg);
      await deleteDoc(doc(db,"subscribedUsers",user.uid));
      showT("Notifications disabled");
    } catch(e){ showT("Error: "+e.message,"err"); }
    setPushLoading(false);
  };

  const saveRemCfg = async () => {
    const newCfg = {...cfg, ...cfgForm};
    setCfg(newCfg);
    await saveConfig(newCfg);
    showT("⏰ Reminder settings saved!");
  };

  const toggleDay = day => {
    const days = cfgForm.days || ["Mon","Tue","Wed","Thu","Fri"];
    setCfgForm({...cfgForm, days: days.includes(day)?days.filter(d=>d!==day):[...days,day]});
  };

  const updateTaskReminder = async (taskId, remindAt) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    await saveTask({...task, remindAt});
  };

  const fireNotif = (title, body, tag) => {
    if(typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try { new Notification(title, { body, tag, icon: "/favicon.ico" }); } catch(e) {}
  };

  // ── Reminder timer: fires at cfg.time each day & on overdue tasks ─────────
  useEffect(()=>{
    if(!user || notifPerm !== "granted") return;
    const check = () => {
      const now = new Date();
      const hhmm = `${String(now.getHours()).padStart(2,"0")}:${String(now.getMinutes()).padStart(2,"0")}`;
      const todayStr = now.toISOString().split("T")[0];

      // Daily reminder at configured time
      if(hhmm === (cfg.time||"08:00")) {
        const active = tasks.filter(t=>t.status!=="done");
        const overdue = active.filter(t=>t.dueDate&&t.dueDate<todayStr);
        const dueToday = active.filter(t=>t.dueDate===todayStr);
        const lines = [];
        if(overdue.length) lines.push(`⚠ ${overdue.length} overdue`);
        if(dueToday.length) lines.push(`📅 ${dueToday.length} due today`);
        lines.push(`${active.length} active tasks total`);
        fireNotif("📋 Daily Reminder", lines.join(" · "), "daily-reminder");
      }

      // Immediate overdue alert (once per session, on first detect)
      const overdueNow = tasks.filter(t=>t.dueDate&&t.dueDate<todayStr&&t.status!=="done");
      if(overdueNow.length && !sessionStorage.getItem("overdue-alerted")) {
        sessionStorage.setItem("overdue-alerted","1");
        fireNotif(`⚠ ${overdueNow.length} Overdue Task${overdueNow.length>1?"s":""}`,
          overdueNow.slice(0,3).map(t=>t.title).join(", ")+(overdueNow.length>3?"…":""),
          "overdue-alert");
      }
    };
    check(); // run immediately on mount/update
    const timer = setInterval(check, 60_000); // then every minute
    return ()=>clearInterval(timer);
  },[user, notifPerm, tasks, cfg.time]);

  // ── Load from Firestore when user signs in ───────────────────────────────
  useEffect(()=>{
    if(!user) return;
    const unsubT = onSnapshot(collection(db,"users",user.uid,"tasks"), snap=>{
      setTasks(snap.docs.map(d=>({id:d.id,...d.data()})));
    });
    const unsubN = onSnapshot(collection(db,"users",user.uid,"notes"), snap=>{
      setNotes(snap.docs.map(d=>({id:d.id,...d.data()})));
    });
    getDocs(collection(db,"users",user.uid,"settings")).then(snap=>{
      const c = snap.docs.find(d=>d.id==="config")?.data();
      if(c){ setCfg(c); setCfgForm(c); }
      const cats = snap.docs.find(d=>d.id==="taskCategories")?.data()?.list;
      if(cats?.length) setTaskCats(cats);
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

  const saveCats = async cats => {
    if(!user) return;
    await setDoc(doc(db,"users",user.uid,"settings","taskCategories"), {list: cats});
  };
  const addCat = async () => {
    const name = newCatInput.trim();
    if(!name || taskCats.includes(name)) return;
    const updated = [...taskCats, name];
    setTaskCats(updated); setNewCatInput(""); await saveCats(updated);
  };
  const deleteCat = async cat => {
    const updated = taskCats.filter(c=>c!==cat);
    setTaskCats(updated); await saveCats(updated);
  };
  // ── Subtask CRUD
  const addSubtask = async (taskId, title) => {
    const task = tasks.find(t=>t.id===taskId); if(!task||!title.trim()) return;
    const sub = {id:uid(), title:title.trim(), done:false, subtasks:[], dateAdded:new Date().toISOString()};
    await saveTask({...task, subtasks:[...(task.subtasks||[]), sub]});
    setNewSubInput(p=>({...p,[taskId]:""}));
  };
  const toggleSubtask = async (taskId, subtaskId) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId?{...s,done:!s.done}:s);
    const doneCount = subs.filter(s=>s.done).length;
    const prog = subs.length ? Math.round(doneCount/subs.length*100) : task.progress;
    const status = prog===100?"done":prog>0?"inprogress":"todo";
    await saveTask({...task, subtasks:subs, progress:prog, status, completedAt:status==="done"?new Date().toISOString():null});
  };
  const deleteSubtask = async (taskId, subtaskId) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    await saveTask({...task, subtasks:(task.subtasks||[]).filter(s=>s.id!==subtaskId)});
  };
  const addSubSubtask = async (taskId, subtaskId, title) => {
    const task = tasks.find(t=>t.id===taskId); if(!task||!title.trim()) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId
      ? {...s, subtasks:[...(s.subtasks||[]), {id:uid(), title:title.trim(), done:false, dateAdded:new Date().toISOString()}]}
      : s);
    await saveTask({...task, subtasks:subs});
    setNewSubSubInput(p=>({...p,[subtaskId]:""}));
  };
  const toggleSubSubtask = async (taskId, subtaskId, subId) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId
      ? {...s, subtasks:(s.subtasks||[]).map(ss=>ss.id===subId?{...ss,done:!ss.done}:ss)}
      : s);
    await saveTask({...task, subtasks:subs});
  };
  const deleteSubSubtask = async (taskId, subtaskId, subId) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId
      ? {...s, subtasks:(s.subtasks||[]).filter(ss=>ss.id!==subId)}
      : s);
    await saveTask({...task, subtasks:subs});
  };
  const updateSubtaskField = async (taskId, subtaskId, field, value) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId?{...s,[field]:value}:s);
    await saveTask({...task, subtasks:subs});
  };

  const updateSubSubtaskField = async (taskId, subtaskId, subId, field, value) => {
    const task = tasks.find(t=>t.id===taskId); if(!task) return;
    const subs = (task.subtasks||[]).map(s=>s.id===subtaskId
      ? {...s, subtasks:(s.subtasks||[]).map(ss=>ss.id===subId?{...ss,[field]:value}:ss)}
      : s);
    await saveTask({...task, subtasks:subs});
  };

  // ── Tasks CRUD ───────────────────────────────────────────────────────────
  const addT = async () => {
    const t = {...tForm, id:uid(), dateAdded:new Date().toISOString(), completedAt:null};
    await saveTask(t);
    closeTF();
  };
  const saveT = async () => {
    const orig = tasks.find(t=>t.id===editTid); if(!orig) return;
    const merged = {...orig, ...tForm};
    // Fix completedAt when status changes to/from done via form
    if(merged.status==="done" && !merged.completedAt) merged.completedAt = new Date().toISOString();
    if(merged.status!=="done") merged.completedAt = null;
    if(merged.status==="done") merged.progress = 100;
    await saveTask(merged);
    closeTF();
  };
  const delT = async id => {
    await removeTask(id);
    if(expId===id) setExpId(null);
    setDTid(null);
  };
  const closeTF = ()=>{ setSTF(false); setETid(null); setTForm(BLANK_T); };
  const openTF  = t=>{ setTForm({title:t.title,notes:t.notes||"",category:t.category,priority:t.priority,status:t.status,progress:t.progress,dueDate:t.dueDate||"",remindAt:t.remindAt||""}); setETid(t.id); setSTF(true); };

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

  // ── Google Calendar ──────────────────────────────────────────────────────
  const connectGoogleCalendar = async () => {
    const calProvider = new GoogleAuthProvider();
    calProvider.addScope("https://www.googleapis.com/auth/calendar");
    try {
      const result = await signInWithPopup(auth, calProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      setGcalToken(credential.accessToken);
      setGcalError(null);
      showT("📅 Google Calendar connected!");
    } catch(e) {
      setGcalError("Failed to connect: " + (e.message||e.code));
    }
  };

  const syncWithGoogleCalendar = async () => {
    if (!gcalToken) return;
    setGcalSyncing(true); setGcalError(null);
    const headers = { "Authorization": `Bearer ${gcalToken}`, "Content-Type": "application/json" };
    try {
      const mapRef = doc(db, "users", user.uid, "settings", "gcalMapping");
      const mapSnap = await getDoc(mapRef);
      let eventMap = mapSnap.exists() ? mapSnap.data() : {};
      const tasksWithDue = tasks.filter(t => t.dueDate && t.status !== "done");
      const colorMap = { urgent:"11", high:"6", medium:"5", low:"2" };
      for (const task of tasksWithDue) {
        const event = {
          summary: `[Task] ${task.title}`,
          description: `Priority: ${task.priority}\nCategory: ${task.category}${task.notes?"\n\n"+task.notes:""}`,
          start: { date: task.dueDate },
          end:   { date: task.dueDate },
          colorId: colorMap[task.priority] || "5",
        };
        if (eventMap[task.id]) {
          await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventMap[task.id]}`,
            { method:"PATCH", headers, body:JSON.stringify(event) });
        } else {
          const resp = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events",
            { method:"POST", headers, body:JSON.stringify(event) });
          if (resp.ok) { const created = await resp.json(); eventMap[task.id] = created.id; }
        }
      }
      await setDoc(mapRef, eventMap);
      const now    = new Date().toISOString();
      const future = new Date(Date.now() + 30*24*60*60*1000).toISOString();
      const evResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${future}&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers }
      );
      if (evResp.status === 401) {
        setGcalToken(null); setGcalError("Session expired — reconnect."); setGcalSyncing(false); return;
      }
      const evData = await evResp.json();
      setGcalEvents(evData.items || []);
      setGcalLastSync(new Date().toISOString());
      showT(`📅 Synced! Pushed ${tasksWithDue.length} tasks, pulled ${(evData.items||[]).length} events.`);
    } catch(e) {
      setGcalError("Sync failed: " + e.message);
    }
    setGcalSyncing(false);
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

  // ── AI Chat (Gemini) ─────────────────────────────────────────────────────
  const buildContext = () => {
    const activeTasks = tasks.filter(t=>t.status!=="done");
    const lines = ["Today: " + new Date().toDateString()];
    if(activeTasks.length){
      lines.push("\nACTIVE TASKS (" + activeTasks.length + " total, showing top 12):");
      const sorted = [...activeTasks].sort((a,b)=>({urgent:0,high:1,medium:2,low:3})[a.priority]-({urgent:0,high:1,medium:2,low:3})[b.priority]);
      sorted.slice(0,12).forEach(t=>{
        lines.push("\u2022 [" + t.priority.toUpperCase() + "] " + t.title + (t.dueDate?" due:"+t.dueDate:"") + (t.category!=="Work"?" ("+t.category+")":""));
      });
    }
    if(notes.length){
      lines.push("\nNOTES (" + notes.length + " total, showing 5):");
      notes.slice(0,5).forEach(n=>{
        lines.push("\u2022 " + n.title + ": " + (n.content||"").slice(0,80));
      });
    }
    return lines.join("\n");
  };

  const sendChat = async () => {
    const input = chatInput.trim();
    if(!input || chatLoading) return;
    setChatInput("");
    setChatMsgs(m=>[...m, {role:"user", text:input}]);
    setChatLoading(true);

    const context = buildContext();
    const prompt = `You are an AI assistant inside a personal scheduler app. You help the user manage tasks, notes, emails, and find information.

${context}

USER MESSAGE: "${input}"

Analyze the user's message and respond with a JSON object (no markdown, no code fences, just raw JSON):
{
  "action": "CHAT|ADD_TASK|ADD_NOTE|ADD_BOTH|EMAIL_DRAFT|SEARCH",
  "reply": "Your friendly conversational response here",
  "task": {"title":"","notes":"","category":"Work","priority":"medium","dueDate":""},
  "note": {"title":"","content":"","category":"Work"},
  "email": {"to":"","subject":"","body":""},
  "searchQuery": ""
}

ACTION RULES:
- ADD_TASK: user wants to create a to-do, task, or action item
- ADD_NOTE: user wants to save information, a note, or reference material (not an action)
- ADD_BOTH: input is both a task and worth saving as a note
- EMAIL_DRAFT: user wants to write, draft, or send an email
- SEARCH: user wants to find information from the internet
- CHAT: general questions about tasks/notes, analysis, or conversation

For ADD_TASK: fill in task object. Priority: urgent/high/medium/low. Category: ${taskCats.join("/")}. dueDate: YYYY-MM-DD or empty.
For ADD_NOTE: fill in note object. Category: ${NCATS.join("/")}.
For EMAIL_DRAFT: fill in email object with to, subject, body.
For SEARCH: fill searchQuery with best search terms.
For CHAT: provide a helpful reply using the context above.

Keep reply friendly and concise.`;

    try {
      const raw = await (aiProvider==="claude" ? askClaude(prompt,1000) : askGemini(prompt, 1000));
      let parsed;
      try {
        const clean = raw.replace(/```json|```/g,"").trim();
        parsed = JSON.parse(clean);
      } catch {
        parsed = { action:"CHAT", reply: raw };
      }

      const aiMsg = {
        role:"ai",
        text: parsed.reply || "Done!",
        action: parsed.action,
        task: parsed.task,
        note: parsed.note,
        email: parsed.email,
        searchQuery: parsed.searchQuery,
        msgId: uid(),
      };
      setChatMsgs(m=>[...m, aiMsg]);

      if(parsed.action==="ADD_TASK"||parsed.action==="ADD_BOTH"){
        setPendingActions(pa=>[...pa, {type:"task", data:parsed.task, id:uid()}]);
      }
      if(parsed.action==="ADD_NOTE"||parsed.action==="ADD_BOTH"){
        setPendingActions(pa=>[...pa, {type:"note", data:parsed.note, id:uid()}]);
      }
    } catch(e) {
      setChatMsgs(m=>[...m, {role:"ai", text:`⚠️ AI error. Check your ${aiProvider==="claude"?"Claude":"Gemini"} API key in Settings (⚙️).`}]);
    }
    setChatLoading(false);
  };

  const confirmPending = async (pending) => {
    if(pending.type==="task"){
      const t = {...BLANK_T, ...pending.data, id:uid(), dateAdded:new Date().toISOString(), completedAt:null};
      await saveTask(t);
      showT(`✅ Task added: "${t.title}"`);
    } else if(pending.type==="note"){
      const n = {...BLANK_N, ...pending.data, id:uid(), dateCreated:new Date().toISOString(), dateModified:new Date().toISOString()};
      await saveNote(n);
      showT(`📓 Note saved: "${n.title}"`);
    }
    setPendingActions(pa=>pa.filter(p=>p.id!==pending.id));
  };

  const dismissPending = (id) => setPendingActions(pa=>pa.filter(p=>p.id!==id));

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
      const text = await (aiProvider==="claude" ? askClaude(prompt,600) : askGemini(prompt, 600));
      setBrief(text);
    } catch(e) {
      setBrief("⚠ AI error. Check your API key in Settings (⚙).");
    }
    setBLoad(false);
  };

  // ── AI Smart Import (Gemini) ──────────────────────────────────────────────
  const doImport = async () => {
    if(!impTxt.trim()) return; setIL(true); setIR(null);
    const prompt = `Parse these notes into tasks. Return ONLY a valid JSON array, no markdown fences, no explanation:\n[{"title":"","notes":"","category":"Work","priority":"medium","dueDate":""}]\nPriority values: urgent/high/medium/low. Category values: ${taskCats.join("/")}\n\nNotes:\n${impTxt}`;
    try {
      const raw  = await (aiProvider==="claude" ? askClaude(prompt,2000) : askGemini(prompt, 2000));
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
      if(nSearch){const q=nSearch.toLowerCase();if(!n.title.toLowerCase().includes(q)&&!(n.content||"").toLowerCase().includes(q)) return false;}
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
        <p className="text-slate-400 text-sm mb-8">Tasks · Notes · AI Assistant</p>
        <button
          onClick={()=>signInWithPopup(auth,provider).catch(e=>{
            if(e.code==="auth/popup-blocked"||e.code==="auth/popup-closed-by-user") {
              alert("Popup blocked. Please allow popups for this site and try again.");
            }
          })}
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
          {user.photoURL&&<img src={user.photoURL} alt="" className="w-8 h-8 rounded-full hidden sm:block" referrerPolicy="no-referrer"/>}
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
        {[{id:"home",l:"🤖 AI"},{id:"tasks",l:"📝 Tasks"},{id:"notes",l:"📓 Notes"},{id:"calendar",l:"📅 Calendar"},{id:"daily",l:"☀️ Daily"},{id:"reminders",l:"🔔 Reminders"},{id:"import",l:"✨ Import"}].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} className={`px-4 py-3 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${tab===t.id?"border-violet-600 text-violet-700":"border-transparent text-slate-500 hover:text-slate-700"}`}>{t.l}</button>
        ))}
      </div>
    </div>

    <main className="max-w-3xl mx-auto px-4 py-5">

      {/* ── HOME / AI CHAT ── */}
      {tab==="home"&&(
        <div className="flex flex-col" style={{height:"calc(100vh - 130px)"}}>

          {/* Stats bar */}
          <div className="flex gap-2 mb-3 flex-wrap">
            <button onClick={()=>setTab("tasks")} className="flex items-center gap-1.5 text-xs bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-slate-600 hover:border-violet-300 hover:text-violet-700 transition-colors">
              <span className="font-bold text-slate-800">{tasks.filter(t=>t.status!=="done").length}</span> active tasks
            </button>
            {tasks.filter(t=>t.dueDate&&t.dueDate<today()&&t.status!=="done").length>0&&(
              <button onClick={()=>setTab("tasks")} className="flex items-center gap-1.5 text-xs bg-red-50 border border-red-200 rounded-xl px-3 py-1.5 text-red-700 hover:bg-red-100 transition-colors">
                ⚠ <span className="font-bold">{tasks.filter(t=>t.dueDate&&t.dueDate<today()&&t.status!=="done").length}</span> overdue
              </button>
            )}
            <button onClick={()=>setTab("notes")} className="flex items-center gap-1.5 text-xs bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-slate-600 hover:border-violet-300 hover:text-violet-700 transition-colors">
              <span className="font-bold text-slate-800">{notes.length}</span> notes
            </button>
            <div className="ml-auto flex items-center gap-2">
              {/* AI Provider toggle */}
              <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs font-medium">
                <button onClick={()=>{setAiProvider("gemini");localStorage.setItem("ai_provider","gemini");}} className={`px-2.5 py-1 transition-colors ${aiProvider==="gemini"?"bg-violet-600 text-white":"bg-white text-slate-500 hover:bg-slate-50"}`}>✦ Gemini</button>
                <button onClick={()=>{setAiProvider("claude");localStorage.setItem("ai_provider","claude");}} className={`px-2.5 py-1 transition-colors border-l border-slate-200 ${aiProvider==="claude"?"bg-violet-600 text-white":"bg-white text-slate-500 hover:bg-slate-50"}`}>◆ Claude</button>
              </div>
              <button onClick={()=>{setChatMsgs([{role:"ai",text:WELCOME}]);setPendingActions([]);}} className="text-xs text-slate-400 hover:text-slate-600 px-2 py-1.5">Clear</button>
            </div>
          </div>

          {/* Pending action banners */}
          {pendingActions.length>0&&(
            <div className="mb-3 space-y-2">
              {pendingActions.map(pa=>(
                <div key={pa.id} className={`flex items-center gap-3 p-3 rounded-xl border ${pa.type==="task"?"bg-violet-50 border-violet-200":"bg-amber-50 border-amber-200"}`}>
                  <span className="text-lg">{pa.type==="task"?"📝":"📓"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{pa.type==="task"?"Add Task":"Save Note"}</p>
                    <p className="text-sm font-medium text-slate-800 truncate">{pa.data?.title}</p>
                    {pa.type==="task"&&pa.data?.priority&&<p className="text-xs text-slate-500">{pc(pa.data.priority).label} · {pa.data?.category||"Work"}</p>}
                  </div>
                  <button onClick={()=>confirmPending(pa)} className={`text-xs font-semibold px-3 py-1.5 rounded-lg text-white ${pa.type==="task"?"bg-violet-600 hover:bg-violet-700":"bg-amber-500 hover:bg-amber-600"}`}>✓ Add</button>
                  <button onClick={()=>dismissPending(pa.id)} className="text-xs px-2 py-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100">✕</button>
                </div>
              ))}
            </div>
          )}

          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto space-y-3 pb-3 pr-1">
            {chatMsgs.map((msg,i)=>(
              <div key={i} className={`flex ${msg.role==="user"?"justify-end":"justify-start"}`}>
                <div className={`max-w-[85%] ${msg.role==="ai"?"flex items-start gap-2":""}`}>
                  {msg.role==="ai"&&<div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-sm flex-shrink-0 mt-0.5">🤖</div>}
                  <div>
                    <div className={`px-4 py-3 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
                      msg.role==="user"
                        ?"bg-violet-600 text-white rounded-br-sm"
                        :"bg-white border border-slate-200 text-slate-800 rounded-bl-sm shadow-sm"
                    }`}>{msg.text}</div>
                    {msg.role==="ai"&&msg.action==="SEARCH"&&msg.searchQuery&&(
                      <a href={`https://www.google.com/search?q=${encodeURIComponent(msg.searchQuery)}`} target="_blank" rel="noreferrer"
                        className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-blue-50 border border-blue-200 text-blue-700 px-3 py-1.5 rounded-lg hover:bg-blue-100 transition-colors">
                        🔍 Search: "{msg.searchQuery}"
                      </a>
                    )}
                    {msg.role==="ai"&&msg.action==="EMAIL_DRAFT"&&msg.email&&(
                      <a href={`mailto:${encodeURIComponent(msg.email.to||"")}?subject=${encodeURIComponent(msg.email.subject||"")}&body=${encodeURIComponent(msg.email.body||"")}`}
                        className="mt-1.5 inline-flex items-center gap-1.5 text-xs bg-emerald-50 border border-emerald-200 text-emerald-700 px-3 py-1.5 rounded-lg hover:bg-emerald-100 transition-colors">
                        📧 Open in email app
                      </a>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {chatLoading&&(
              <div className="flex justify-start">
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-full bg-violet-100 flex items-center justify-center text-sm flex-shrink-0">🤖</div>
                  <div className="bg-white border border-slate-200 rounded-2xl rounded-bl-sm px-4 py-3 shadow-sm">
                    <div className="flex gap-1">
                      <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{animationDelay:"0ms"}}/>
                      <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{animationDelay:"150ms"}}/>
                      <span className="w-2 h-2 bg-violet-400 rounded-full animate-bounce" style={{animationDelay:"300ms"}}/>
                    </div>
                  </div>
                </div>
              </div>
            )}
            <div ref={chatEndRef}/>
          </div>

          {/* Quick suggestion chips (only show at start) */}
          {chatMsgs.length<=1&&(
            <div className="flex flex-wrap gap-2 mb-3">
              {["What are my urgent tasks?","Summarize my notes","Add task: Review emails","Email boss about status"].map(s=>(
                <button key={s} onClick={()=>setChatInput(s)} className="text-xs bg-white border border-slate-200 rounded-full px-3 py-1.5 text-slate-600 hover:border-violet-300 hover:text-violet-700 transition-colors">{s}</button>
              ))}
            </div>
          )}

          {/* Input */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm flex items-end gap-2 p-3">
            <textarea
              value={chatInput}
              onChange={e=>setChatInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendChat();}}}
              placeholder="Ask me anything, add a task, save a note, draft an email…"
              rows={1}
              style={{resize:"none",minHeight:"36px",maxHeight:"120px",overflowY:"auto"}}
              className="flex-1 text-sm text-slate-800 focus:outline-none placeholder-slate-400 leading-relaxed bg-transparent"
              onInput={e=>{e.target.style.height="auto";e.target.style.height=e.target.scrollHeight+"px";}}
            />
            <button onClick={sendChat} disabled={!chatInput.trim()||chatLoading}
              className="bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-xl w-9 h-9 flex items-center justify-center flex-shrink-0 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* ── TASKS ── */}
      {tab==="tasks"&&<>
        <div className="flex flex-wrap gap-2 mb-4">
          <input value={tSearch} onChange={e=>setTS(e.target.value)} placeholder="Search…" className="flex-1 min-w-32 px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"/>
          <select value={fStat} onChange={e=>setFStat(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="active">Active</option><option value="done">Done</option><option value="all">All</option></select>
          <select value={fPri}  onChange={e=>setFPri(e.target.value)}  className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="all">All Priorities</option>{PRI.map(p=><option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <select value={fCat}  onChange={e=>setFCat(e.target.value)}  className="px-3 py-2 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="all">All Categories</option>{taskCats.map(c=><option key={c} value={c}>{c}</option>)}</select>
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
                        {task.dateAdded&&<span>📅 Added {fmt(task.dateAdded)}</span>}
                        {task.dueDate&&<span className={ov?"text-red-500 font-medium":""}>{ov?"⚠ Overdue · Due ":"Due "}{fmt(task.dueDate+"T00:00:00")}</span>}
                        {task.dateAdded&&task.dueDate&&calcDuration(task.dateAdded,task.dueDate)&&<span>⏱ {calcDuration(task.dateAdded,task.dueDate)}</span>}
                        {done&&task.completedAt&&<span className="text-emerald-500">✓ Done {fmt(task.completedAt)}</span>}
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        <div className="flex-1 bg-slate-100 rounded-full h-1.5"><div className={`h-1.5 rounded-full transition-all ${done?"bg-emerald-400":task.progress>60?"bg-violet-500":task.progress>30?"bg-amber-400":"bg-slate-300"}`} style={{width:`${task.progress}%`}}/></div>
                        <span className="text-xs text-slate-400 w-7 text-right">{task.progress}%</span>
                      </div>
                    </div>
                  </div>
                </div>
                {exp&&<div className="border-t border-slate-100 bg-slate-50 rounded-b-2xl px-4 py-4 space-y-4">
                  {task.notes&&<div><p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1.5">Notes</p><p className="text-sm text-slate-700 leading-relaxed whitespace-pre-wrap">{task.notes}</p></div>}
                  <div>
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Subtasks {(task.subtasks||[]).length>0&&<span className="normal-case font-normal">({(task.subtasks||[]).filter(s=>s.done).length}/{(task.subtasks||[]).length})</span>}</p>
                    <div className="space-y-1 mb-2">
                      {(task.subtasks||[]).map(sub=>{
                        const subExp = !!subDetail[sub.id];
                        return (
                        <div key={sub.id}>
                          <div className="flex items-center gap-2 py-1 group/sub">
                            <button onClick={()=>toggleSubtask(task.id,sub.id)} className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center text-[10px] transition-all ${sub.done?"bg-emerald-500 border-emerald-500 text-white":"border-slate-300 hover:border-violet-400"}`}>{sub.done?"✓":""}</button>
                            <span className={`flex-1 text-sm ${sub.done?"line-through text-slate-400":"text-slate-700"}`}>{sub.title}</span>
                            {sub.dueDate&&<span className="text-[10px] text-slate-400 hidden group-hover/sub:inline">{fmt(sub.dueDate+"T00:00:00")}</span>}
                            <button onClick={()=>setSubDetail(p=>({...p,[sub.id]:!p[sub.id]}))} className={`text-[10px] px-1.5 py-0.5 rounded transition-colors ${subExp?"bg-violet-100 text-violet-600":"text-slate-300 hover:text-violet-500"}`}>{subExp?"▲":"▼"}</button>
                            <button onClick={()=>deleteSubtask(task.id,sub.id)} className="opacity-0 group-hover/sub:opacity-100 text-xs text-slate-300 hover:text-red-500 transition-opacity px-1">✕</button>
                          </div>
                          {subExp&&(
                            <div className="ml-6 mb-2 p-2 bg-white border border-violet-100 rounded-xl space-y-2">
                              <div className="grid grid-cols-2 gap-2">
                                <div>
                                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Date Added</label>
                                  <input type="date" value={sub.dateAdded?sub.dateAdded.split("T")[0]:""} onChange={e=>updateSubtaskField(task.id,sub.id,"dateAdded",e.target.value?new Date(e.target.value).toISOString():"")} className="w-full text-xs px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                </div>
                                <div>
                                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Due Date</label>
                                  <input type="date" value={sub.dueDate||""} onChange={e=>updateSubtaskField(task.id,sub.id,"dueDate",e.target.value)} className="w-full text-xs px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                </div>
                              </div>
                              <div>
                                  <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Duration</label>
                                  <input type="text" value={sub.duration||""} onChange={e=>updateSubtaskField(task.id,sub.id,"duration",e.target.value)} placeholder="e.g. 3 days" className="w-full text-xs px-2 py-1.5 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                </div>
                            </div>
                          )}
                          {/* Sub-subtasks */}
                          <div className="ml-6 space-y-0.5">
                            {(sub.subtasks||[]).map(ss=>{
                              const ssExp = !!subSubDetail[ss.id];
                              return (
                              <div key={ss.id}>
                                <div className="flex items-center gap-2 py-0.5 group/ss">
                                  <button onClick={()=>toggleSubSubtask(task.id,sub.id,ss.id)} className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[9px] transition-all ${ss.done?"bg-violet-400 border-violet-400 text-white":"border-slate-300 hover:border-violet-400"}`}>{ss.done?"✓":""}</button>
                                  <span className={`flex-1 text-xs ${ss.done?"line-through text-slate-400":"text-slate-600"}`}>{ss.title}</span>
                                  {ss.dueDate&&<span className="text-[9px] text-slate-400 hidden group-hover/ss:inline">{fmt(ss.dueDate+"T00:00:00")}</span>}
                                  <button onClick={()=>setSubSubDetail(p=>({...p,[ss.id]:!p[ss.id]}))} className={`text-[9px] px-1 py-0.5 rounded transition-colors ${ssExp?"bg-violet-100 text-violet-600":"text-slate-300 hover:text-violet-500"}`}>{ssExp?"▲":"▼"}</button>
                                  <button onClick={()=>deleteSubSubtask(task.id,sub.id,ss.id)} className="opacity-0 group-hover/ss:opacity-100 text-[10px] text-slate-300 hover:text-red-500 transition-opacity px-1">✕</button>
                                </div>
                                {ssExp&&(
                                  <div className="ml-5 mb-1 p-2 bg-white border border-violet-100 rounded-lg space-y-2">
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Date Added</label>
                                        <input type="date" value={ss.dateAdded?ss.dateAdded.split("T")[0]:""} onChange={e=>updateSubSubtaskField(task.id,sub.id,ss.id,"dateAdded",e.target.value?new Date(e.target.value).toISOString():"")} className="w-full text-[10px] px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                      </div>
                                      <div>
                                        <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Due Date</label>
                                        <input type="date" value={ss.dueDate||""} onChange={e=>updateSubSubtaskField(task.id,sub.id,ss.id,"dueDate",e.target.value)} className="w-full text-[10px] px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                      </div>
                                    </div>
                                    <div>
                                        <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider block mb-1">Duration</label>
                                        <input type="text" value={ss.duration||""} onChange={e=>updateSubSubtaskField(task.id,sub.id,ss.id,"duration",e.target.value)} placeholder="e.g. 2 hours" className="w-full text-[10px] px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                                      </div>
                                  </div>
                                )}
                              </div>
                              );
                            })}
                            {/* Add sub-subtask */}
                            <div className="flex items-center gap-1 mt-0.5">
                              <input value={newSubSubInput[sub.id]||""} onChange={e=>setNewSubSubInput(p=>({...p,[sub.id]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&addSubSubtask(task.id,sub.id,newSubSubInput[sub.id]||"")} placeholder="+ sub-subtask…" className="flex-1 text-xs px-2 py-1 border border-slate-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-violet-300 bg-white"/>
                              <button onClick={()=>addSubSubtask(task.id,sub.id,newSubSubInput[sub.id]||"")} disabled={!(newSubSubInput[sub.id]||"").trim()} className="text-xs px-2 py-1 bg-violet-100 hover:bg-violet-200 text-violet-700 rounded-lg disabled:opacity-40">Add</button>
                            </div>
                          </div>
                        </div>
                        );
                      })}
                    </div>
                    <div className="flex items-center gap-2">
                      <input value={newSubInput[task.id]||""} onChange={e=>setNewSubInput(p=>({...p,[task.id]:e.target.value}))} onKeyDown={e=>e.key==="Enter"&&addSubtask(task.id,newSubInput[task.id]||"")} placeholder="Add subtask…" className="flex-1 text-sm px-3 py-1.5 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-violet-200 bg-white"/>
                      <button onClick={()=>addSubtask(task.id,newSubInput[task.id]||"")} disabled={!(newSubInput[task.id]||"").trim()} className="text-xs px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-xl disabled:opacity-40">Add</button>
                    </div>
                  </div>
                  <div><p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Progress · {task.progress}%</p>
                  <input type="range" min="0" max="100" step="5" value={task.progress} onChange={e=>setProg(task.id,+e.target.value)} className="w-full accent-violet-600"/></div>
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

      {/* ── REMINDERS ── */}
      {tab==="reminders"&&<div className="space-y-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-lg font-bold text-slate-800">🔔 Reminders</h2>
          <span className="text-xs text-slate-400">Independent of Claude desktop app</span>
        </div>

        {/* Push status card */}
        <div className="bg-white rounded-2xl border border-slate-200 p-5">
          <div className="flex items-center gap-4">
            <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-2xl ${pushSub?"bg-violet-100":"bg-slate-100"}`}>🔔</div>
            <div className="flex-1">
              <p className="font-semibold text-slate-800">{pushSub?"Push Notifications Active":"Push Notifications Off"}</p>
              <p className="text-xs text-slate-400 mt-0.5">{pushSub?"Reminders work even when the app is closed":"Enable to receive reminders on this device"}</p>
            </div>
            {pushSub
              ? <button onClick={unsubscribePush} disabled={pushLoading} className="text-sm px-4 py-2 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl font-medium">
                  {pushLoading?"…":"Disable"}
                </button>
              : <button onClick={subscribePush} disabled={pushLoading} className="text-sm px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-semibold">
                  {pushLoading?"…":"Enable"}
                </button>
            }
          </div>
        </div>

        {!pushSub&&<div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">
          <p className="font-semibold mb-1">📱 How push notifications work</p>
          <p className="text-xs leading-relaxed">After enabling, a Vercel cron job runs every hour and sends reminders to your device — no need to have this app open. Requires Vercel environment variables to be set (see deployment guide).</p>
        </div>}

        {pushSub&&<>
          {/* Daily reminder config */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Daily Summary</p>
            <div className="flex items-center gap-3 mb-4">
              <label className="text-sm text-slate-700 flex-1">Send daily summary at:</label>
              <input type="time" value={cfgForm.time||"08:00"} onChange={e=>setCfgForm({...cfgForm,time:e.target.value})}
                className="px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/>
            </div>
            <div>
              <p className="text-sm text-slate-700 mb-2">Send on:</p>
              <div className="flex gap-1.5 flex-wrap">
                {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(day=>{
                  const active=(cfgForm.days||["Mon","Tue","Wed","Thu","Fri"]).includes(day);
                  return<button key={day} onClick={()=>toggleDay(day)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${active?"bg-violet-600 text-white border-violet-600":"border-slate-200 text-slate-500 hover:border-violet-300"}`}>{day}</button>;
                })}
              </div>
            </div>
            <button onClick={saveRemCfg} className="mt-4 w-full bg-violet-600 hover:bg-violet-700 text-white text-sm font-semibold py-2.5 rounded-xl">
              Save Schedule
            </button>
          </div>

          {/* Per-task reminders */}
          <div className="bg-white rounded-2xl border border-slate-200 p-5">
            <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Task-Specific Reminders</p>
            <p className="text-xs text-slate-400 mb-4">Set an exact time to get pinged for a specific task (daily until done)</p>
            {tasks.filter(t=>t.status!=="done").length===0
              ? <p className="text-sm text-slate-400 text-center py-4">🎉 No active tasks!</p>
              : <div className="space-y-2">
                  {tasks.filter(t=>t.status!=="done")
                    .sort((a,b)=>({urgent:0,high:1,medium:2,low:3})[a.priority]-({urgent:0,high:1,medium:2,low:3})[b.priority])
                    .map(task=>(
                    <div key={task.id} className="flex items-center gap-3 p-3 rounded-xl border border-slate-100 hover:bg-slate-50 transition-colors">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${pc(task.priority).dot}`}/>
                      <span className="text-sm text-slate-700 flex-1 truncate">{task.title}</span>
                      <input type="time" value={task.remindAt||""} onChange={e=>updateTaskReminder(task.id,e.target.value)}
                        className="px-2 py-1.5 border border-slate-200 rounded-lg text-xs text-slate-600 focus:outline-none focus:ring-1 focus:ring-violet-300"/>
                      {task.remindAt&&<span className="text-violet-500 text-sm">🔔</span>}
                    </div>
                  ))}
                </div>
            }
          </div>
        </>}
      </div>}

      {/* ── CALENDAR ── */}
      {tab==="calendar"&&<>
        <div className="mb-4">
          <h2 className="text-lg font-bold text-slate-800 mb-1">📅 Google Calendar</h2>
          <p className="text-slate-400 text-sm">Two-way sync: push tasks to Calendar, pull events into the app.</p>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-5 mb-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-700">{gcalToken?"✅ Connected":"Connect Google Calendar"}</p>
              <p className="text-xs text-slate-400 mt-0.5">{gcalLastSync?`Last synced: ${new Date(gcalLastSync).toLocaleString()}`:"Not synced yet"}</p>
            </div>
            {gcalToken
              ? <div className="flex gap-2 flex-shrink-0">
                  <button onClick={syncWithGoogleCalendar} disabled={gcalSyncing}
                    className="text-sm px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-xl font-semibold disabled:opacity-50 transition-colors">
                    {gcalSyncing?"⏳ Syncing…":"🔄 Sync Now"}
                  </button>
                  <button onClick={()=>{setGcalToken(null);setGcalEvents([]);setGcalLastSync(null);}}
                    className="text-sm px-3 py-2 border border-slate-200 text-slate-500 hover:bg-slate-50 rounded-xl transition-colors">
                    Disconnect
                  </button>
                </div>
              : <button onClick={connectGoogleCalendar}
                  className="text-sm px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl font-semibold flex-shrink-0 transition-colors">
                  Connect
                </button>
            }
          </div>
          {gcalError&&<p className="text-xs text-red-600 mt-3 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{gcalError}</p>}
        </div>
        {!gcalToken&&<div className="bg-slate-50 rounded-2xl border border-slate-200 p-5 mb-4">
          <p className="text-sm font-semibold text-slate-700 mb-3">How sync works</p>
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <span className="text-base mt-0.5">➡️</span>
              <div><p className="text-sm font-medium text-slate-700">Tasks → Calendar</p><p className="text-xs text-slate-400 mt-0.5">Tasks with due dates become all-day events, color-coded by priority. Already-synced tasks update, not duplicate.</p></div>
            </div>
            <div className="flex items-start gap-3">
              <span className="text-base mt-0.5">⬅️</span>
              <div><p className="text-sm font-medium text-slate-700">Calendar → App</p><p className="text-xs text-slate-400 mt-0.5">Your upcoming events (next 30 days) appear below alongside your tasks.</p></div>
            </div>
          </div>
        </div>}
        {gcalToken&&gcalEvents.length>0&&<>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Upcoming Events (next 30 days)</p>
          <div className="space-y-2">
            {gcalEvents.map(ev=>{
              const isTask = ev.summary?.startsWith("[Task]");
              const dateStr = ev.start?.date || (ev.start?.dateTime||"").split("T")[0];
              const title = isTask ? ev.summary.replace("[Task] ","") : ev.summary;
              return(
                <div key={ev.id} className={`bg-white rounded-xl border p-3 flex items-start gap-3 ${isTask?"border-violet-200":"border-slate-200"}`}>
                  <span className="text-lg flex-shrink-0">{isTask?"✅":"📅"}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800 truncate">{title}</p>
                    <p className="text-xs text-slate-400">{dateStr}</p>
                  </div>
                  {isTask&&<span className="text-xs text-violet-600 bg-violet-100 px-2 py-0.5 rounded-full flex-shrink-0">synced task</span>}
                </div>
              );
            })}
          </div>
        </>}
        {gcalToken&&gcalEvents.length===0&&gcalLastSync&&(
          <div className="text-center py-12 text-slate-400"><p className="text-4xl mb-2">📭</p><p className="text-sm">No upcoming events in the next 30 days</p></div>
        )}
        {gcalToken&&!gcalLastSync&&(
          <div className="text-center py-12 text-slate-400"><p className="text-4xl mb-2">🔄</p><p className="text-sm">Press "Sync Now" to push your tasks and load calendar events</p></div>
        )}
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
            {user.photoURL
              ? <img src={user.photoURL} alt="" className="w-10 h-10 rounded-full" referrerPolicy="no-referrer"/>
              : <div className="w-10 h-10 rounded-full bg-violet-100 flex items-center justify-center text-lg font-bold text-violet-600">{(user.displayName||user.email||"?")[0].toUpperCase()}</div>
            }
            <div><p className="text-sm font-semibold text-slate-800">{user.displayName}</p><p className="text-xs text-slate-400">{user.email}</p></div>
          </div>
          {/* Notifications */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Reminders & Notifications</label>
            <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl mb-2">
              <span className="text-xl">🔔</span>
              <div className="flex-1">
                <p className="text-sm font-medium text-slate-700">
                  {notifPerm==="granted"?"Notifications enabled":"Notifications off"}
                </p>
                <p className="text-xs text-slate-400">
                  {notifPerm==="granted"?"You'll get alerts at your reminder time and for overdue tasks":"Enable to get task reminders"}
                </p>
              </div>
              {notifPerm!=="granted"
                ? <button onClick={requestNotifPermission} className="text-xs font-semibold px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg">Enable</button>
                : <button onClick={()=>fireNotif("🔔 Test","Reminders are working!","test")} className="text-xs font-semibold px-3 py-1.5 border border-slate-200 text-slate-600 hover:bg-slate-100 rounded-lg">Test</button>
              }
            </div>
            <div className="flex items-center gap-3">
              <label className="text-xs text-slate-500 flex-1">Daily reminder time</label>
              <input type="time" value={cfgForm.time||"08:00"} onChange={e=>setCfgForm({...cfgForm,time:e.target.value})}
                className="px-3 py-1.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              <button onClick={async()=>{const c={...cfg,...cfgForm};setCfg(c);await saveConfig(c);showT("⏰ Reminder time saved!");setShowCfg(false);}}
                className="text-xs font-semibold px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg">Save</button>
            </div>
          </div>

          {/* Task Categories */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">🏷️ Task Categories</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {taskCats.map(cat=>(
                <span key={cat} className="flex items-center gap-1 px-2.5 py-1 bg-slate-100 rounded-lg text-xs text-slate-700 font-medium">
                  {cat}
                  {taskCats.length>1&&<button onClick={()=>deleteCat(cat)} className="text-slate-400 hover:text-red-500 transition-colors ml-0.5">×</button>}
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input value={newCatInput} onChange={e=>setNewCatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCat()} placeholder="New category name…" className="flex-1 px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              <button onClick={addCat} disabled={!newCatInput.trim()||taskCats.includes(newCatInput.trim())} className="text-xs font-semibold px-3 py-2 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-xl">Add</button>
            </div>
          </div>

          {/* Gemini key */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">✦ Gemini API Key</label>
            <div className="flex gap-2">
              <input type={showKey?"text":"password"} value={keyInput||(runtimeGeminiKey||GEMINI_KEY_ENV)} onChange={e=>setKeyInput(e.target.value)} placeholder="AQ.… or AIza…" className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              <button onClick={()=>setShowKey(s=>!s)} className="px-3 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-500 hover:bg-slate-50">{showKey?"Hide":"Show"}</button>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-xs text-slate-400">Free at <a href="https://aistudio.google.com" target="_blank" rel="noreferrer" className="text-violet-600 underline">aistudio.google.com</a></p>
              <button onClick={()=>{if(keyInput.trim()){runtimeGeminiKey=keyInput.trim();localStorage.setItem("gemini_key",keyInput.trim());showT("🔑 Gemini key saved!");setShowCfg(false);}}} disabled={!keyInput.trim()} className="text-xs font-semibold px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-lg">Save Key</button>
            </div>
          </div>

          {/* Claude key */}
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">◆ Claude API Key</label>
            <div className="flex gap-2">
              <input type={showClaudeKey?"text":"password"} value={claudeKeyInput} onChange={e=>setClaudeKeyInput(e.target.value)} placeholder="sk-ant-…" className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-sm font-mono focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              <button onClick={()=>setShowClaudeKey(s=>!s)} className="px-3 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-500 hover:bg-slate-50">{showClaudeKey?"Hide":"Show"}</button>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <p className="text-xs text-slate-400">Get yours at <a href="https://console.anthropic.com" target="_blank" rel="noreferrer" className="text-violet-600 underline">console.anthropic.com</a></p>
              <button onClick={()=>{if(claudeKeyInput.trim()){runtimeClaudeKey=claudeKeyInput.trim();localStorage.setItem("claude_key",claudeKeyInput.trim());showT("🔑 Claude key saved!");setShowCfg(false);}}} disabled={!claudeKeyInput.trim()} className="text-xs font-semibold px-3 py-1.5 bg-violet-600 hover:bg-violet-700 disabled:opacity-40 text-white rounded-lg">Save Key</button>
            </div>
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
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Category</label><select value={tForm.category} onChange={e=>setTForm({...tForm,category:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200">{taskCats.map(c=><option key={c} value={c}>{c}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Status</label><select value={tForm.status} onChange={e=>setTForm({...tForm,status:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-violet-200"><option value="todo">To Do</option><option value="inprogress">In Progress</option><option value="done">Done</option></select></div>
            <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Due Date</label><input type="date" value={tForm.dueDate} onChange={e=>setTForm({...tForm,dueDate:e.target.value})} className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/></div>
          </div>
          <div><label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-1.5">Daily Reminder Time <span className="text-slate-300 font-normal normal-case">(optional)</span></label>
            <div className="flex items-center gap-2">
              <input type="time" value={tForm.remindAt||""} onChange={e=>setTForm({...tForm,remindAt:e.target.value})} className="flex-1 px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-violet-200"/>
              {tForm.remindAt&&<button onClick={()=>setTForm({...tForm,remindAt:""})} className="text-xs text-slate-400 hover:text-slate-600 px-2">Clear</button>}
            </div>
            <p className="text-xs text-slate-400 mt-1">Push notification sent daily at this time until task is done</p>
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
