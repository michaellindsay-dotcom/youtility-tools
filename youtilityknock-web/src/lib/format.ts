// Formatting helpers ported from canvass-pro.html.

export const fmtCurrency = (n: unknown): string | null =>
  n == null || n === ""
    ? null
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(Number(n));

export const fmtNumber = (n: unknown): string | null =>
  n == null || n === "" ? null : new Intl.NumberFormat("en-US").format(Number(n));

export const fmtDate = (d: unknown): string | null => {
  if (!d) return null;
  const dt = new Date(d as string);
  return isNaN(dt.getTime())
    ? String(d)
    : dt.toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
};

export const fmtPercent = (p: unknown): string | null =>
  p == null || p === "" ? null : `${Number(p).toFixed(Number(p) < 1 ? 2 : 1)}%`;

export const yearsAgo = (d: unknown): string | null => {
  if (!d) return null;
  const dt = new Date(d as string);
  if (isNaN(dt.getTime())) return null;
  const years = (Date.now() - dt.getTime()) / (365.25 * 24 * 3600 * 1000);
  return years < 1 ? "<1 yr ago" : `${years.toFixed(0)} yr ago`;
};
