/**
 * Hashline-anchored line hashing for zero-text-reproduction editing.
 *
 * Mirrors Pi-SmartEdit's hashline algorithm for compatibility.
 *
 * Each line is tagged with a short BPE-single-token hash (LINE+ID, e.g. "42ab").
 * Edits reference anchors instead of reproducing text. Hashes serve as
 * freshness checks — if the file changed since the last read, hashes won't
 * match and the edit is rejected before any mutation.
 *
 * Algorithm: xxHash32(line_content, seed) % 672 → bigram lookup
 */

// ─── Bigram table ────────────────────────────────────────────────────────────

/**
 * 672 single-token BPE bigrams — every two-letter pair from aa..zz
 * except 4 exclusions: xz, zy, zz, qz.
 *
 * Order is stable forever — changing it would invalidate saved anchors.
 * Must match Pi-SmartEdit's bigram table exactly.
 */
export const HASHLINE_BIGRAMS = [
  // aa..az (26)
  "aa","ab","ac","ad","ae","af","ag","ah","ai","aj","ak","al","am","an","ao",
  "ap","aq","ar","as","at","au","av","aw","ax","ay","az",
  // ba..bz (26)
  "ba","bb","bc","bd","be","bf","bg","bh","bi","bj","bk","bl","bm","bn","bo",
  "bp","bq","br","bs","bt","bu","bv","bw","bx","by","bz",
  // ca..cz (26)
  "ca","cb","cc","cd","ce","cf","cg","ch","ci","cj","ck","cl","cm","cn","co",
  "cp","cq","cr","cs","ct","cu","cv","cw","cx","cy","cz",
  // da..dz (26)
  "da","db","dc","dd","de","df","dg","dh","di","dj","dk","dl","dm","dn","do",
  "dp","dq","dr","ds","dt","du","dv","dw","dx","dy","dz",
  // ea..ez (26)
  "ea","eb","ec","ed","ee","ef","eg","eh","ei","ej","ek","el","em","en","eo",
  "ep","eq","er","es","et","eu","ev","ew","ex","ey","ez",
  // fa..fz (26)
  "fa","fb","fc","fd","fe","ff","fg","fh","fi","fj","fk","fl","fm","fn","fo",
  "fp","fq","fr","fs","ft","fu","fv","fw","fx","fy","fz",
  // ga..gz (26)
  "ga","gb","gc","gd","ge","gf","gg","gh","gi","gj","gk","gl","gm","gn","go",
  "gp","gq","gr","gs","gt","gu","gv","gw","gx","gy","gz",
  // ha..hz (26)
  "ha","hb","hc","hd","he","hf","hg","hh","hi","hj","hk","hl","hm","hn","ho",
  "hp","hq","hr","hs","ht","hu","hv","hw","hx","hy","hz",
  // ia..iz (26)
  "ia","ib","ic","id","ie","if","ig","ih","ii","ij","ik","il","im","in","io",
  "ip","iq","ir","is","it","iu","iv","iw","ix","iy","iz",
  // ja..jz (26)
  "ja","jb","jc","jd","je","jf","jg","jh","ji","jj","jk","jl","jm","jn","jo",
  "jp","jq","jr","js","jt","ju","jv","jw","jx","jy","jz",
  // ka..kz (26)
  "ka","kb","kc","kd","ke","kf","kg","kh","ki","kj","kk","kl","km","kn","ko",
  "kp","kq","kr","ks","kt","ku","kv","kw","kx","ky","kz",
  // la..lz (26)
  "la","lb","lc","ld","le","lf","lg","lh","li","lj","lk","ll","lm","ln","lo",
  "lp","lq","lr","ls","lt","lu","lv","lw","lx","ly","lz",
  // ma..mz (26)
  "ma","mb","mc","md","me","mf","mg","mh","mi","mj","mk","ml","mm","mn","mo",
  "mp","mq","mr","ms","mt","mu","mv","mw","mx","my","mz",
  // na..nz (26)
  "na","nb","nc","nd","ne","nf","ng","nh","ni","nj","nk","nl","nm","nn","no",
  "np","nq","nr","ns","nt","nu","nv","nw","nx","ny","nz",
  // oa..oz (26)
  "oa","ob","oc","od","oe","of","og","oh","oi","oj","ok","ol","om","on","oo",
  "op","oq","or","os","ot","ou","ov","ow","ox","oy","oz",
  // pa..pz (26)
  "pa","pb","pc","pd","pe","pf","pg","ph","pi","pj","pk","pl","pm","pn","po",
  "pp","pq","pr","ps","pt","pu","pv","pw","px","py","pz",
  // qa..qz (26, but qz excluded)
  "qa","qb","qc","qd","qe","qf","qg","qh","qi","qj","qk","ql","qm","qn","qo",
  "qp","qq","qr","qs","qt","qu","qv","qw","qx","qy",
  // ra..rz (26)
  "ra","rb","rc","rd","re","rf","rg","rh","ri","rj","rk","rl","rm","rn","ro",
  "rp","rq","rr","rs","rt","ru","rv","rw","rx","ry","rz",
  // sa..sz (26)
  "sa","sb","sc","sd","se","sf","sg","sh","si","sj","sk","sl","sm","sn","so",
  "sp","sq","sr","ss","st","su","sv","sw","sx","sy","sz",
  // ta..tz (26)
  "ta","tb","tc","td","te","tf","tg","th","ti","tj","tk","tl","tm","tn","to",
  "tp","tq","tr","ts","tt","tu","tv","tw","tx","ty","tz",
  // ua..uz (26)
  "ua","ub","uc","ud","ue","uf","ug","uh","ui","uj","uk","ul","um","un","uo",
  "up","uq","ur","us","ut","uu","uv","uw","ux","uy","uz",
  // va..vz (26)
  "va","vb","vc","vd","ve","vf","vg","vh","vi","vj","vk","vl","vm","vn","vo",
  "vp","vq","vr","vs","vt","vu","vv","vw","vx","vy","vz",
  // wa..wz (26)
  "wa","wb","wc","wd","we","wf","wg","wh","wi","wj","wk","wl","wm","wn","wo",
  "wp","wq","wr","ws","wt","wu","wv","ww","wx","wy","wz",
  // xa..xz (26, but xz excluded)
  "xa","xb","xc","xd","xe","xf","xg","xh","xi","xj","xk","xl","xm","xn","xo",
  "xp","xq","xr","xs","xt","xu","xv","xw","xx","xy",
  // ya..yz (26)
  "ya","yb","yc","yd","ye","yf","yg","yh","yi","yj","yk","yl","ym","yn","yo",
  "yp","yq","yr","ys","yt","yu","yv","yw","yx","yy","yz",
  // za..zy (26, but zy and zz excluded)
  "za","zb","zc","zd","ze","zf","zg","zh","zi","zj","zk","zl","zm","zn","zo",
  "zp","zq","zr","zs","zt","zu","zv","zw","zx",
] as const;

export const HASHLINE_BIGRAMS_COUNT = 672;
export const HASHLINE_CONTENT_SEPARATOR = "|";

// ─── xxHash32 (lazy-init, shared singleton) ────────────────────────────────

let _xxhash32: ((input: string, seed?: number) => number) | null = null;
let _initPromise: Promise<void> | null = null;

async function ensureXXHash32(): Promise<(input: string, seed?: number) => number> {
  if (_xxhash32) return _xxhash32;
  if (_initPromise) {
    await _initPromise;
    if (_xxhash32) return _xxhash32;
    throw new Error("xxhash32 initialization failed");
  }

  _initPromise = (async () => {
    const xxhashModule = await import("xxhash-wasm") as {
      default: () => Promise<{
        h32: (input: string, seed?: number) => number;
        h32ToString: (input: string, seed?: number) => string;
      }>;
    };
    const xxhash = await xxhashModule.default();
    _xxhash32 = (input: string, seed = 0) => xxhash.h32(input, seed);
  })();

  await _initPromise;
  if (!_xxhash32) throw new Error("xxhash32 initialization failed");
  return _xxhash32;
}

/**
 * Pre-initialize xxHash32. Call at startup to avoid async cost on first hash.
 * Idempotent — multiple calls are safe.
 */
export async function initHashline(): Promise<void> {
  await ensureXXHash32();
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns true if line contains any letter or digit (ASCII fast path).
 */
function hasSignificantChar(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (
      (c >= 48 && c <= 57) ||  // 0-9
      (c >= 65 && c <= 90) ||  // A-Z
      (c >= 97 && c <= 122)    // a-z
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if line contains only whitespace and braces ({ }).
 */
function isStructural(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (
      c !== 32   // space
      && c !== 9  // tab
      && c !== 123 // {
      && c !== 125 // }
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Ordinal bigram for structural lines (1st, 2nd, 3rd, 4th, …).
 */
function structuralBigram(lineNumber: number): string {
  const mod100 = lineNumber % 100;
  if (mod100 >= 11 && mod100 <= 13) return "th";
  switch (lineNumber % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Compute a single-token BPE bigram hash for a single line.
 *
 * Mirrors Pi-SmartEdit's computeLineHashSync exactly.
 *
 * @param lineNumber 1-based line number
 * @param line       Line content (no trailing newline)
 */
export function computeLineHashSync(
  lineNumber: number,
  line: string,
): string {
  if (!_xxhash32) {
    throw new Error(
      "xxHash32 not initialized. Call initHashline() before using hashline functions.",
    );
  }

  const normalized = line.replace(/\r/g, "").trimEnd();

  // Structural lines → ordinal bigram
  if (isStructural(normalized)) {
    return structuralBigram(lineNumber);
  }

  let seed = 0;
  if (!hasSignificantChar(normalized)) {
    seed = lineNumber;
  }

  const hash = _xxhash32(normalized, seed) % HASHLINE_BIGRAMS_COUNT;
  return HASHLINE_BIGRAMS[hash]!;
}

/**
 * Compute a single-token BPE bigram hash (async, self-initializing).
 */
export async function computeLineHash(
  lineNumber: number,
  line: string,
): Promise<string> {
  await ensureXXHash32();
  return computeLineHashSync(lineNumber, line);
}

/**
 * Format a LINE+ID anchor string (e.g., "42ab").
 */
export function formatLineHash(lineNumber: number, text: string): string {
  return `${lineNumber}${computeLineHashSync(lineNumber, text)}`;
}

/**
 * Format a full hashline: "42ab|function hello() {"
 */
export function formatHashLine(lineNumber: number, line: string): string {
  return `${lineNumber}${computeLineHashSync(lineNumber, line)}${HASHLINE_CONTENT_SEPARATOR}${line}`;
}

/**
 * Build anchor map + formatted lines for a file.
 * Returns both a lookup map and the pre-formatted lines.
 *
 * @param offset 1-based line number of the first element in `lines`.
 *        Default 1 (full file). Pass read offset for offset/limit reads
 *        so anchors use absolute line numbers.
 */
export async function buildHashlineAnchors(
  lines: string[],
  offset = 1,
): Promise<{
  anchors: Map<string, { text: string; line: number }>;
  formattedLines: string[];
}> {
  await ensureXXHash32();
  const anchors = new Map<string, { text: string; line: number }>();
  const formattedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + offset;
    const text = lines[i] ?? "";
    const hash = computeLineHashSync(lineNum, text);
    const anchor = `${lineNum}${hash}`;
    anchors.set(anchor, { text, line: lineNum });
    formattedLines.push(`${anchor}${HASHLINE_CONTENT_SEPARATOR}${text}`);
  }

  return { anchors, formattedLines };
}
