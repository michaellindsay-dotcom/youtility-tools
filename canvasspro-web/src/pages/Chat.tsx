import { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  where,
} from "firebase/firestore";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { ChatMessage, UserProfile } from "../types";

// Deterministic DM channel id for a pair of uids (order-independent).
function dmId(a: string, b: string): string {
  return [a, b].sort().join("__");
}

type Conversation = { kind: "channel" } | { kind: "dm"; other: UserProfile };

export default function Chat() {
  const { profile, role, companyId } = useAuth();
  const [conv, setConv] = useState<Conversation>({ kind: "channel" });
  const [teammates, setTeammates] = useState<UserProfile[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

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
    () => (conv.kind === "channel" ? "Team Chat" : conv.other.displayName),
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
      if (conv.kind === "channel") {
        await addDoc(collection(db, "chat"), { companyId, ...base });
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

  return (
    <div className="page-body chat-page">
      <div className="chat-layout">
        <aside className="chat-rail">
          <button
            className={"chat-conv" + (conv.kind === "channel" ? " active" : "")}
            onClick={() => setConv({ kind: "channel" })}
          >
            <span className="chat-conv-ico">#</span>
            <div>
              <div className="chat-conv-name">Team Chat</div>
              <div className="muted small">Everyone in your company</div>
            </div>
          </button>
          <div className="chat-rail-label muted small">Direct messages</div>
          {teammates.length === 0 && <div className="muted small" style={{ padding: "8px 12px" }}>No teammates yet.</div>}
          {teammates.map((u) => (
            <button
              key={u.uid}
              className={"chat-conv" + (conv.kind === "dm" && conv.other.uid === u.uid ? " active" : "")}
              onClick={() => setConv({ kind: "dm", other: u })}
            >
              <span className="avatar sm">{(u.displayName || "?").slice(0, 1).toUpperCase()}</span>
              <div>
                <div className="chat-conv-name">{u.displayName}</div>
                <div className="muted small">{u.title || u.role}</div>
              </div>
            </button>
          ))}
        </aside>

        <section className="chat-main">
          <div className="chat-head">
            <h2>{title}</h2>
          </div>
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
                      <div className="chat-time">{ts(m)}</div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={endRef} />
          </div>
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
        </section>
      </div>
    </div>
  );
}
