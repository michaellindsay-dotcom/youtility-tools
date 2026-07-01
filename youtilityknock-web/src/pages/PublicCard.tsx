import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../firebase";

interface CardPayload {
  slug: string;
  displayName: string;
  title: string;
  photoUrl: string;
  bio: string;
  serviceArea: string;
  reviews: { name: string; text: string; rating: number }[];
  phone: string;
  email: string;
  companyName: string;
}

type Status = "loading" | "ready" | "error";

function Stars({ n }: { n: number }) {
  return <span style={{ color: "#fbbf24", letterSpacing: 1 }}>{"★".repeat(n)}{"☆".repeat(5 - n)}</span>;
}

export default function PublicCard() {
  const [status, setStatus] = useState<Status>("loading");
  const [card, setCard] = useState<CardPayload | null>(null);
  const [errorMsg, setErrorMsg] = useState("");

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [notes, setNotes] = useState("");
  const [hp, setHp] = useState(""); // honeypot — real visitors never fill this
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [formMsg, setFormMsg] = useState("");

  const slug = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("card") || "" : "";

  useEffect(() => {
    if (!slug) { setStatus("error"); setErrorMsg("Missing card link."); return; }
    httpsCallable(functions, "getRepCard")({ slug })
      .then((r) => { setCard(r.data as CardPayload); setStatus("ready"); })
      .catch((e) => { setErrorMsg(e?.message || "This card isn't available."); setStatus("error"); });
  }, [slug]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || (!phone.trim() && !email.trim())) {
      setFormMsg("Please share your name and a phone number or email.");
      return;
    }
    setSubmitting(true);
    setFormMsg("");
    try {
      await httpsCallable(functions, "submitCardLead")({ slug, name, phone, email, address, notes, hp });
      setSubmitted(true);
    } catch (err) {
      setFormMsg((err as Error).message || "Couldn't send that — please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="pc-wrap">
      <div className="pc-card">
        {status === "loading" && <div className="pc-state">Loading…</div>}
        {status === "error" && <div className="pc-state">{errorMsg}</div>}
        {status === "ready" && card && (
          <>
            <div className="pc-hero">
              {card.photoUrl ? (
                <img src={card.photoUrl} alt={card.displayName} className="pc-photo" />
              ) : (
                <div className="pc-photo pc-photo-placeholder">{card.displayName.slice(0, 1)}</div>
              )}
              <h1 className="pc-name">{card.displayName}</h1>
              {card.title && <div className="pc-title">{card.title}</div>}
              {card.companyName && <div className="pc-company">{card.companyName}</div>}
              {card.serviceArea && <div className="pc-area">📍 {card.serviceArea}</div>}
            </div>

            {card.bio && <p className="pc-bio">{card.bio}</p>}

            <div className="pc-contact-row">
              {card.phone && (
                <>
                  <a className="btn primary" href={`tel:${card.phone}`}>📞 Call</a>
                  <a className="btn ghost" href={`sms:${card.phone}`}>💬 Text</a>
                </>
              )}
              {card.email && <a className="btn ghost" href={`mailto:${card.email}`}>✉️ Email</a>}
            </div>

            {card.reviews.length > 0 && (
              <div className="pc-reviews">
                <h3>What neighbors say</h3>
                {card.reviews.map((r, i) => (
                  <div key={i} className="pc-review">
                    <Stars n={r.rating} />
                    <p>&ldquo;{r.text}&rdquo;</p>
                    {r.name && <div className="muted small">— {r.name}</div>}
                  </div>
                ))}
              </div>
            )}

            <div className="pc-form-block">
              <h3>Get in touch</h3>
              {submitted ? (
                <p className="pc-thanks">Thanks — {card.displayName.split(" ")[0]} will reach out soon.</p>
              ) : (
                <form onSubmit={submit}>
                  <input className="input" style={{ width: "100%", marginBottom: 8 }} placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
                  <input className="input" style={{ width: "100%", marginBottom: 8 }} placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} />
                  <input className="input" style={{ width: "100%", marginBottom: 8 }} placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  <input className="input" style={{ width: "100%", marginBottom: 8 }} placeholder="Address (optional)" value={address} onChange={(e) => setAddress(e.target.value)} />
                  <textarea className="input" style={{ width: "100%", minHeight: 70, marginBottom: 8 }} placeholder="Anything you'd like to add?" value={notes} onChange={(e) => setNotes(e.target.value)} />
                  <input
                    type="text" tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)}
                    style={{ position: "absolute", left: "-9999px", width: 1, height: 1 }} aria-hidden="true"
                  />
                  <button className="btn primary block" type="submit" disabled={submitting}>
                    {submitting ? "Sending…" : "Send my info"}
                  </button>
                  {formMsg && <p className="muted small" style={{ marginTop: 8 }}>{formMsg}</p>}
                </form>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
