// The "physical business card" visual — shared by the public card page and the
// rep's own editor (as a live preview) so they always match exactly.
export interface BizCardHeroProps {
  displayName: string;
  title?: string;
  companyName?: string;
  logoUrl?: string;
  photoUrl?: string;
  bgImageUrl?: string; // subtle photo behind the card, e.g. a jobsite/install shot
  serviceArea?: string;
  memberId?: number | null;
  idPrefix?: string; // company code (e.g. "YT") shown before the member number, license-plate style
  phone?: string;
  email?: string;
}

export default function BizCardHero({
  displayName, title, companyName, logoUrl, photoUrl, bgImageUrl, serviceArea, memberId, idPrefix, phone, email,
}: BizCardHeroProps) {
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
        {(phone || email) && (
          <div className="biz-card-contact">
            {phone && (
              <span className="biz-card-contact-item">
                <span className="biz-card-contact-ico">📞</span>{phone}
              </span>
            )}
            {email && (
              <span className="biz-card-contact-item">
                <span className="biz-card-contact-ico">✉</span>{email}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="biz-card-bottom">
        <span>
          {logoUrl && companyName && companyName}
          {logoUrl && companyName && serviceArea && " · "}
          {serviceArea && `📍 ${serviceArea}`}
        </span>
        {memberId != null && <span className="biz-card-bottom-id">RallyCard ID: {idPrefix || ""}{memberId}</span>}
      </div>
    </div>
  );
}
