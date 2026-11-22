// LeadScout — designation → category / priority / score engine.
// Encodes the B2B decision-maker designations from the research brief, ordered
// most-specific first (the first matching rule wins).

// Each rule: { re, cat, pri, sc }  cat=category, pri=P1..P5, sc=base score
const RULES = [
  // ---- C-suite / founders -------------------------------------------------
  { re: /\b(co-?founder|founder)\b/i, cat: 'C-Suite', pri: 1, sc: 100 },
  { re: /\bceo\b|chief executive/i, cat: 'C-Suite', pri: 1, sc: 100 },
  { re: /\bcto\b|chief technology/i, cat: 'C-Suite', pri: 1, sc: 98 },
  { re: /\bcio\b|chief information/i, cat: 'C-Suite', pri: 1, sc: 96 },
  { re: /\bcdo\b|chief digital/i, cat: 'C-Suite', pri: 1, sc: 96 },
  { re: /\bcai?o\b|chief ai\b|chief artificial intelligence/i, cat: 'C-Suite', pri: 1, sc: 97 },
  { re: /chief innovation/i, cat: 'C-Suite', pri: 1, sc: 95 },
  { re: /\bcpo\b|chief product/i, cat: 'C-Suite', pri: 1, sc: 95 },
  { re: /\bcoo\b|chief operating/i, cat: 'C-Suite', pri: 1, sc: 94 },
  { re: /\bciso\b|chief information security|chief security|head of (information )?security/i, cat: 'Security', pri: 1, sc: 92 },
  { re: /\bcfo\b|chief financial/i, cat: 'C-Suite', pri: 2, sc: 85 },
  { re: /\bpresident\b/i, cat: 'C-Suite', pri: 1, sc: 93 },
  { re: /\bowner\b/i, cat: 'C-Suite', pri: 1, sc: 90 },
  { re: /\bmanaging director\b|\bmd\b/i, cat: 'C-Suite', pri: 2, sc: 88 },

  // ---- AI & automation ----------------------------------------------------
  { re: /\b(vp|vice president|director|head)\b[^;]{0,60}\bai\b|head of (ai|artificial intelligence)/i, cat: 'AI & Automation', pri: 1, sc: 94 },
  { re: /\bhead of (generative ai|gen ?ai)\b/i, cat: 'AI & Automation', pri: 1, sc: 93 },
  { re: /\bhead of machine learning|\bhead of (ml|ml engineering)\b|\bmachine learning (lead|head)\b/i, cat: 'AI & Automation', pri: 2, sc: 90 },
  { re: /\bhead of (intelligent automation|automation)\b/i, cat: 'AI & Automation', pri: 2, sc: 88 },
  { re: /\bhead of ai (engineering|strategy|transformation)\b|\bai (strategy|transformation) (lead|head|director)\b/i, cat: 'AI & Automation', pri: 2, sc: 90 },
  { re: /\b(vp|vice president|director)\b[^;]{0,40}\b(machine learning|data science)\b/i, cat: 'AI & Automation', pri: 2, sc: 88 },
  { re: /\bchief data|head of data\b|\b(cdo)\b(?![a-z])/i, cat: 'AI & Automation', pri: 2, sc: 86 },
  { re: /\b(ai|gen ?ai|llm) (lead|engineer|architect)\b/i, cat: 'AI & Automation', pri: 3, sc: 76 },

  // ---- Product ------------------------------------------------------------
  { re: /\b(vp|vice president|director|head)\b[^;]{0,60}\bproduct\b/i, cat: 'Product', pri: 2, sc: 92 },
  { re: /\bhead of product (management|innovation)\b/i, cat: 'Product', pri: 2, sc: 91 },
  { re: /\bhead of product\b/i, cat: 'Product', pri: 2, sc: 92 },
  { re: /\bproduct (director|lead)\b/i, cat: 'Product', pri: 3, sc: 80 },
  { re: /\bsenior (product )?manager, product\b|product manager\b/i, cat: 'Product', pri: 4, sc: 62 },

  // ---- Engineering --------------------------------------------------------
  { re: /\b(vp|vice president|director|head)\b[^;]{0,60}\b(engineering|software development|technology)\b/i, cat: 'Engineering', pri: 2, sc: 93 },
  { re: /\bhead of (engineering|software development|technology)\b/i, cat: 'Engineering', pri: 2, sc: 92 },
  { re: /\bhead of (platform|cloud|devops|sre)\b/i, cat: 'Engineering', pri: 2, sc: 86 },
  { re: /\b(chief|head of) architect|chief architect/i, cat: 'Engineering', pri: 2, sc: 88 },
  { re: /\bengineer(ing)? (manager|director|lead)\b/i, cat: 'Engineering', pri: 3, sc: 74 },
  { re: /\bsenior software (engineer|developer)\b/i, cat: 'Engineering', pri: 5, sc: 40 },

  // ---- Digital transformation & IT ---------------------------------------
  { re: /\b(vp|vice president|director|head)\b[^;]{0,60}\bdigital\b/i, cat: 'Digital & IT', pri: 2, sc: 90 },
  { re: /\bhead of digital transformation\b|digital transformation (lead|head|director)\b/i, cat: 'Digital & IT', pri: 2, sc: 90 },
  { re: /\b(vp|vice president|director|head)\b[^;]{0,40}\bit\b|head of information technology/i, cat: 'Digital & IT', pri: 2, sc: 86 },
  { re: /\bit (director|head|manager)\b/i, cat: 'Digital & IT', pri: 3, sc: 76 },
  { re: /\bhead of technology innovation\b|technology innovation (lead|head)\b/i, cat: 'Digital & IT', pri: 2, sc: 88 },

  // ---- Innovation / R&D ---------------------------------------------------
  { re: /\bdirector of r&d|head of (r&d|research and development|research)\b|\br&d (director|head|lead)\b/i, cat: 'Innovation / R&D', pri: 2, sc: 87 },
  { re: /\b(vp|director|head)\b[^;]{0,40}\binnovation\b/i, cat: 'Innovation / R&D', pri: 2, sc: 86 },

  // ---- Generic leaders (catch-all, lower) ---------------------------------
  { re: /\b(vp|vice president)\b/i, cat: 'Other', pri: 3, sc: 70 },
  { re: /\bdirector\b/i, cat: 'Other', pri: 3, sc: 68 },
  { re: /\bhead\b/i, cat: 'Other', pri: 3, sc: 66 },
  { re: /\bgeneral manager\b|\bgm\b/i, cat: 'Other', pri: 4, sc: 55 },
  { re: /\blead\b/i, cat: 'Other', pri: 4, sc: 50 },
  { re: /\bpartner\b/i, cat: 'Other', pri: 4, sc: 50 },
  { re: /\bmanager\b/i, cat: 'Other', pri: 5, sc: 42 }
];

/**
 * Classify a designation string.
 * @returns {{cat:string, pri:number, sc:number}|null}
 */
export function classifyDesignation(designation) {
  const d = String(designation || '');
  for (const r of RULES) {
    if (r.re.test(d)) return { cat: r.cat, pri: r.pri, sc: r.sc };
  }
  return { cat: 'Other', pri: 5, sc: 30 };
}

/** Seniority word bonus added to the score. */
export function seniorityBonus(designation) {
  const d = String(designation || '').toLowerCase();
  let b = 0;
  if (/\b(chief|global|group|enterprise)\b/.test(d)) b += 4;
  if (/\b(vp|vice president|senior|sr\.?)\b/.test(d)) b += 3;
  if (/\b(head|director)\b/.test(d)) b += 2;
  return b;
}

export const PRIORITY_LABELS = { 1: 'P1', 2: 'P2', 3: 'P3', 4: 'P4', 5: 'P5' };

export function priorityLabel(pri) {
  return PRIORITY_LABELS[pri] || 'P5';
}

export const FILTER_CATEGORIES = ['C-Suite', 'AI & Automation', 'Product', 'Engineering',
  'Digital & IT', 'Innovation / R&D', 'Security', 'Other'];
