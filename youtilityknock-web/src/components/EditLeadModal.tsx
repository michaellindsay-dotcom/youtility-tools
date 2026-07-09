import { useState } from "react";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
import type { Lead } from "../types";

// Quick edit of a lead's core contact details — name, address, phone, email.
// Used from the Leads list and the customer screen so a rep can fix a
// mistyped name or address, or add a phone/email, without re-dispositioning.
export default function EditLeadModal({ lead, onClose }: { lead: Lead; onClose: () => void }) {
  const [ownerName, setOwnerName] = useState(lead.ownerName || "");
  const [address, setAddress] = useState(lead.address || "");
  const [phone, setPhone] = useState(lead.phone || "");
  const [email, setEmail] = useState(lead.email || "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const emailOk = !email.trim() || /.+@.+\..+/.test(email.trim());

  async function save() {
    setErr("");
    if (!address.trim()) { setErr("Address can't be empty."); return; }
    if (!emailOk) { setErr("That email doesn't look right — fix it or clear it."); return; }
    setBusy(true);
    try {
      await updateDoc(doc(db, "leads", lead.id), {
        ownerName: ownerName.trim() || null,
        address: address.trim(),
        phone: phone.trim() || null,
        email: email.trim() || null,
        updatedAt: Date.now(),
      });
      onClose();
    } catch (e) {
      setErr((e as Error)?.message || "Couldn't save the changes.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>Edit details</h3>
            <div className="muted small">{lead.address}</div>
          </div>
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={ownerName} placeholder="Full name" onChange={(e) => setOwnerName(e.target.value)} />
        </label>
        <label className="field">
          <span>Address</span>
          <input value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Phone</span>
            <input value={phone} placeholder="(555) 000-0000" onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="field">
            <span>Email</span>
            <input value={email} placeholder="email@example.com" onChange={(e) => setEmail(e.target.value)} />
          </label>
        </div>
        {err && <div className="banner warn show" style={{ marginBottom: 10 }}>{err}</div>}
        <div className="dispo-foot">
          <span />
          <div className="row">
            <button className="btn ghost sm" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn primary sm" onClick={save} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
