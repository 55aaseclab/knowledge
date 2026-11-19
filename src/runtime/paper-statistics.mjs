const paperGroups = ['systems', 'security', 'software-engineering'];
const statuses = ['complete', 'partial', 'pending'];
const venueKey = /^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9][a-zA-Z0-9._-]*)*$/;
const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const count = value => Number.isInteger(value) && value >= 0 && value <= 10_000_000;
function invalid() {
  throw Object.assign(new Error('Invalid conference paper statistics'), { code: 'INVALID_INPUT', status: 400 });
}
function keys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || !names.every(name => Object.hasOwn(value, name))) invalid();
}

export function validatePaperSnapshot(value) {
  const annual = value != null && Object.hasOwn(value, 'year');
  keys(value, ['schemaVersion', 'profile', 'observedAt', 'venues', ...(annual ? ['year'] : [])]);
  if (annual && (!Number.isInteger(value.year) || value.year < 1900 || value.year > 2200)) invalid();
  if (value.schemaVersion !== 1 || value.profile !== 'ccf-a-papers@1' ||
      typeof value.observedAt !== 'string' || !timestamp.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt)) ||
      !Array.isArray(value.venues) || !value.venues.length || value.venues.length > 200) invalid();
  const venues = new Set();
  for (const venue of value.venues) {
    keys(venue, ['venueKey', 'name', 'group', 'archiveStatus', 'editions']);
    if (typeof venue.venueKey !== 'string' || venue.venueKey.length > 120 || !venueKey.test(venue.venueKey) || venues.has(venue.venueKey) ||
        typeof venue.name !== 'string' || venue.name.length > 300 || !venue.name.length || venue.name.trim() !== venue.name || /[\u0000-\u001f\u007f]/.test(venue.name) ||
        !paperGroups.includes(venue.group) || !statuses.includes(venue.archiveStatus) || !Array.isArray(venue.editions) || venue.editions.length > 200) invalid();
    venues.add(venue.venueKey);
    const years = new Set();
    for (const edition of venue.editions) {
      keys(edition, ['year', 'status', 'papers', 'cachedPdfs']);
      if (!Number.isInteger(edition.year) || edition.year < 1900 || edition.year > 2200 || years.has(edition.year) || (annual && edition.year !== value.year) ||
          !statuses.includes(edition.status) || !count(edition.papers) || !count(edition.cachedPdfs) || edition.cachedPdfs > edition.papers ||
          (edition.status === 'pending' && edition.papers !== 0)) invalid();
      years.add(edition.year);
    }
  }
  return value;
}

// A partial pass can report fewer papers after a source failure. Keep an
// actual observed pair of counts and its timestamp instead of adding runs.
export function mergePaperStatistics(previous, snapshot) {
  const prior = new Map(previous?.venues.map(venue => [venue.venueKey, venue]));
  const current = new Map(snapshot.venues.map(venue => [venue.venueKey, venue]));
  const venues = [];
  for (const key of new Set([...current.keys(), ...prior.keys()])) {
    const last = prior.get(key), next = current.get(key);
    const oldYears = new Map(last?.editions.map(edition => [edition.year, edition]));
    const newYears = new Map(next?.editions.map(edition => [edition.year, edition]));
    const editions = [];
    for (const year of new Set([...newYears.keys(), ...oldYears.keys()])) {
      const old = oldYears.get(year), fresh = newYears.get(year);
      const priorCount = old && (old.status !== 'pending' || old.countsObservedAt);
      if (!fresh && snapshot.year !== undefined) {
        editions.push(priorCount ? { ...old, countsObservedAt: old.countsObservedAt ?? previous.observedAt } : { ...old });
        continue;
      }
      if (!fresh && next?.archiveStatus === 'complete') continue;
      if (priorCount && (!fresh || (fresh.status !== 'complete' && (fresh.status === 'pending' || fresh.papers < old.papers || fresh.cachedPdfs < old.cachedPdfs)))) {
        editions.push({ ...old, status: fresh?.status ?? 'pending', countsObservedAt: old.countsObservedAt ?? previous.observedAt });
      } else {
        editions.push(fresh ? { ...fresh } : { year, status: 'pending', papers: 0, cachedPdfs: 0 });
      }
    }
    editions.sort((a, b) => b.year - a.year);
    venues.push({ venueKey: key, name: next?.name ?? last.name, group: next?.group ?? last.group, archiveStatus: (snapshot.year === undefined ? next : last)?.archiveStatus ?? 'pending', editions });
  }
  venues.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  return { schemaVersion: snapshot.schemaVersion, profile: snapshot.profile, observedAt: snapshot.observedAt, venues };
}
