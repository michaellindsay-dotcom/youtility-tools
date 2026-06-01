import { useEffect, useState } from "react";
import { addDoc, collection, doc, updateDoc } from "firebase/firestore";
import { db, auth } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import { DISPOSITIONS } from "../lib/dispositions";
import { lookupAddress, normalizeKnockstatResponse, buildEnrichment } from "../lib/knockstat";
import { bumpStats } from "../lib/stats";
import type { LeadStatus, LeadEnrichment } from "../types";

export interface DispoInput {
  leadId?: string;
  address: string;
  lat?: number;
  lng?: number;
  status?: LeadStatus;
  name?: string;
  phone?: string;
  email?: string;
  notes?: string;
  enrichment?: LeadEnrichment;
}

interface Form {
  leadId?: string;
  address: string;
  lat?: number;
  lng?: number;
  status: LeadStatus;
  name: string;
  phone: string;
  email: string;
  notes: string;
  enrichment?: LeadEnrichment;
}

function summarize(e?: LeadEnrichment): string {
  if (!e) return "";
  return [
    e.propertyType,
    e.beds != null ? `${e.beds}bd` : null,
    e.baths != null ? `${e.baths}ba` : null,
    e.sqft != null ? `${Number(e.sqft).toLocaleString()} sqft` : null,
    e.yearBuilt ? `built ${e.yearBuilt}` : null,
    e.estValue ? `$${Number(e.estValue).toLocaleString()}` : null,
    e.lastSaleDate ? `sold ${e.lastSaleDate}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export default function DispositionModal({
  target,
  autoEnrich = true,
  onClose,
  onSaved,
}: {
  target: DispoInput | null;
  autoEnrich?: boolean;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { profile, companyId } = useAuth();
  const [d, setD] = useState<Form | null>(null);
  const [enriching, setEnriching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    if (!target) {
      setD(null);
      return;
    }
    setD({
      status: "new",
      name: "",
      phone: "",
      email: "",
      notes: "",
      ...target,
    });
    setSummary(summarize(target.enrichment));
    if (autoEnrich && !target.enrichment) void enrich(target.address);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  async function enrich(address: string) {
    setEnriching(true);
    try {
      const token = await auth.currentUser!.getIdToken();
      const rec = normalizeKnockstatResponse(await lookupAddress(address, token));
      const { ownerName, phone, email, enrichment } = buildEnrichment(rec);
      setSummary(summarize(enrichment));
      setD((cur) =>
        cur && cur.address === address
          ? {
              ...cur,
              name: cur.name || ownerName || "",
              phone: cur.phone || phone || "",
              email: cur.email || email || "",
              enrichment,
            }
          : cur
      );
    } catch {
      /* leave fields blank */
    } finally {
      setEnriching(false);
    }
  }

  async function save() {
    if (!profile || !companyId || !d) return;
    setSaving(true);
    try {
      const now = Date.now();
      const fields = {
        ownerName: d.name || null,
        phone: d.phone || null,
        email: d.email || null,
        notes: d.notes || null,
        status: d.status,
        enrichment: d.enrichment ?? null,
        enriched: !!d.enrichment,
        updatedAt: now,
      };
      if (d.leadId) {
        await updateDoc(doc(db, "leads", d.leadId), fields);
      } else {
        await addDoc(collection(db, "leads"), {
          ...fields,
          address: d.address,
          lat: d.lat ?? null,
          lng: d.lng ?? null,
          companyId,
          assignedTo: profile.uid,
          visibilityPath: [profile.uid, ...(profile.managerPath ?? [])],
          createdBy: profile.uid,
          createdAt: now,
        });
      }
      if (d.status === "appointment") void bumpStats(profile, { appointments: 1 });
      else if (d.status === "sold") void bumpStats(profile, { sales: 1 });
      onSaved?.();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  if (!d) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="dispo-card" onClick={(e) => e.stopPropagation()}>
        <div className="dispo-head">
          <div>
            <h3>{d.leadId ? "Home / Disposition" : "Log Disposition"}</h3>
            <div className="muted small">{d.address}</div>
          </div>
          <button className="dispo-x" onClick={onClose}>✕</button>
        </div>

        <div className="field-label">Disposition</div>
        <div className="dispo-grid">
          {DISPOSITIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={"dispo-pill" + (d.status === opt.value ? " active" : "")}
              style={{
                borderColor: opt.color,
                ...(d.status === opt.value ? { background: opt.color, color: "#06121f" } : {}),
              }}
              onClick={() => setD({ ...d, status: opt.value })}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {(summary || enriching) && (
          <div className="muted small dispo-summary">{enriching ? "Looking up home data…" : summary}</div>
        )}

        <label className="field">
          <span>Address</span>
          <input value={d.address} onChange={(e) => setD({ ...d, address: e.target.value })} />
        </label>
        <div className="grid-2">
          <label className="field">
            <span>Name</span>
            <input value={d.name} placeholder="Full name" onChange={(e) => setD({ ...d, name: e.target.value })} />
          </label>
          <label className="field">
            <span>Phone</span>
            <input value={d.phone} placeholder="(555) 000-0000" onChange={(e) => setD({ ...d, phone: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span>Email</span>
          <input value={d.email} placeholder="email@example.com" onChange={(e) => setD({ ...d, email: e.target.value })} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea rows={2} value={d.notes} placeholder="Add notes…" onChange={(e) => setD({ ...d, notes: e.target.value })} />
        </label>

        <div className="dispo-foot">
          <span className="muted small mono">
            {d.lat != null && d.lng != null ? `${d.lat.toFixed(5)}, ${d.lng.toFixed(5)}` : ""}
          </span>
          <div className="row">
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
            <button className="btn primary sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : d.leadId ? "Save" : "Add Lead"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
