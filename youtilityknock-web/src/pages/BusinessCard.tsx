import { useEffect, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import QRCode from "qrcode";
import { storage, functions } from "../firebase";
import { useAuth } from "../auth/AuthContext";
import BizCardHero from "../components/BizCardHero";
import type { CardReview } from "../types";
import { CARD_THEMES, CARD_THEME_KEYS, cardAccentVars, cardThemeBg } from "../lib/cardTheme";

// A rich-preview link (real og:title/description/image) that immediately
// redirects into the app — see the `cardShare` function. Used for anything
// people actually send (share sheet, text, email, QR) so link previews show
// the rep's name/photo instead of the site's generic preview.
const CARD_SHARE_BASE_URL = "https://youtilityknock.web.app/c";

export default function BusinessCard() {
  const { profile, company } = useAuth();
  const [slug, setSlug] = useState(profile?.cardSlug || "");
  const [enabled, setEnabled] = useState(!!profile?.cardEnabled);
  const [title, setTitle] = useState(profile?.cardTitle || profile?.title || "");
  const [bio, setBio] = useState(profile?.cardBio || "");
  const [serviceArea, setServiceArea] = useState(profile?.cardServiceArea || "");
  const [photoUrl, setPhotoUrl] = useState(profile?.cardPhotoUrl || "");
  const [logoUrl, setLogoUrl] = useState(profile?.cardLogoUrl || "");
  const [reviews, setReviews] = useState<CardReview[]>(profile?.cardReviews || []);
  const [accentColor, setAccentColor] = useState(profile?.cardAccentColor || "#38bdf8");
  const [theme, setTheme] = useState(profile?.cardTheme || "default");
  const [uploading, setUploading] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");

  useEffect(() => {
    setSlug(profile?.cardSlug || "");
    setEnabled(!!profile?.cardEnabled);
    setTitle(profile?.cardTitle || profile?.title || "");
    setBio(profile?.cardBio || "");
    setServiceArea(profile?.cardServiceArea || "");
    setPhotoUrl(profile?.cardPhotoUrl || "");
    setLogoUrl(profile?.cardLogoUrl || "");
    setReviews(profile?.cardReviews || []);
    setAccentColor(profile?.cardAccentColor || "#38bdf8");
    setTheme(profile?.cardTheme || "default");
  }, [profile]);

  // Company logo unless the rep uploaded their own override.
  const effectiveLogo = logoUrl || company?.logoUrl || "";

  const shareUrl = profile?.cardSlug ? `${CARD_SHARE_BASE_URL}/${profile.cardSlug}` : "";

  useEffect(() => {
    if (!shareUrl) { setQrDataUrl(""); return; }
    QRCode.toDataURL(shareUrl, { width: 320, margin: 1, color: { dark: "#0a0f1a", light: "#ffffff" } })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(""));
  }, [shareUrl]);

  async function onPhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !profile) return;
    setUploading(true);
    setMsg("");
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const r = storageRef(storage, `cards/${profile.uid}/${Date.now()}_${safe}`);
      await uploadBytes(r, file, { contentType: file.type || "image/jpeg" });
      const url = await getDownloadURL(r);
      setPhotoUrl(url);
    } catch (e) {
      setMsg((e as Error).message || "Photo upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function onLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !profile) return;
    setUploadingLogo(true);
    setMsg("");
    try {
      const safe = file.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
      const r = storageRef(storage, `cards/${profile.uid}/logo_${Date.now()}_${safe}`);
      await uploadBytes(r, file, { contentType: file.type || "image/png" });
      const url = await getDownloadURL(r);
      setLogoUrl(url);
    } catch (e) {
      setMsg((e as Error).message || "Logo upload failed.");
    } finally {
      setUploadingLogo(false);
    }
  }

  function updateReview(i: number, patch: Partial<CardReview>) {
    setReviews((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removeReview(i: number) {
    setReviews((rs) => rs.filter((_, idx) => idx !== i));
  }
  function addReview() {
    setReviews((rs) => [...rs, { name: "", text: "", rating: 5 }]);
  }

  async function save(nextEnabled?: boolean) {
    setSaving(true);
    setMsg("");
    try {
      const r = await httpsCallable(functions, "setMyCard")({
        slug,
        title,
        bio,
        serviceArea,
        photoUrl,
        logoUrl,
        reviews,
        accentColor,
        theme,
        enabled: nextEnabled ?? enabled,
      });
      const data = r.data as { cardSlug?: string; cardEnabled?: boolean };
      if (typeof data.cardSlug === "string") setSlug(data.cardSlug);
      if (typeof data.cardEnabled === "boolean") setEnabled(data.cardEnabled);
      setMsg("Saved ✓");
    } catch (e) {
      setMsg((e as Error).message || "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  function copyLink() {
    if (!shareUrl) return;
    navigator.clipboard?.writeText(shareUrl).then(() => setMsg("Link copied ✓")).catch(() => {});
  }

  const shareText = `Check out my digital business card${profile?.displayName ? ` — ${profile.displayName}` : ""}: ${shareUrl}`;

  async function shareCard() {
    if (!shareUrl) return;
    if (navigator.share) {
      try {
        await navigator.share({ title: "My RallyCard", text: shareText, url: shareUrl });
      } catch {
        // user cancelled the share sheet — nothing to do
      }
    } else {
      copyLink();
    }
  }

  function downloadQr() {
    if (!qrDataUrl) return;
    const a = document.createElement("a");
    a.href = qrDataUrl;
    a.download = `${slug || "my-card"}-qr.png`;
    a.click();
  }

  return (
    <div className="page-body">
      <div className="page-head">
        <h1>My RallyCard</h1>
        <p className="page-sub">
          A public, no-login page homeowners can visit — your photo, story, and reviews, with a
          one-tap way to call, text, or leave you their info. Share the link or print the QR code
          on a door hanger or yard sign.
        </p>
      </div>

      <div
        className="card"
        style={{ textAlign: "center", background: cardThemeBg(theme), ...cardAccentVars(accentColor) }}
      >
        <BizCardHero
          displayName={profile?.displayName || ""}
          title={title || profile?.title}
          companyName={company?.name}
          logoUrl={effectiveLogo}
          photoUrl={photoUrl}
          bgImageUrl={company?.bgImageUrl}
          serviceArea={serviceArea}
          memberId={profile?.cardMemberId ?? null}
          idPrefix={company?.idPrefix}
          phone={profile?.phone}
          email={profile?.email}
        />
        {profile?.cardMemberId && (
          <p className="muted small" style={{ marginTop: 10 }}>Your RallyCard ID: No. {company?.idPrefix || ""}{profile.cardMemberId}</p>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Colors &amp; style</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Pick an accent color and background to make your card your own.
        </p>
        <div className="row" style={{ alignItems: "center", gap: 10, marginBottom: 14 }}>
          <input
            type="color"
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            style={{ width: 40, height: 40, padding: 0, border: "1px solid var(--line-hi)", borderRadius: 8, background: "none", cursor: "pointer" }}
            aria-label="Accent color"
          />
          <input
            className="input"
            style={{ maxWidth: 120 }}
            value={accentColor}
            onChange={(e) => setAccentColor(e.target.value)}
            placeholder="#38bdf8"
          />
          <span className="muted small">Accent color (buttons &amp; highlights)</span>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {CARD_THEME_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setTheme(key)}
              title={CARD_THEMES[key].label}
              style={{
                width: 56, height: 36, borderRadius: 8, cursor: "pointer",
                background: CARD_THEMES[key].bg,
                border: theme === key ? "2px solid var(--accent)" : "1px solid var(--line-hi)",
              }}
            />
          ))}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Company logo</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          {company?.logoUrl
            ? "Your company logo shows on your card by default — upload your own below to override it."
            : "Your company hasn't set a logo yet — you can upload your own."}
        </p>
        <div className="row" style={{ alignItems: "center", gap: 12 }}>
          {effectiveLogo ? (
            <img src={effectiveLogo} alt="" style={{ maxHeight: 44, maxWidth: 140, objectFit: "contain" }} />
          ) : (
            <span className="muted small">No logo yet</span>
          )}
          <label className="btn ghost sm" style={{ cursor: "pointer" }}>
            {uploadingLogo ? "Uploading…" : "Upload my own logo"}
            <input type="file" accept="image/*" onChange={onLogoChange} disabled={uploadingLogo} style={{ display: "none" }} />
          </label>
          {logoUrl && (
            <button className="btn ghost sm" onClick={() => setLogoUrl("")}>Use company logo instead</button>
          )}
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Card link</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          Pick something short and memorable — this is what people type or scan.
        </p>
        <div className="row" style={{ alignItems: "center" }}>
          <span className="muted small">{CARD_SHARE_BASE_URL}/</span>
          <input
            className="input"
            style={{ maxWidth: 220 }}
            placeholder="jane-solar"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        {shareUrl && (
          <>
            <div className="row" style={{ marginTop: 10, alignItems: "center" }}>
              <a href={shareUrl} target="_blank" rel="noopener noreferrer" className="small">{shareUrl}</a>
            </div>
            <div className="row" style={{ marginTop: 10, gap: 8, flexWrap: "wrap" }}>
              <button className="btn primary sm" onClick={shareCard}>📤 Share my card</button>
              <a className="btn ghost sm" href={`sms:?&body=${encodeURIComponent(shareText)}`}>💬 Text it</a>
              <a
                className="btn ghost sm"
                href={`mailto:?subject=${encodeURIComponent("My digital business card")}&body=${encodeURIComponent(shareText)}`}
              >
                ✉️ Email it
              </a>
              <button className="btn ghost sm" onClick={copyLink}>🔗 Copy link</button>
            </div>
          </>
        )}
        <div className="row" style={{ marginTop: 14, alignItems: "center" }}>
          <label className="row small" style={{ alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Card is live
          </label>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Photo &amp; story</h3>
        <div className="row" style={{ alignItems: "flex-start", gap: 16, marginTop: 8 }}>
          <div style={{ textAlign: "center" }}>
            {photoUrl ? (
              <img src={photoUrl} alt="" style={{ width: 96, height: 96, borderRadius: "50%", objectFit: "cover", border: "1px solid var(--line-hi)" }} />
            ) : (
              <div style={{ width: 96, height: 96, borderRadius: "50%", background: "var(--bg-2)", border: "1px dashed var(--line-hi)" }} />
            )}
            <label className="btn ghost sm" style={{ marginTop: 8, display: "inline-block", cursor: "pointer" }}>
              {uploading ? "Uploading…" : "Change photo"}
              <input type="file" accept="image/*" onChange={onPhotoChange} disabled={uploading} style={{ display: "none" }} />
            </label>
          </div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <input
              className="input"
              style={{ marginBottom: 8, width: "100%" }}
              placeholder="Title shown on your card (e.g. Solar Consultant)"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
            <textarea
              className="input"
              style={{ width: "100%", minHeight: 90 }}
              placeholder="A short bio homeowners will read — why you do this, what to expect."
              value={bio}
              onChange={(e) => setBio(e.target.value)}
            />
            <input
              className="input"
              style={{ marginTop: 8, width: "100%" }}
              placeholder="Service area (e.g. Salt Lake &amp; Utah counties)"
              value={serviceArea}
              onChange={(e) => setServiceArea(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: 4 }}>Reviews</h3>
        <p className="muted small" style={{ marginBottom: 12 }}>
          A few real quotes go a long way on the doorstep.
        </p>
        {reviews.map((r, i) => (
          <div key={i} className="row" style={{ alignItems: "center", marginBottom: 8, gap: 6 }}>
            <input
              className="input" style={{ maxWidth: 140 }} placeholder="Customer name"
              value={r.name} onChange={(e) => updateReview(i, { name: e.target.value })}
            />
            <input
              className="input" style={{ flex: 1 }} placeholder="What they said"
              value={r.text} onChange={(e) => updateReview(i, { text: e.target.value })}
            />
            <select
              className="input" style={{ maxWidth: 70 }}
              value={r.rating} onChange={(e) => updateReview(i, { rating: Number(e.target.value) })}
            >
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}★</option>)}
            </select>
            <button className="btn ghost sm" onClick={() => removeReview(i)}>Remove</button>
          </div>
        ))}
        <button className="btn ghost sm" onClick={addReview}>+ Add a review</button>
      </div>

      {qrDataUrl && (
        <div className="card" style={{ textAlign: "center" }}>
          <h3 style={{ marginBottom: 8 }}>QR code</h3>
          <img src={qrDataUrl} alt="Card QR code" style={{ width: 160, height: 160 }} />
          <div style={{ marginTop: 10 }}>
            <button className="btn ghost sm" onClick={downloadQr}>Download PNG</button>
          </div>
        </div>
      )}

      <div className="row" style={{ alignItems: "center" }}>
        <button className="btn primary" onClick={() => save()} disabled={saving}>
          {saving ? "Saving…" : "Save changes"}
        </button>
        {msg && <span className="muted small">{msg}</span>}
      </div>
    </div>
  );
}
