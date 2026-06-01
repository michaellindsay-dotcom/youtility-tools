import type { Person, PropertyRecord } from "../types";
import { fmtCurrency, fmtNumber, fmtDate, fmtPercent, yearsAgo } from "../lib/format";

type Row = [string, unknown, { mono?: boolean }?];

function Fields({ rows }: { rows: Row[] }) {
  const visible = rows.filter(([, v]) => v != null && v !== "" && v !== "—");
  if (!visible.length) {
    return <div className="muted">No data returned for this section.</div>;
  }
  return (
    <dl className="fields">
      {visible.map(([label, value, opts], i) => (
        <div className="field-row" key={i}>
          <dt>{label}</dt>
          <dd className={opts?.mono ? "mono" : undefined}>{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function People({ people, kind }: { people: Person[]; kind: string }) {
  if (!people?.length) {
    return <div className="muted">No {kind} data returned.</div>;
  }
  return (
    <>
      {people.map((p, i) => {
        const meta = [
          p.role,
          p.entityType,
          p.ageRange && `age ${p.ageRange}`,
          p.gender,
          p.maritalStatus,
          p.lengthOfResidence != null && `${p.lengthOfResidence} yrs at address`,
        ].filter(Boolean);
        const contacts = [
          ...(p.phones || []),
          ...(p.emails || []),
          p.mailingAddress && p.mailingAddress !== p.address
            ? "Mail: " + p.mailingAddress
            : null,
        ].filter(Boolean) as string[];
        return (
          <div className="person" key={i}>
            <div className="person-name">{p.name || "(name withheld)"}</div>
            {meta.length > 0 && <div className="person-meta">{meta.join(" · ")}</div>}
            {contacts.length > 0 && (
              <div className="person-contacts">
                {contacts.map((c, j) => (
                  <span className="contact-chip" key={j}>
                    {c}
                  </span>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

export default function PropertyCards({ rec, raw }: { rec: PropertyRecord; raw: unknown }) {
  const p = rec.property as Record<string, any>;
  const v = rec.valuation as Record<string, any>;
  const m = rec.mortgage as Record<string, any>;
  const s = rec.sale as Record<string, any>;
  const l = rec.listing as Record<string, any>;
  const t = rec.tax as Record<string, any>;
  const d = rec.demographics as Record<string, any>;
  const h = rec.hazards as Record<string, any>;
  const ids = rec.ids as Record<string, any>;

  const chips: { label: string; tone?: string }[] = [];
  if (p.type) chips.push({ label: p.type });
  if (p.yearBuilt) chips.push({ label: `Built ${p.yearBuilt}` });
  if (rec.ownership.occupancy)
    chips.push({
      label: rec.ownership.occupancy,
      tone: rec.ownership.occupancy.toLowerCase().includes("owner") ? "good" : "warn",
    });
  if (rec.ownership.lengthOfOwnership != null)
    chips.push({ label: `Owned ${rec.ownership.lengthOfOwnership} yrs` });
  if (v.estimatedValue) chips.push({ label: "Est. " + fmtCurrency(v.estimatedValue) });
  if (h.floodZone && h.floodZone !== "X")
    chips.push({ label: `Flood zone ${h.floodZone}`, tone: "warn" });

  return (
    <section className="result-grid">
      <article className="card full">
        <div className="addr-hero">
          <div className="addr-line1">{rec.address.line1 || "Unknown address"}</div>
          <div className="addr-line2">
            {[rec.address.city, rec.address.state, rec.address.zip].filter(Boolean).join(", ")}
          </div>
          <div className="addr-meta">
            {chips.map((c, i) => (
              <span className={"chip" + (c.tone ? " " + c.tone : "")} key={i}>
                {c.label}
              </span>
            ))}
          </div>
        </div>
      </article>

      <article className="card">
        <h2>Property</h2>
        <Fields
          rows={[
            ["Type", p.type],
            ["Subtype", p.subtype],
            ["Year built", p.yearBuilt],
            ["Bedrooms", p.bedrooms],
            ["Bathrooms", p.bathrooms],
            ["Living area", p.livingAreaSqft ? fmtNumber(p.livingAreaSqft) + " sqft" : null],
            ["Lot size", p.lotSizeSqft ? fmtNumber(p.lotSizeSqft) + " sqft" : null],
            ["Stories", p.stories],
            ["Units", p.units],
            ["Garage", p.garage],
            ["Pool", p.pool],
            ["Heating", p.heating],
            ["Cooling", p.cooling],
            ["Roof", p.roof],
            ["Construction", p.construction],
            ["Last renovated", fmtDate(p.lastRenovated)],
            ["Zoning", p.zoning],
            ["HOA", p.hoa],
          ]}
        />
      </article>

      <article className="card">
        <h2>Valuation &amp; Equity</h2>
        <Fields
          rows={[
            ["Estimated value", fmtCurrency(v.estimatedValue)],
            [
              "Value range",
              v.estimatedLow && v.estimatedHigh
                ? `${fmtCurrency(v.estimatedLow)} – ${fmtCurrency(v.estimatedHigh)}`
                : null,
            ],
            ["Confidence", v.confidence],
            ["Estimated equity", fmtCurrency(v.estimatedEquity)],
            ["Equity %", fmtPercent(v.equityPercent)],
            ["LTV", fmtPercent(v.loanToValue)],
            ["$ / sqft", fmtCurrency(v.pricePerSqft)],
            ["Rent estimate", v.rentEstimate ? fmtCurrency(v.rentEstimate) + "/mo" : null],
            ["As of", fmtDate(v.asOf)],
          ]}
        />
      </article>

      <article className="card">
        <h2>Owner(s) of Record</h2>
        <People people={rec.owners} kind="owner" />
      </article>

      <article className="card">
        <h2>Occupants &amp; Household</h2>
        <People people={rec.occupants} kind="occupant" />
      </article>

      <article className="card">
        <h2>Mortgage</h2>
        <Fields
          rows={[
            ["Lender", m.lender],
            ["Loan type", m.loanType],
            ["Original amount", fmtCurrency(m.originalAmount)],
            ["Current balance", fmtCurrency(m.currentBalance)],
            ["Interest rate", fmtPercent(m.interestRate)],
            ["Term", m.termYears ? m.termYears + " yrs" : null],
            ["Origination", fmtDate(m.originationDate)],
            ["Maturity", fmtDate(m.maturityDate)],
            ["2nd lien", m.secondLien ? "Yes" : null],
            ["HELOC", m.heloc ? "Yes" : null],
            ["Position", m.position],
          ]}
        />
      </article>

      <article className="card">
        <h2>Sale &amp; Listing History</h2>
        <Fields
          rows={[
            ["Last sale price", fmtCurrency(s.lastSalePrice)],
            [
              "Last sale date",
              s.lastSaleDate ? `${fmtDate(s.lastSaleDate)} (${yearsAgo(s.lastSaleDate)})` : null,
            ],
            [
              "Prior sale",
              s.priorSalePrice && s.priorSaleDate
                ? `${fmtCurrency(s.priorSalePrice)} on ${fmtDate(s.priorSaleDate)}`
                : null,
            ],
            ["MLS status", l.status],
            ["List price", fmtCurrency(l.listPrice)],
            ["Listed on", fmtDate(l.listedAt)],
            ["Days on market", l.daysOnMarket],
            ["Listing agent", l.agent],
            ["Listing brokerage", l.brokerage],
          ]}
        />
      </article>

      <article className="card">
        <h2>Tax &amp; Assessment</h2>
        <Fields
          rows={[
            ["Assessed value", fmtCurrency(t.assessedValue)],
            ["Land value", fmtCurrency(t.landValue)],
            ["Improvement", fmtCurrency(t.improvementValue)],
            ["Annual tax", fmtCurrency(t.annualTax)],
            ["Tax year", t.taxYear],
            ["Tax rate", fmtPercent(t.taxRate)],
            ["Exemptions", (t.exemptions || []).join?.(", ") || null],
            ["Delinquent", t.delinquent ? "Yes" : null],
          ]}
        />
      </article>

      <article className="card">
        <h2>Neighborhood &amp; Demographics</h2>
        <Fields
          rows={[
            ["Median income", fmtCurrency(d.medianIncome)],
            ["Median home value", fmtCurrency(d.medianHomeValue)],
            ["Owner occupancy %", fmtPercent(d.ownerOccupancyPct)],
            ["Avg household size", d.avgHouseholdSize],
            ["Median age", d.medianAge],
            ["Population", fmtNumber(d.population)],
            ["Walk score", d.walkScore],
            ["School district", d.schoolDistrict],
            ["Elementary", d.elementarySchool],
            ["Middle", d.middleSchool],
            ["High", d.highSchool],
          ]}
        />
      </article>

      <article className="card">
        <h2>Hazards &amp; Risk</h2>
        <Fields
          rows={[
            ["FEMA flood zone", h.floodZone],
            ["Flood risk", h.floodRisk],
            ["Wildfire risk", h.fireRisk],
            ["Earthquake risk", h.earthquakeRisk],
            ["Hail / storm history", h.stormHistory],
            ["Crime index", h.crimeIndex],
          ]}
        />
      </article>

      <article className="card full">
        <h2>Identifiers &amp; Legal</h2>
        <Fields
          rows={[
            ["APN / Parcel #", ids.apn, { mono: true }],
            ["FIPS", ids.fips, { mono: true }],
            ["County", ids.county],
            ["Census tract", ids.censusTract, { mono: true }],
            ["Subdivision", ids.subdivision],
            ["Legal description", ids.legalDescription],
            ["Latitude", rec.address.lat, { mono: true }],
            ["Longitude", rec.address.lon, { mono: true }],
            ["Knockstat ID", ids.knockstatId, { mono: true }],
          ]}
        />
      </article>

      <details className="raw">
        <summary>Raw API response</summary>
        <pre>{JSON.stringify(raw, null, 2)}</pre>
      </details>
    </section>
  );
}
