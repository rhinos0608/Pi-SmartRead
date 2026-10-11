// Temporary diagnostic: native Windows git-archive UTF-8 + dir-symlink contrasts.
// Header PAX absence below is stated characterization, not product policy.
// Native extraction controls are UNVERIFIED off win32; portable scans run everywhere.
import { spawnSync } from "node:child_process";
import {
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readlinkSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 1_048_576;
const BLOCK = 512;
const SCAN_CAP = 1_048_576;
// Precomposed e-acute via code point so no source encoding can decompose it.
const UNI = `caf${String.fromCodePoint(0xe9)}.ts`;
const UTF8_TAR_OPTIONS = ["--options", "tar:hdrcharset=UTF-8"];
const IS_WIN = process.platform === "win32";

const roots: string[] = [];
afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    roots.push(dir);
    return dir;
}

function codeOf(error: unknown): string {
    if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") return error.code;
    return "unknown";
}

function gitText(args: string[], cwd: string): string {
    const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (res.error !== undefined || res.status !== 0) throw new Error("probe git step failed");
    return String(res.stdout).trim();
}

/** Synthetic local git fixture; the link target is the only variation. */
function fixture(linkTarget: string): { work: string; sha: string } {
    const work = tempRoot("win-arch-fix-");
    mkdirSync(join(work, "sub"), { recursive: true });
    writeFileSync(join(work, UNI), "hello\n");
    writeFileSync(join(work, "sub", "file.txt"), "ascii\n");
    symlinkSync(linkTarget, join(work, "dirlink"));
    gitText(["init"], work);
    gitText(["-c", "user.email=t@t", "-c", "user.name=t", "add", "."], work);
    gitText(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], work);
    return { work, sha: gitText(["rev-parse", "HEAD"], work) };
}

function archiveOf(work: string, sha: string): Buffer {
    const res = spawnSync("git", ["archive", sha], { cwd: work, encoding: "buffer", timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (res.error !== undefined || res.status !== 0) throw new Error("probe git archive failed");
    return res.stdout;
}

type Hdr = { utf8Name: boolean; paxPath: boolean; hdrcharset: boolean; libSymlinkType: boolean; link: string; linkBeforeDir: boolean };

function isZero(block: Buffer): boolean {
    return block.every((byte) => byte === 0);
}

function fieldBytes(head: Buffer, start: number, length: number): Buffer {
    const raw = head.subarray(start, start + length);
    const nul = raw.indexOf(0);
    return nul < 0 ? raw : raw.subarray(0, nul);
}

function entrySize(head: Buffer): number | null {
    const raw = head.subarray(124, 136);
    const nul = raw.indexOf(0);
    const text = raw.subarray(0, nul < 0 ? raw.length : nul).toString("ascii").trim();
    if (text === "") return 0;
    if (!/^[0-7]+$/.test(text)) return null;
    const size = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(size) || size < 0 || size > SCAN_CAP) return null;
    return size;
}

type ParsedHeader = { type: number; size: number; name: string; target: string };

function parseHeader(head: Buffer): ParsedHeader | null {
    if (head.subarray(257, 262).toString("ascii") !== "ustar") return null;
    const size = entrySize(head);
    if (size === null) return null;
    const type = head[156];
    if (type === undefined) return null;
    const prefix = fieldBytes(head, 345, 155).toString("utf8");
    const name = fieldBytes(head, 0, 100).toString("utf8");
    return { type, size, name: prefix.length > 0 ? `${prefix}/${name}` : name, target: fieldBytes(head, 157, 100).toString("ascii") };
}

function notePaxBody(body: Buffer, out: Hdr): void {
    if (body.includes(Buffer.from("path=", "ascii"))) out.paxPath = true;
    if (body.includes(Buffer.from("hdrcharset", "ascii"))) out.hdrcharset = true;
    if (body.includes(Buffer.from("LIBARCHIVE.symlinktype", "ascii"))) out.libSymlinkType = true;
}

type WalkState = { seq: number; linkSeq: number; dirSeq: number };

function noteEntry(parsed: ParsedHeader, payload: Buffer, out: Hdr, want: Buffer, state: WalkState): void {
    if (parsed.type === 0x67 || parsed.type === 0x78) notePaxBody(payload, out);
    else if (Buffer.from(parsed.name, "utf8").includes(want)) out.utf8Name = true;
    if (parsed.type === 0x32) {
        if (parsed.target === "sub") out.link = "sub";
        else if (parsed.target === "sub/") out.link = "sub-slash";
        if (state.linkSeq < 0) state.linkSeq = state.seq;
    }
    if (parsed.type === 0x35 && state.dirSeq < 0) state.dirSeq = state.seq;
}

// Entry-walking scan: each header advances past its own payload, so payload
// bytes are never read as headers. Malformed or over-cap input stops closed.
function scan(archive: Buffer): Hdr {
    const out: Hdr = { utf8Name: false, paxPath: false, hdrcharset: false, libSymlinkType: false, link: "unknown", linkBeforeDir: false };
    if (archive.length > SCAN_CAP) return out;
    const want = Buffer.from(UNI, "utf8");
    const state: WalkState = { seq: 0, linkSeq: -1, dirSeq: -1 };
    let offset = 0;
    while (offset + BLOCK <= archive.length) {
        const head = archive.subarray(offset, offset + BLOCK);
        if (isZero(head)) break;
        const parsed = parseHeader(head);
        if (parsed === null) break;
        const dataStart = offset + BLOCK;
        if (dataStart + parsed.size > archive.length) break;
        noteEntry(parsed, archive.subarray(dataStart, dataStart + parsed.size), out, want, state);
        state.seq += 1;
        offset = dataStart + Math.ceil(parsed.size / BLOCK) * BLOCK;
    }
    out.linkBeforeDir = state.linkSeq >= 0 && state.dirSeq >= 0 && state.linkSeq < state.dirSeq;
    return out;
}

type Obs = {
    unicode: boolean;
    ascii: boolean;
    uniKind: string;
    subKind: string;
    linkKind: string;
    readlink: string;
    stat: string;
    inbounds: boolean;
};

function kindOf(path: string): string {
    try {
        const st = lstatSync(path);
        if (st.isSymbolicLink()) return "symlink";
        if (st.isDirectory()) return "dir";
        if (st.isFile()) return "file";
        return "other";
    } catch (error) {
        return `error:${codeOf(error)}`;
    }
}

function linkTargetOf(root: string): string {
    try {
        const target = readlinkSync(join(root, "dirlink"));
        if (target === "sub") return "sub";
        if (normalize(target) === normalize("sub/")) return "sub-slash";
        return "other";
    } catch (error) {
        return `error:${codeOf(error)}`;
    }
}

function statOf(root: string): string {
    try {
        return statSync(join(root, "dirlink")).isDirectory() ? "dir" : "not-dir";
    } catch (error) {
        return `error:${codeOf(error)}`;
    }
}

function inboundsOf(root: string): boolean {
    try {
        const sub = realpathSync(join(root, "sub"));
        const via = realpathSync(join(root, "dirlink"));
        return via === sub && via.startsWith(root);
    } catch {
        return false;
    }
}

/** Inventory as booleans/enum tokens only, never raw paths. */
function observe(root: string): Obs {
    return {
        unicode: existsSync(join(root, UNI)),
        ascii: existsSync(join(root, "sub", "file.txt")),
        uniKind: kindOf(join(root, UNI)),
        subKind: kindOf(join(root, "sub")),
        linkKind: kindOf(join(root, "dirlink")),
        readlink: linkTargetOf(root),
        stat: statOf(root),
        inbounds: inboundsOf(root),
    };
}

type CellOut = { status: string; obs: Obs };

function extract(archive: Buffer, extra: string[]): CellOut {
    const home = tempRoot("win-arch-out-");
    const root = join(home, "out");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(home, "probe.tar"), archive);
    const res = spawnSync("tar", [...extra, "-xf", join(home, "probe.tar"), "-C", root], {
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
    });
    const status = res.error !== undefined ? `error:${codeOf(res.error)}` : `status:${String(res.status)}`;
    return { status, obs: observe(root) };
}

describe("windows archive characterization (temporary diagnostic)", () => {
    it("git archive stays UTF-8 USTAR without PAX path/hdrcharset/symlinktype (portable)", () => {
        const plain = fixture("sub");
        const suffixed = fixture("sub/");
        const hp = scan(archiveOf(plain.work, plain.sha));
        const hs = scan(archiveOf(suffixed.work, suffixed.sha));
        expect(hp.utf8Name).toBe(true);
        expect(hs.utf8Name).toBe(true);
        for (const h of [hp, hs]) {
            expect(h.paxPath).toBe(false);
            expect(h.hdrcharset).toBe(false);
            expect(h.libSymlinkType).toBe(false);
        }
        expect(hp.link).toBe("sub");
        expect(hs.link).toBe("sub-slash");
        expect(hp.linkBeforeDir).toBe(true);
    });

    it("scanner walks entries, never payload bytes; malformed input fails closed (portable)", () => {
        const header = Buffer.alloc(BLOCK);
        header.write("plain.txt", 0, "ascii");
        header.write("00000001000", 124, "ascii");
        header[156] = 0x30;
        header.write("ustar", 257, "ascii");
        const payload = Buffer.alloc(BLOCK);
        payload.write(UNI, 0, "utf8");
        payload.write("path=", 64, "ascii");
        payload.write("hdrcharset=UTF-8", 96, "ascii");
        payload.write("LIBARCHIVE.symlinktype", 160, "ascii");
        const archive = Buffer.concat([header, payload, Buffer.alloc(BLOCK * 2)]);
        const hit = scan(archive);
        expect(hit.utf8Name).toBe(false);
        expect(hit.paxPath).toBe(false);
        expect(hit.hdrcharset).toBe(false);
        expect(hit.libSymlinkType).toBe(false);
        expect(hit.link).toBe("unknown");
        expect(scan(Buffer.alloc(100)).utf8Name).toBe(false);
        const badSize = Buffer.from(header);
        badSize.write("zzzzzzzzzzz", 124, "ascii");
        expect(scan(Buffer.concat([badSize, Buffer.alloc(BLOCK * 2)])).link).toBe("unknown");
        const huge = Buffer.from(header);
        huge.write("77777777777", 124, "ascii");
        expect(scan(Buffer.concat([huge, Buffer.alloc(BLOCK * 2)])).utf8Name).toBe(false);
    });

    it("decoder and link-text contrasts stay independent; default only observed (win controls)", () => {
        const plain = fixture("sub");
        const suffixed = fixture("sub/");
        const plainBytes = archiveOf(plain.work, plain.sha);
        const suffixedBytes = archiveOf(suffixed.work, suffixed.sha);
        const hdr = { plain: scan(plainBytes), suffixed: scan(suffixedBytes) };
        let cells: { base: CellOut; utf8: CellOut; slash: CellOut; both: CellOut } | null = null;
        if (IS_WIN) {
            cells = {
                base: extract(plainBytes, []),
                utf8: extract(plainBytes, UTF8_TAR_OPTIONS),
                slash: extract(suffixedBytes, []),
                both: extract(suffixedBytes, UTF8_TAR_OPTIONS),
            };
        }
        process.stdout.write(`${JSON.stringify({ note: "observations only; not decoder proof", hdr, cells: cells ?? "unverified-off-win" })}\n`);
        if (cells === null) return;
        // Decoder-only contrast: same plain bytes, decoder varies; link recorded both sides.
        expect(cells.utf8.status).toBe("status:0");
        expect(cells.utf8.obs.unicode).toBe(true);
        expect(cells.utf8.obs.ascii).toBe(true);
        expect(cells.utf8.obs.uniKind).toBe("file");
        expect(cells.utf8.obs.subKind).toBe("dir");
        expect(cells.utf8.obs.linkKind).toBe("symlink");
        expect(cells.utf8.obs.readlink).toBe("sub");
        // Link-text-only contrast: same default decoder, link text varies.
        expect(cells.slash.status).toBe("status:0");
        expect(cells.slash.obs.linkKind).toBe("symlink");
        expect(cells.slash.obs.readlink).toBe("sub-slash");
        expect(cells.slash.obs.inbounds).toBe(true);
        expect(cells.slash.obs.stat).toBe("dir");
        expect(cells.slash.obs.ascii).toBe(true);
        // cells.base and cells.both stay observed-only: no causal read from default or combined.
    });
});
