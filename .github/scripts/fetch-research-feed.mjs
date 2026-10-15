// Fetches PubMed publication metadata and ClinicalTrials.gov study updates
// and writes a validated static JSON feed to feed/research.json.
// No API key required — uses public E-utilities and CT.gov v2 endpoints.

import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FEED_PATH = join(__dirname, '..', '..', 'feed', 'research.json');
const MAX_ITEMS = 50;
const FETCH_TIMEOUT = 15_000;

const PUBMED_QUERIES = [
  '("GLP-1 receptor agonist" OR semaglutide OR tirzepatide OR retatrutide OR orforglipron) AND (obesity OR "weight loss" OR diabetes)',
  '("BPC-157" OR "body protection compound") AND (peptide OR therapeutic)',
  '("growth hormone releasing peptide" OR GHRP OR ipamorelin OR sermorelin OR tesamorelin) AND (clinical OR therapeutic)',
  '(peptide AND compounding AND pharmacy) OR (peptide AND "FDA regulation")',
];

const CT_QUERY = '(GLP-1 OR semaglutide OR tirzepatide OR retatrutide OR BPC-157 OR peptide therapeutic)';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithTimeout(url, timeoutMs = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function isValidHttpsUrl(str) {
  try {
    const u = new URL(str);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function toIsoDate(str) {
  if (!str) return '';
  const match = str.match(/^(\d{4})(?:\/(\d{2}))?(?:\/(\d{2}))?/);
  if (!match) return '';
  const [, y, m, d] = match;
  return `${y}-${m || '01'}-${d || '01'}`;
}

// --- PubMed E-utilities ---

async function searchPubMed(query, maxResults = 25) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(maxResults),
    sort: 'date',
    retmode: 'json',
  });
  const res = await fetchWithTimeout(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?${params}`);
  const data = await res.json();
  return data?.esearchresult?.idlist || [];
}

async function fetchPubMedSummaries(ids) {
  if (!ids.length) return [];
  const params = new URLSearchParams({
    db: 'pubmed',
    id: ids.join(','),
    retmode: 'json',
  });
  const res = await fetchWithTimeout(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?${params}`);
  const data = await res.json();
  const result = data?.result;
  if (!result) return [];

  return ids
    .map((id) => {
      const rec = result[id];
      if (!rec || rec.error) return null;
      const authors = (rec.authors || []).map((a) => a.name).slice(0, 5).join(', ');
      const date = toIsoDate(rec.sortpubdate || rec.pubdate || '');
      const url = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
      return {
        id: `pmid:${id}`,
        source: 'PubMed',
        title: rec.title || '',
        authors,
        journal: rec.fulljournalname || rec.source || '',
        date,
        url,
        summary: rec.sorttitle || rec.title || '',
      };
    })
    .filter(Boolean);
}

async function fetchAllPubMed() {
  const allIds = new Set();
  for (const query of PUBMED_QUERIES) {
    try {
      const ids = await searchPubMed(query, 15);
      ids.forEach((id) => allIds.add(id));
      await sleep(400);
    } catch (err) {
      console.warn(`PubMed search failed for query: ${err.message}`);
    }
  }
  const uniqueIds = [...allIds].slice(0, MAX_ITEMS);
  if (!uniqueIds.length) return [];

  const batches = [];
  for (let i = 0; i < uniqueIds.length; i += 20) {
    batches.push(uniqueIds.slice(i, i + 20));
  }

  const results = [];
  for (const batch of batches) {
    try {
      const summaries = await fetchPubMedSummaries(batch);
      results.push(...summaries);
      await sleep(400);
    } catch (err) {
      console.warn(`PubMed summary fetch failed: ${err.message}`);
    }
  }
  return results;
}

// --- ClinicalTrials.gov v2 ---

async function fetchClinicalTrials() {
  const params = new URLSearchParams({
    'query.cond': CT_QUERY,
    'filter.overallStatus': 'RECRUITING,ACTIVE_NOT_RECRUITING',
    sort: 'LastUpdatePostDate',
    pageSize: String(MAX_ITEMS),
    format: 'json',
    fields: 'NCTId,BriefTitle,OverallStatus,Phase,LastUpdatePostDate,BriefSummary',
  });

  try {
    const res = await fetchWithTimeout(`https://clinicaltrials.gov/api/v2/studies?${params}`);
    const data = await res.json();
    const studies = data?.studies || [];

    return studies.map((study) => {
      const proto = study.protocolSection || {};
      const ident = proto.identificationModule || {};
      const status = proto.statusModule || {};
      const design = proto.designModule || {};
      const desc = proto.descriptionModule || {};

      const nctId = ident.nctId || '';
      const phases = (design.phases || []).join(', ') || 'Not specified';
      const lastUpdate = status.lastUpdatePostDateStruct?.date || '';

      return {
        id: nctId,
        source: 'ClinicalTrials.gov',
        title: ident.briefTitle || '',
        status: status.overallStatus || '',
        phase: phases,
        date: toIsoDate(lastUpdate.replace(/-/g, '/')) || toIsoDate(lastUpdate),
        url: `https://clinicaltrials.gov/study/${nctId}`,
        summary: (desc.briefSummary || '').slice(0, 500),
      };
    }).filter((t) => t.id && t.title);
  } catch (err) {
    console.warn(`ClinicalTrials.gov fetch failed: ${err.message}`);
    return [];
  }
}

// --- Main ---

function readExistingFeed() {
  try {
    return JSON.parse(readFileSync(FEED_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

async function main() {
  const existing = readExistingFeed();
  const prevPublications = existing && Array.isArray(existing.publications) ? existing.publications : [];
  const prevTrials = existing && Array.isArray(existing.trials) ? existing.trials : [];
  const prevArchive = existing && Array.isArray(existing.archive) ? existing.archive : [];

  console.log('Fetching PubMed publications...');
  const publications = await fetchAllPubMed();
  console.log(`  Found ${publications.length} publications`);
  const usePubs = publications.length > 0 ? publications : prevPublications;
  if (publications.length === 0 && prevPublications.length > 0) {
    console.warn('  PubMed returned no results; preserving previous publications');
  }

  console.log('Fetching ClinicalTrials.gov studies...');
  const trials = await fetchClinicalTrials();
  console.log(`  Found ${trials.length} trials`);
  const useTrials = trials.length > 0 ? trials : prevTrials;
  if (trials.length === 0 && prevTrials.length > 0) {
    console.warn('  ClinicalTrials.gov returned no results; preserving previous trials');
  }

  const seen = new Set();
  const dedupe = (items) =>
    items.filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      if (item.url && !isValidHttpsUrl(item.url)) return false;
      seen.add(item.id);
      return true;
    });

  const now = new Date().toISOString();
  const pubsFresh = publications.length > 0;
  const trialsFresh = trials.length > 0;

  const feed = {
    version: 1,
    generatedAt: now,
    publicationsFetchedAt: pubsFresh ? now : (existing?.publicationsFetchedAt || now),
    trialsFetchedAt: trialsFresh ? now : (existing?.trialsFetchedAt || now),
    publications: dedupe(usePubs).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    trials: dedupe(useTrials).sort((a, b) => (b.date || '').localeCompare(a.date || '')),
    archive: dedupe(prevArchive),
  };

  writeFileSync(FEED_PATH, JSON.stringify(feed, null, 2) + '\n');
  console.log(`Feed written to ${FEED_PATH}`);
  console.log(`  ${feed.publications.length} publications, ${feed.trials.length} trials, ${feed.archive.length} archive items`);
}

main().catch((err) => {
  console.error('Feed generation failed:', err);
  process.exit(1);
});
