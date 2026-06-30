import { useState, type FormEvent } from "react";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import {
  normalizeKnockstatResponse,
  lookupAddress,
  DEMO_RAW,
} from "../lib/knockstat";
import PropertyCards from "../components/PropertyCards";
import type { PropertyRecord } from "../types";

type Banner = { kind: "info" | "warn" | "error"; msg: string } | null;

export default function Lookup() {
  const { user, companyId } = useAuth();
  const [address, setAddress] = useState("");
  const [rec, setRec] = useState<PropertyRecord | null>(null);
  const [raw, setRaw] = useState<unknown>(null);
  const [banner, setBanner] = useState<Banner>(null);
  const [busy, setBusy] = useState(false);

  // Record an audit-log entry so managers can see who looked up what.
  const logLookup = async (addr: string, found: boolean) => {
    if (!user || !companyId) return;
    try {
      await addDoc(collection(db, "lookups"), {
        userId: user.uid,
        companyId,
        address: addr,
        found,
        createdAt: serverTimestamp(),
      });
    } catch (err) {
      console.warn("Could not log lookup", err);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const addr = address.trim();
    if (!addr) return;

    setBusy(true);
    setBanner(null);
    try {
      const token = await auth.currentUser!.getIdToken();
      const data = await lookupAddress(addr, token);
      const normalized = normalizeKnockstatResponse(data);
      setRec(normalized);
      setRaw(data);
      setBanner({ kind: "info", msg: `Loaded data for "${addr}".` });
      void logLookup(addr, true);
    } catch (err: any) {
      console.error(err);
      void logLookup(addr, false);
      if (err.code === "HTTP_401" || err.code === "HTTP_403") {
        setBanner({ kind: "error", msg: "Lookup service rejected the request. Check API configuration." });
      } else if (err.code === "HTTP_404") {
        setBanner({ kind: "warn", msg: "No property found for that address." });
      } else {
        setBanner({ kind: "error", msg: err.message || "Request failed." });
      }
    } finally {
      setBusy(false);
    }
  };

  const onDemo = () => {
    setAddress("742 Evergreen Terrace, Springfield, IL 62704");
    setRec(normalizeKnockstatResponse(DEMO_RAW));
    setRaw(DEMO_RAW);
    setBanner({ kind: "info", msg: "Showing local demo data — no API call was made." });
  };

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>Address Lookup</h1>
        <p className="page-sub">
          Enter an address to pull full homeowner and property intel via Knockstat.
        </p>
      </div>

      <form className="search" onSubmit={onSubmit} autoComplete="off">
        <input
          type="text"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          placeholder="1600 Pennsylvania Ave NW, Washington, DC"
          aria-label="Address"
          required
        />
        <button className="btn primary" type="submit" disabled={busy}>
          {busy ? "Looking up…" : "Look up"}
        </button>
        <button className="btn ghost" type="button" onClick={onDemo}>
          Demo data
        </button>
      </form>

      {banner && <div className={`banner show ${banner.kind}`}>{banner.msg}</div>}

      {rec && <PropertyCards rec={rec} raw={raw} />}
    </div>
  );
}
