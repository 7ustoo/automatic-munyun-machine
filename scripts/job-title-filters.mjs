// Built-in, opt-in job-title categories. Keep this pure so title matching can
// be regression-tested without starting the scraper or reading user state.

const MANAGEMENT_RX = [
  /\b(?:manager|management|supervisor|director)\b/i,
  /\bhead\s+of\b/i,
  /\bchief\b/i,
  /\b(?:vice\s+president|president|v\.?p\.?)\b/i,
  /\b(?:team|tech(?:nical)?|engineering|software|data|security|platform|infrastructure|devops|cloud|product|program|project|design|qa)\s+lead\b/i,
  /\blead\s+(?:(?:software|data|security|platform|infrastructure|devops|cloud|product|program|project|design|qa)\s+)?(?:engineer|developer|architect|analyst|administrator|designer|scientist|consultant|specialist|technician)\b/i
];

const SALES_RX = [
  /\bsales\b/i,
  /\baccount\s+(?:executive|manager|representative)\b/i,
  /\bbusiness\s+development\b/i,
  /\b(?:sales|business)\s+development\s+representative\b/i,
  /\b(?:sdr|bdr)\b/i,
  /\bclient\s+executive\b/i,
  /\blead\s+generation\b/i,
  /\bcustomer\s+success\b/i,
  /\brevenue\s+(?:operations|enablement)\b/i
];

export function isManagementTitle(title) {
  const value = String(title || '').trim();
  return !!value && MANAGEMENT_RX.some(rx => rx.test(value));
}

export function isSalesTitle(title) {
  const value = String(title || '').trim();
  return !!value && SALES_RX.some(rx => rx.test(value));
}

export function excludedTitleCategory(title, filters = {}) {
  if (filters.filterManagementTitles === true && isManagementTitle(title)) return 'management';
  if (filters.filterSalesTitles === true && isSalesTitle(title)) return 'sales';
  return null;
}
