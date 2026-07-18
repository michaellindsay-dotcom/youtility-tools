import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { useNavigate } from "react-router-dom";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import WhosWorkingPanel from "../components/WhosWorkingPanel";
import type { ChatMessage, UserProfile } from "../types";

// Deterministic DM channel id for a pair of uids (order-independent).
function dmId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

type Conversation =
  | { kind: "channel" }
  | { kind: "team"; teamId: string; teamName: string }
  | { kind: "working" }
  | { kind: "dm"; other: UserProfile };

export default function Chat() {
  const { profile, role, companyId } = useAuth();
  const navigate = useNavigate();
  const [conv, setConv] = useState<Conversation>({ kind: "channel" });
  const [teammates, setTeammates] = useState<UserProfile[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [teamNames, setTeamNames] = useState<Record<string, string>>({});
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  // Company-wide channel is for company-wide updates only — managers/admins post
  // there; everyone can read. Team-specific chatter lives in Team Chat.
  const pos = profile?.position || "";
  const isManager =
    role === "admin" || role === "manager" || role === "superadmin" || pos.includes("manager") || pos === "admin";

  // Every team this user belongs to or manages, so a regional manager gets one
  // channel per team (their team chats land in the right team, not company chat).
  const myTeamIds = useMemo(() => {
    const ids: string[] = [];
    if (profile?.teamId) ids.push(profile.teamId);
    (profile?.managedTeamIds || []).forEach((id) => { if (id && !ids.includes(id)) ids.push(id); });
    return ids;
  }, [profile?.teamId, profile?.managedTeamIds]);

  // Resolve each team's display name for its channel label.
  useEffect(() => {
    if (!companyId || myTeamIds.length === 0) { setTeamNames({}); return; }
    let live = true;
    Promise.all(
      myTeamIds.map((id) =>
        getDoc(doc(db, "companies", companyId, "teams", id))
          .then((s) => [id, (s.data()?.name as string) || "Team"] as const)
          .catch(() => [id, "Team"] as const)
      )
    ).then((pairs) => { if (live) setTeamNames(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [companyId, myTeamIds]);

  const teamChannels = useMemo(
    () => myTeamIds.map((id) => ({ id, name: teamNames[id] || "Team" })),
    [myTeamIds, teamNames]
  );

  // Load teammates for the DM list (same scope as the Team page).
  useEffect(() => {
    if (!profile || !companyId) return;
    let cancelled = false;
    (async () => {
      const base = collection(db, "users");
      const q =
        role === "admin"
          ? query(base, where("companyId", "==", companyId))
          : query(base, where("companyId", "==", companyId), where("managerPath", "array-contains", profile.uid));
      const snap = await getDocs(q);
      let list = snap.docs.map((d) => ({ uid: d.id, ...(d.data() as Omit<UserProfile, "uid">) }));
      list = list.filter((u) => u.uid !== profile.uid);
      if (!cancelled) setTeammates(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [profile, role, companyId]);

  // Subscribe to the active conversation's messages.
  useEffect(() => {
    if (!profile || !companyId) return;
    // The "Who's Working" view has no message stream of its own.
    if (conv.kind === "working") {
      setMessages([]);
      return;
    }
    if (conv.kind === "channel") {
      const q = query(
        collection(db, "chat"),
        where("companyId", "==", companyId),
        orderBy("createdAt", "asc"),
        limit(200)
      );
      return onSnapshot(q, (snap) =>
        setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, "id">) })))
      );
    }
    if (conv.kind === "team") {
      const q = query(
        collection(db, "teamChat"),
        where("companyId", "==", companyId),
        where("teamId", "==", conv.teamId),
        orderBy("createdAt", "asc"),
        limit(200)
      );
      return onSnapshot(q, (snap) =>
        setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, "id">) })))
      );
    }
    const cid = dmId(profile.uid, conv.other.uid);
    const q = query(collection(db, "dms", cid, "messages"), orderBy("createdAt", "asc"), limit(200));
    return onSnapshot(q, (snap) =>
      setMessages(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<ChatMessage, "id">) })))
    );
  }, [conv, profile, companyId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const title = useMemo(
    () =>
      conv.kind === "channel"
        ? "Company Chat"
        : conv.kind === "team"
        ? conv.teamName + " Chat"
        : conv.kind === "working"
        ? "Who's Working"
        : conv.other.displayName,
    [conv]
  );

  async function send(imageUrl?: string) {
    if (!profile || !companyId) return;
    const body = text.trim();
    if (!body && !imageUrl) return;
    setSending(true);
    try {
      const base = {
        userId: profile.uid,
        userName: profile.displayName,
        text: body || "",
        ...(imageUrl ? { imageUrl } : {}),
        createdAt: Date.now(),
      };
      if (conv.kind === "working") {
        return; // no message stream — the compose bar isn't shown here anyway
      } else if (conv.kind === "channel") {
        if (!isManager) return; // company channel is announcements-only for reps
        await addDoc(collection(db, "chat"), { companyId, ...base });
      } else if (conv.kind === "team") {
        await addDoc(collection(db, "teamChat"), { companyId, teamId: conv.teamId, ...base });
      } else {
        const cid = dmId(profile.uid, conv.other.uid);
        // Ensure the channel doc exists (members + last-message preview).
        await setDoc(
          doc(db, "dms", cid),
          {
            members: [profile.uid, conv.other.uid],
            memberNames: { [profile.uid]: profile.displayName, [conv.other.uid]: conv.other.displayName },
            companyId,
            lastMessage: body || "📷 Photo",
            lastAt: Date.now(),
          },
          { merge: true }
        );
        await addDoc(collection(db, "dms", cid, "messages"), { channelId: cid, ...base });
      }
      setText("");
    } finally {
      setSending(false);
    }
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !companyId) return;
    setSending(true);
    try {
      const path = `chat/${companyId}/${Date.now()}_${file.name.replace(/[^\w.-]/g, "_")}`;
      const r = storageRef(storage, path);
      await uploadBytes(r, file);
      const url = await getDownloadURL(r);
      await send(url);
    } catch (err) {
      console.error("Image upload failed", err);
      alert("Image upload failed. Make sure Firebase Storage is enabled.");
    } finally {
      setSending(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const ts = (m: ChatMessage) =>
    m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";

  // Pick a conversation and roll the dropdown back up.
  const choose = (c: Conversation) => { setConv(c); setPickerOpen(false); };

  return (
    <div className="page-body chat-page chat-full">
      <div className="chat-topbar">
        <button className="chat-back" onClick={() => navigate(-1)} aria-label="Close chat" title="Close">✕</button>
        <button className="chat-picker-toggle" onClick={() => setPickerOpen((o) => !o)} aria-expanded={pickerOpen}>
          <span className="chat-topbar-title">{title}</span>
          <span className={"chat-caret" + (pickerOpen ? " open" : "")}>▾</span>
        </button>
      </div>

      {/* Collapsible conversation picker — Company / Team / Individual. */}
      <div className={"chat-picker" + (pickerOpen ? " open" : "")}>
        <div className="chat-picker-inner">
          <div className="chat-rail-label muted small">Company</div>
          <button className={"chat-conv" + (conv.kind === "channel" ? " active" : "")} onClick={() => choose({ kind: "channel" })}>
            <span className="chat-conv-ico">#</span>
            <div><div className="chat-conv-name">Company Chat</div><div className="muted small">Company-wide updates{isManager ? "" : " · read only"}</div></div>
          </button>
          <button className={"chat-conv" + (conv.kind === "working" ? " active" : "")} onClick={() => choose({ kind: "working" })}>
            <span className="chat-conv-ico">🔥</span>
            <div><div className="chat-conv-name">Who's Working</div><div className="muted small">Live shifts &amp; shout-outs</div></div>
          </button>

          {teamChannels.length > 0 && (
            <>
              <div className="chat-rail-label muted small">{teamChannels.length > 1 ? "Teams" : "Team"}</div>
              {teamChannels.map((t) => (
                <button
                  key={t.id}
                  className={"chat-conv" + (conv.kind === "team" && conv.teamId === t.id ? " active" : "")}
                  onClick={() => choose({ kind: "team", teamId: t.id, teamName: t.name })}
                >
                  <span className="chat-conv-ico">👥</span>
                  <div><div className="chat-conv-name">{t.name} Chat</div><div className="muted small">{profile?.teamId === t.id ? "Your team" : "Team you manage"}</div></div>
                </button>
              ))}
            </>
          )}

          <div className="chat-rail-label muted small">Individual</div>
          {teammates.length === 0 && <div className="muted small" style={{ padding: "8px 12px" }}>No teammates yet.</div>}
          {teammates.map((u) => (
            <button
              key={u.uid}
              className={"chat-conv" + (conv.kind === "dm" && conv.other.uid === u.uid ? " active" : "")}
              onClick={() => choose({ kind: "dm", other: u })}
            >
              <span className="avatar sm">{(u.displayName || "?").slice(0, 1).toUpperCase()}</span>
              <div><div className="chat-conv-name">{u.displayName}</div><div className="muted small">{u.title || u.role}</div></div>
            </button>
          ))}
        </div>
      </div>

      <section className="chat-main">
        {conv.kind === "working" ? (
          <div className="chat-working">
            <WhosWorkingPanel />
          </div>
        ) : (
          <>
          <div className="chat-stream">
            {messages.length === 0 ? (
              <div className="empty">No messages yet. Say hello 👋</div>
            ) : (
              messages.map((m) => {
                const mine = m.userId === profile?.uid;
                return (
                  <div key={m.id} className={"chat-msg" + (mine ? " mine" : "")}>
                    {!mine && <div className="chat-msg-author">{m.userName}</div>}
                    <div className="chat-bubble">
                      {m.imageUrl && (
                        <a href={m.imageUrl} target="_blank" rel="noreferrer">
                          <img className="chat-img" src={m.imageUrl} alt="attachment" />
                        </a>
                      )}
                      {m.text && <div className="chat-text">{m.text}</div>}
                      {(m.apptEventId || m.leadId) && (
                        <button
                          type="button"
                          className="chat-appt-tag"
                          onClick={() => navigate(m.leadId ? `/lead/${m.leadId}` : "/schedule")}
                          title="Open this appointment"
                          style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 6, padding: "4px 8px", borderRadius: 8, border: "1px solid rgba(56,189,248,.5)", background: "rgba(56,189,248,.12)", color: "#bae6fd", fontSize: 12, cursor: "pointer" }}
                        >
                          📅 {m.apptTitle || "Appointment"}{m.apptAt ? ` · ${new Date(m.apptAt).toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""} →
                        </button>
                      )}
                      <div className="chat-time">{ts(m)}</div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>
          {conv.kind === "channel" && !isManager ? (
            <div className="chat-compose" style={{ justifyContent: "center" }}>
              <span className="muted small" style={{ textAlign: "center" }}>
                📢 Company Chat is for company-wide updates. Post to your <strong>Team Chat</strong> to reach your crew.
              </span>
            </div>
          ) : (
          <form
            className="chat-compose"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickImage}
            />
            <button
              type="button"
              className="btn ghost"
              title="Attach photo"
              onClick={() => fileRef.current?.click()}
              disabled={sending}
            >
              📎
            </button>
            <input
              className="input"
              placeholder={`Message ${title}…`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              disabled={sending}
            />
            <button className="btn primary" type="submit" disabled={sending || (!text.trim())}>
              Send
            </button>
          </form>
          )}
          </>
          )}
        </section>
    </div>
  );
}
