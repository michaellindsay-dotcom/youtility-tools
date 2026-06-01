import type { Person, PropertyRecord, LeadEnrichment } from "../types";

// ---------------------------------------------------------------------------
// Knockstat response normalization, ported from canvass-pro.html.
//
// The live HTTP call no longer lives in the browser — it goes through the
// `/api/knockstat` Cloud Function proxy (see functions/src/index.ts), which
// holds the API key server-side. This module only turns whatever Knockstat
// returns into the shape the UI consumes.
// ---------------------------------------------------------------------------

type AnyObj = Record<string, any>;

// Pluck the first defined value at any of the given dotted paths.
export function pick(obj: AnyObj | null | undefined, ...paths: string[]): any {
  for (const p of paths) {
    const parts = p.split(".");
    let v: any = obj;
    let ok = true;
    for (const part of parts) {
      if (v == null) {
        ok = false;
        break;
      }
      v = v[part];
    }
    if (ok && v != null && v !== "") return v;
  }
  return null;
}

function arrayify(v: any): string[] {
  if (v == null) return [];
  if (Array.isArray(v))
    return v.map((x) =>
      typeof x === "string" ? x : x.number || x.address || x.value || JSON.stringify(x)
    );
  return [v];
}

function normalizePeople(arr: any, defaultRole: string): Person[] {
  if (!Array.isArray(arr)) return [];
  return arr.map((p) => ({
    name:
      pick(p, "name", "fullName") ||
      [pick(p, "firstName"), pick(p, "lastName")].filter(Boolean).join(" "),
    role: pick(p, "role") || defaultRole,
    entityType: pick(p, "entityType", "ownerType"),
    ageRange: pick(p, "ageRange", "age"),
    gender: pick(p, "gender"),
    maritalStatus: pick(p, "maritalStatus"),
    lengthOfResidence: pick(p, "lengthOfResidence", "yearsAtAddress"),
    phones: arrayify(pick(p, "phones", "phone")),
    emails: arrayify(pick(p, "emails", "email")),
    mailingAddress: pick(p, "mailingAddress", "mailing"),
    address: pick(p, "address"),
  }));
}

export function normalizeKnockstatResponse(raw: AnyObj): PropertyRecord {
  const r: AnyObj = (raw && (raw.data || raw.result || raw.property || raw)) || {};
  return {
    address: {
      line1: pick(r, "address.line1", "address.street", "address.formatted", "address.full", "address"),
      city: pick(r, "address.city"),
      state: pick(r, "address.state", "address.region"),
      zip: pick(r, "address.zip", "address.postalCode", "address.postcode"),
      lat: pick(r, "address.latitude", "geo.lat", "location.lat"),
      lon: pick(r, "address.longitude", "geo.lng", "location.lon", "location.lng"),
    },
    property: {
      type: pick(r, "property.type", "propertyType"),
      subtype: pick(r, "property.subtype", "propertySubtype"),
      yearBuilt: pick(r, "property.yearBuilt", "yearBuilt"),
      bedrooms: pick(r, "property.bedrooms", "bedrooms"),
      bathrooms: pick(r, "property.bathrooms", "bathrooms"),
      livingAreaSqft: pick(r, "property.livingAreaSqft", "property.sqft", "buildingSqft", "livingArea"),
      lotSizeSqft: pick(r, "property.lotSizeSqft", "lotSqft", "lotSize"),
      stories: pick(r, "property.stories", "stories"),
      units: pick(r, "property.units", "units"),
      garage: pick(r, "property.garage", "garage"),
      pool: pick(r, "property.pool", "pool"),
      heating: pick(r, "property.heating", "heating"),
      cooling: pick(r, "property.cooling", "cooling"),
      roof: pick(r, "property.roof", "roofMaterial"),
      construction: pick(r, "property.construction", "constructionType"),
      lastRenovated: pick(r, "property.lastRenovated", "lastRenovationDate"),
      zoning: pick(r, "property.zoning", "zoning"),
      hoa: pick(r, "property.hoa", "hoa"),
    },
    valuation: {
      estimatedValue: pick(r, "valuation.estimatedValue", "estimate.value", "avm.value"),
      estimatedLow: pick(r, "valuation.low", "estimate.low", "avm.low"),
      estimatedHigh: pick(r, "valuation.high", "estimate.high", "avm.high"),
      confidence: pick(r, "valuation.confidence", "estimate.confidence", "avm.confidence"),
      estimatedEquity: pick(r, "valuation.equity", "equity.amount"),
      equityPercent: pick(r, "valuation.equityPercent", "equity.percent"),
      loanToValue: pick(r, "valuation.ltv", "equity.ltv"),
      pricePerSqft: pick(r, "valuation.pricePerSqft", "estimate.pricePerSqft"),
      rentEstimate: pick(r, "valuation.rentEstimate", "rent.estimate"),
      asOf: pick(r, "valuation.asOf", "estimate.asOf"),
    },
    ownership: {
      occupancy:
        pick(r, "ownership.occupancy", "ownerOccupied") === true
          ? "Owner-occupied"
          : pick(r, "ownership.occupancy", "ownerOccupied") === false
          ? "Absentee owner"
          : pick(r, "ownership.occupancy"),
      lengthOfOwnership: pick(r, "ownership.lengthYears", "ownership.yearsOwned"),
    },
    owners: normalizePeople(pick(r, "owners", "ownership.owners") || [], "Owner"),
    occupants: normalizePeople(
      pick(r, "occupants", "household.members", "residents") || [],
      "Occupant"
    ),
    mortgage: (() => {
      const m: AnyObj = pick(r, "mortgage", "mortgages.0", "loans.0") || {};
      return {
        lender: pick(m, "lender", "lenderName"),
        loanType: pick(m, "loanType", "type"),
        originalAmount: pick(m, "originalAmount", "amount"),
        currentBalance: pick(m, "currentBalance", "balance"),
        interestRate: pick(m, "interestRate", "rate"),
        termYears: pick(m, "termYears", "term"),
        originationDate: pick(m, "originationDate", "originated"),
        maturityDate: pick(m, "maturityDate", "matures"),
        secondLien: pick(m, "secondLien"),
        heloc: pick(m, "heloc"),
        position: pick(m, "position"),
      };
    })(),
    sale: {
      lastSalePrice: pick(r, "sale.lastPrice", "lastSale.price", "sales.0.price"),
      lastSaleDate: pick(r, "sale.lastDate", "lastSale.date", "sales.0.date"),
      priorSalePrice: pick(r, "sale.priorPrice", "sales.1.price"),
      priorSaleDate: pick(r, "sale.priorDate", "sales.1.date"),
    },
    listing: {
      status: pick(r, "listing.status", "mls.status"),
      listPrice: pick(r, "listing.price", "mls.listPrice"),
      listedAt: pick(r, "listing.listedAt", "mls.listDate"),
      daysOnMarket: pick(r, "listing.daysOnMarket", "mls.dom"),
      agent: pick(r, "listing.agent", "mls.agent"),
      brokerage: pick(r, "listing.brokerage", "mls.brokerage"),
    },
    tax: {
      assessedValue: pick(r, "tax.assessedValue", "assessment.total"),
      landValue: pick(r, "tax.landValue", "assessment.land"),
      improvementValue: pick(r, "tax.improvementValue", "assessment.improvement"),
      annualTax: pick(r, "tax.annual", "tax.amount"),
      taxYear: pick(r, "tax.year", "assessment.year"),
      taxRate: pick(r, "tax.rate"),
      exemptions: pick(r, "tax.exemptions"),
      delinquent: pick(r, "tax.delinquent"),
    },
    demographics: {
      medianIncome: pick(r, "demographics.medianIncome", "neighborhood.medianIncome"),
      medianHomeValue: pick(r, "demographics.medianHomeValue", "neighborhood.medianHomeValue"),
      ownerOccupancyPct: pick(r, "demographics.ownerOccupancyPct", "neighborhood.ownerOccupancyPct"),
      avgHouseholdSize: pick(r, "demographics.avgHouseholdSize"),
      medianAge: pick(r, "demographics.medianAge"),
      population: pick(r, "demographics.population"),
      walkScore: pick(r, "demographics.walkScore"),
      schoolDistrict: pick(r, "schools.district"),
      elementarySchool: pick(r, "schools.elementary"),
      middleSchool: pick(r, "schools.middle"),
      highSchool: pick(r, "schools.high"),
    },
    hazards: {
      floodZone: pick(r, "hazards.floodZone", "flood.zone"),
      floodRisk: pick(r, "hazards.floodRisk", "flood.risk"),
      fireRisk: pick(r, "hazards.fireRisk", "wildfire.risk"),
      earthquakeRisk: pick(r, "hazards.earthquakeRisk", "earthquake.risk"),
      stormHistory: pick(r, "hazards.stormHistory"),
      crimeIndex: pick(r, "hazards.crimeIndex", "crime.index"),
    },
    ids: {
      apn: pick(r, "ids.apn", "parcel.apn", "apn"),
      fips: pick(r, "ids.fips", "parcel.fips", "fips"),
      county: pick(r, "ids.county", "parcel.county"),
      censusTract: pick(r, "ids.censusTract", "census.tract"),
      subdivision: pick(r, "ids.subdivision", "parcel.subdivision"),
      legalDescription: pick(r, "ids.legalDescription", "parcel.legalDescription"),
      knockstatId: pick(r, "id", "knockstatId"),
    },
  };
}

// Local sample used by the "Demo data" button (ported from the original HTML).
export const DEMO_RAW: AnyObj = {
  id: "ks_01H8X3Q2ZK2J3M4N5P6QR7S8TU",
  address: {
    line1: "742 Evergreen Terrace",
    city: "Springfield",
    state: "IL",
    zip: "62704",
    latitude: 39.7817,
    longitude: -89.6501,
  },
  property: {
    type: "Single Family",
    subtype: "Detached",
    yearBuilt: 1989,
    bedrooms: 4,
    bathrooms: 2.5,
    livingAreaSqft: 2480,
    lotSizeSqft: 8712,
    stories: 2,
    units: 1,
    garage: "2-car attached",
    pool: "No",
    heating: "Forced air, gas",
    cooling: "Central A/C",
    roof: "Asphalt shingle",
    construction: "Wood frame",
    zoning: "R-1",
    hoa: "None",
  },
  valuation: {
    estimatedValue: 412500,
    low: 398000,
    high: 431000,
    confidence: "High (92%)",
    equity: 188300,
    equityPercent: 45.6,
    ltv: 54.4,
    pricePerSqft: 166,
    rentEstimate: 2350,
    asOf: "2026-04-15",
  },
  ownership: { occupancy: "Owner-occupied", lengthYears: 11 },
  owners: [
    {
      firstName: "Homer",
      lastName: "Simpson",
      entityType: "Individual",
      ageRange: "60-65",
      gender: "M",
      maritalStatus: "Married",
      lengthOfResidence: 11,
      phones: ["+1-555-0142"],
      emails: ["homer@example.com"],
    },
    {
      firstName: "Marge",
      lastName: "Simpson",
      entityType: "Individual",
      ageRange: "55-60",
      gender: "F",
      maritalStatus: "Married",
      lengthOfResidence: 11,
      phones: ["+1-555-0143"],
    },
  ],
  occupants: [
    { firstName: "Bart", lastName: "Simpson", ageRange: "20-25", gender: "M" },
    { firstName: "Lisa", lastName: "Simpson", ageRange: "18-22", gender: "F" },
    { firstName: "Maggie", lastName: "Simpson", ageRange: "10-15", gender: "F" },
  ],
  mortgage: {
    lender: "First Springfield Savings",
    loanType: "Conventional 30-yr fixed",
    originalAmount: 285000,
    currentBalance: 224200,
    interestRate: 4.125,
    termYears: 30,
    originationDate: "2015-06-12",
    maturityDate: "2045-06-12",
    position: "1st",
  },
  sale: { lastPrice: 298000, lastDate: "2015-06-08", priorPrice: 215000, priorDate: "2003-09-22" },
  listing: { status: "Off-market" },
  tax: {
    assessedValue: 372000,
    landValue: 78000,
    improvementValue: 294000,
    annual: 6840,
    year: 2025,
    rate: 1.84,
    exemptions: ["Homestead"],
    delinquent: false,
  },
  demographics: {
    medianIncome: 68450,
    medianHomeValue: 245000,
    ownerOccupancyPct: 71.3,
    avgHouseholdSize: 2.4,
    medianAge: 38,
    population: 116250,
    walkScore: 42,
  },
  schools: {
    district: "Springfield Unified",
    elementary: "Springfield Elementary",
    middle: "Springfield Middle",
    high: "Springfield High",
  },
  hazards: {
    floodZone: "X",
    floodRisk: "Minimal",
    fireRisk: "Low",
    earthquakeRisk: "Very low",
    stormHistory: "3 hail events since 2018",
    crimeIndex: "Below national average",
  },
  ids: {
    apn: "13-22-401-018",
    fips: "17167",
    county: "Sangamon",
    censusTract: "0017.02",
    subdivision: "Evergreen Heights",
    legalDescription: "LOT 18 EVERGREEN HEIGHTS UNIT 2",
  },
};

// Condense a normalized property record into the homeowner fields stored on a
// lead (and the convenience owner name/phone/email shown on the pin).
export function buildEnrichment(rec: PropertyRecord): {
  enrichment: LeadEnrichment;
  ownerName?: string;
  phone?: string;
  email?: string;
} {
  const owners = (rec.owners || []).map((o) => ({
    name: o.name,
    phones: o.phones,
    emails: o.emails,
    ageRange: typeof o.ageRange === "string" ? o.ageRange : undefined,
  }));
  const p = rec.property as AnyObj;
  const v = rec.valuation as AnyObj;
  const s = rec.sale as AnyObj;
  const ids = rec.ids as AnyObj;
  const enrichment: LeadEnrichment = {
    owners,
    propertyType: p.type,
    yearBuilt: p.yearBuilt,
    beds: p.bedrooms,
    baths: p.bathrooms,
    sqft: p.livingAreaSqft,
    lotSqft: p.lotSizeSqft,
    estValue: v.estimatedValue,
    equity: v.estimatedEquity,
    ownerOccupied: rec.ownership?.occupancy ?? undefined,
    lastSalePrice: s.lastSalePrice,
    lastSaleDate: s.lastSaleDate,
    apn: ids?.apn,
  };
  const first = owners[0];
  return {
    enrichment,
    ownerName: first?.name,
    phone: first?.phones?.[0],
    email: first?.emails?.[0],
  };
}

// Call the Knockstat proxy Cloud Function. The browser never sees the API key.
export async function lookupAddress(
  address: string,
  idToken: string
): Promise<AnyObj> {
  const base = import.meta.env.VITE_API_BASE || "/api";
  const res = await fetch(`${base}/knockstat?address=${encodeURIComponent(address)}`, {
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Lookup failed (${res.status})${body ? ": " + body.slice(0, 200) : ""}`);
    (err as any).code = "HTTP_" + res.status;
    throw err;
  }
  return res.json();
}
