import { useEffect, useState } from "react";
import QRCode from "qrcode";

// The "physical business card" visual — shared by the public card page and the
// rep's own editor (as a live preview) so they always match exactly. This is
// the whole self-contained flyer: contact info, a pitch, one-tap actions, and
// a "scan to save contact" footer — not just a name/photo header.
export interface BizCardHeroProps {
  displayName: string;
  title?: string;
  companyName?: string;
  logoUrl?: string;
  photoUrl?: string;
  bgImageUrl?: string; // subtle photo behind the card, e.g. a jobsite/install shot
  memberId?: number | null;
  idPrefix?: string; // company code (e.g. "YT") shown before the member number, license-plate style
  phone?: string;
  email?: string;
  website?: string;
  companyPhone?: string;
  companyAddress?: string;
  vcfUrl?: string; // "save contact" vCard link — drives the footer QR code
  leadAnchorId?: string; // element id the "Leave Your Info" tile scrolls to
}

export default function BizCardHero({
  displayName, title, companyName, logoUrl, photoUrl, bgImageUrl, memberId, idPrefix,
  phone, email, website, companyPhone, companyAddress, vcfUrl, leadAnchorId,
}: BizCardHeroProps) {
  const [qrDataUrl, setQrDataUrl] = useState("");

  useEffect(() => {
    if (!vcfUrl) { setQrDataUrl(""); return; }
    let cancelled = false;
    QRCode.toDataURL(vcfUrl, { width: 240, margin: 1, color: { dark: "#0a0f1a", light: "#ffffff" } })
      .then((url) => { if (!cancelled) setQrDataUrl(url); })
      .catch(() => { if (!cancelled) setQrDataUrl(""); });
    return () => { cancelled = true; };
  }, [vcfUrl]);

  return (
    <div className="biz-card">
      {bgImageUrl && (
        <div className="biz-card-bg-wrap">
          <img src={bgImageUrl} alt="" className="biz-card-bg" />
          <div className="biz-card-bg-fade" />
        </div>
      )}
      <div className="biz-card-body">
        <div className="biz-card-top">
          {logoUrl ? (
            <img src={logoUrl} alt={companyName || "Company logo"} className="biz-card-logo" />
          ) : (
            <span className="biz-card-company">{companyName}</span>
          )}
          {memberId != null && (
            <div className="biz-card-id-wrap">
              <span className="biz-card-id-label">Member No.</span>
              <span className="biz-card-id">{idPrefix || ""}{memberId}</span>
            </div>
          )}
        </div>
        <div className="biz-card-mid">
          {photoUrl ? (
            <img src={photoUrl} alt={displayName} className="biz-card-avatar" />
          ) : (
            <div className="biz-card-avatar biz-card-avatar-placeholder">{(displayName || "?").slice(0, 1)}</div>
          )}
          <div>
            <div className="biz-card-name">{displayName || "Your name"}</div>
            {title && <div className="biz-card-title">{title}</div>}
          </div>
        </div>
        {(phone || email || website || companyPhone || companyAddress) && (
          <div className="biz-card-contact">
            {phone && (
              <a className="biz-card-contact-item" href={`tel:${phone}`}>
                <span className="biz-card-contact-ico">📞</span>{phone}
              </a>
            )}
            {email && (
              <a className="biz-card-contact-item" href={`mailto:${email}`}>
                <span className="biz-card-contact-ico">✉</span>{email}
              </a>
            )}
            {companyPhone && companyPhone !== phone && (
              <a className="biz-card-contact-item" href={`tel:${companyPhone}`}>
                <span className="biz-card-contact-ico">☎</span>{companyPhone}
              </a>
            )}
            {website && (
              <a className="biz-card-contact-item" href={website} target="_blank" rel="noopener noreferrer">
                <span className="biz-card-contact-ico">🌐</span>{website.replace(/^https?:\/\//, "")}
              </a>
            )}
            {companyAddress && (
              <a
                className="biz-card-contact-item"
                href={`https://maps.google.com/?q=${encodeURIComponent(companyAddress)}`}
                target="_blank" rel="noopener noreferrer"
              >
                <span className="biz-card-contact-ico">📍</span>{companyAddress}
              </a>
            )}
          </div>
        )}

        {(phone || email) && (
          <>
            <div className="biz-card-divider" />
            <div className="biz-card-cta-row">
              {phone && (
                <a className="biz-card-cta" href={`tel:${phone}`}>
                  <span className="biz-card-cta-ico">📞</span>
                  <span className="biz-card-cta-label">Call or Text</span>
                  <span className="biz-card-cta-sub">Fast response</span>
                </a>
              )}
              {email && (
                <a className="biz-card-cta" href={`mailto:${email}`}>
                  <span className="biz-card-cta-ico">💬</span>
                  <span className="biz-card-cta-label">Leave a Message</span>
                  <span className="biz-card-cta-sub">I'll follow up</span>
                </a>
              )}
              <a className="biz-card-cta" href={`#${leadAnchorId || "pc-lead-form"}`}>
                <span className="biz-card-cta-ico">📝</span>
                <span className="biz-card-cta-label">Leave Your Info</span>
                <span className="biz-card-cta-sub">Get your options</span>
              </a>
            </div>
          </>
        )}
      </div>
      <div className="biz-card-bottom">
        <div className="biz-card-bottom-left">
          {qrDataUrl && <img src={qrDataUrl} alt="Scan to save contact" className="biz-card-qr" />}
          <span>Scan to save<br />my contact</span>
        </div>
        <div className="biz-card-bottom-right">
          <span>No login. No app. Just results.</span>
          {memberId != null && <span className="biz-card-bottom-id">RallyCard ID: {idPrefix || ""}{memberId}</span>}
        </div>
      </div>
    </div>
  );
}
