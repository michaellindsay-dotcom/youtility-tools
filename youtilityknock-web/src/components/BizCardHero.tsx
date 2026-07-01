// The "physical business card" visual — shared by the public card page and the
// rep's own editor (as a live preview) so they always match exactly.
export interface BizCardHeroProps {
  displayName: string;
  title?: string;
  companyName?: string;
  logoUrl?: string;
  photoUrl?: string;
  serviceArea?: string;
  memberId?: number | null;
  phone?: string;
  email?: string;
}

export default function BizCardHero({
  displayName, title, companyName, logoUrl, photoUrl, serviceArea, memberId, phone, email,
}: BizCardHeroProps) {
  return (
    <div className="biz-card">
      <div className="biz-card-top">
        {logoUrl ? (
          <img src={logoUrl} alt={companyName || "Company logo"} className="biz-card-logo" />
        ) : (
          <span className="biz-card-company">{companyName}</span>
        )}
        {memberId != null && (
          <div className="biz-card-id-wrap">
            <span className="biz-card-id-label">Member No.</span>
            <span className="biz-card-id">{memberId.toLocaleString()}</span>
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
          {phone && <span>📞 {phone}</span>}
          {email && <span>✉️ {email}</span>}
        </div>
      )}
      <div className="biz-card-bottom">
        {logoUrl && companyName && <span>{companyName}</span>}
        {serviceArea && <span>📍 {serviceArea}</span>}
      </div>
    </div>
  );
}
