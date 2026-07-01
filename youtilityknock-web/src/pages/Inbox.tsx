import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import type { SmsMessage } from "../types";

interface Conversation {
  key: string; // leadId or phone
  phone: string;
  leadId: string | null;
  leadName: string;
  messages: SmsMessage[];
}

export default function Inbox() {
  const { profile } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    if (!profile) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const snap = await getDocs(
          query(collection(db, "smsMessages"), where("repUid", "==", profile.uid), orderBy("at", "desc"))
        );
        const msgs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<SmsMessage, "id">) }));
        const byKey = new Map<string, Conversation>();
        for (const m of msgs) {
          const key = m.leadId || m.phone;
          if (!byKey.has(key)) byKey.set(key, { key, phone: m.phone, leadId: m.leadId || null, leadName: "", messages: [] });
          byKey.get(key)!.messages.push(m);
        }
        const convos = [...byKey.values()];
        // Best-effort: resolve a display name for conversations tied to a lead.
        await Promise.all(
          convos.map(async (c) => {
            if (!c.leadId) return;
            try {
              const leadSnap = await getDoc(doc(db, "leads", c.leadId));
              if (leadSnap.exists()) c.leadName = (leadSnap.data() as { ownerName?: string }).ownerName || "";
            } catch { /* keep blank */ }
          })
        );
        convos.forEach((c) => c.messages.sort((a, b) => a.at - b.at));
        convos.sort((a, b) => (b.messages.at(-1)?.at ?? 0) - (a.messages.at(-1)?.at ?? 0));
        if (!cancelled) {
          setConversations(convos);
          setSelectedKey((cur) => cur ?? convos[0]?.key ?? null);
        }
      } catch (e) {
        console.error(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [profile]);

  const selected = useMemo(() => conversations.find((c) => c.key === selectedKey) || null, [conversations, selectedKey]);

  async function send() {
    if (!selected?.leadId || !reply.trim()) return;
    setSending(true);
    setErr("");
    try {
      await httpsCallable(functions, "sendLeadSms")({ leadId: selected.leadId, body: reply.trim() });
      setConversations((cs) =>
        cs.map((c) =>
          c.key === selected.key
            ? { ...c, messages: [...c.messages, { id: `tmp-${Date.now()}`, companyId: "", repUid: profile!.uid, leadId: c.leadId ?? undefined, phone: c.phone, direction: "out", body: reply.trim(), at: Date.now() }] }
            : c
        )
      );
      setReply("");
    } catch (e) {
      setErr((e as Error).message || "Couldn't send that text.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Texts</h1>
        <p className="page-sub">Conversations with your leads, sent from your own texting number.</p>
      </div>

      {!profile?.smsNumber && (
        <div className="card">
          <p className="muted small">
            You don't have a texting number assigned yet — ask an admin to set one up under Accounts.
            You can still see any replies here once a number is assigned.
          </p>
        </div>
      )}

      {loading ? (
        <div className="muted">Loading…</div>
      ) : conversations.length === 0 ? (
        <div className="empty">No text conversations yet.</div>
      ) : (
        <div className="inbox-layout">
          <div className="inbox-list">
            {conversations.map((c) => {
              const last = c.messages.at(-1);
              return (
                <button
                  key={c.key}
                  className={"inbox-row" + (c.key === selectedKey ? " active" : "")}
                  onClick={() => setSelectedKey(c.key)}
                >
                  <div className="inbox-row-name">{c.leadName || c.phone}</div>
                  <div className="muted small inbox-row-preview">{last?.body}</div>
                </button>
              );
            })}
          </div>
          <div className="inbox-thread">
            {selected ? (
              <>
                <div className="inbox-thread-head">{selected.leadName || selected.phone}</div>
                <div className="inbox-thread-msgs">
                  {selected.messages.map((m) => (
                    <div key={m.id} className={"inbox-bubble " + (m.direction === "out" ? "out" : "in")}>
                      {m.body}
                    </div>
                  ))}
                </div>
                {selected.leadId ? (
                  <div className="inbox-reply">
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder="Type a reply…"
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && send()}
                    />
                    <button className="btn primary sm" onClick={send} disabled={sending || !reply.trim()}>
                      {sending ? "Sending…" : "Send"}
                    </button>
                  </div>
                ) : (
                  <p className="muted small">No matching lead — can't reply from here.</p>
                )}
                {err && <p className="muted small">{err}</p>}
              </>
            ) : (
              <div className="muted">Select a conversation.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
