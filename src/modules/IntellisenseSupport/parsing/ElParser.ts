/**
 * ElParser — tokenizador de expresiones EL (#{...} / ${...}). Sin dependencias de vscode (testeable).
 *
 * Soporta: negación/operadores (not, and, or, empty, eq...), ternarios, llamadas a método con argumentos,
 * funciones con prefijo (fn:length(x)), acceso con corchetes (bean.list[0].name), EL multilínea
 * y varias referencias por expresión (#{a.x and b.y}).
 */

export interface ElSeg {
    name: string;
    /** El segmento va seguido de "(...)" */
    call: boolean;
    /** El segmento va seguido de "[...]" */
    index: boolean;
}

export interface ElSegment extends ElSeg {
    /** Offsets absolutos en el texto (end exclusivo, sin incluir paréntesis/corchetes). */
    start: number;
    end: number;
}

export interface ElRef {
    segments: ElSegment[];
}

export interface ElRegion {
    /** Offset del '#' o '$' */
    open: number;
    /** Primer carácter tras "#{" */
    bodyStart: number;
    /** Offset de la '}' de cierre (exclusivo para el cuerpo) */
    bodyEnd: number;
}

export type ElContext =
    | { kind: 'root'; partial: string }
    | { kind: 'member'; segments: ElSeg[]; partial: string };

const KEYWORDS = new Set([
    'and', 'or', 'not', 'empty', 'eq', 'ne', 'lt', 'gt', 'le', 'ge', 'div', 'mod',
    'true', 'false', 'null', 'instanceof'
]);

const isIdStart = (c: string | undefined): boolean => !!c && /[A-Za-z_$]/.test(c);
const isIdChar = (c: string | undefined): boolean => !!c && /[\w$]/.test(c);

/** Offset del "#{"/"${" abierto sin cerrar al final del texto, o -1. */
export function openElIndex(text: string): number {
    const idx = Math.max(text.lastIndexOf('#{'), text.lastIndexOf('${'));
    if (idx < 0) { return -1; }
    return text.indexOf('}', idx) === -1 ? idx : -1;
}

function skipString(text: string, i: number, end: number): number {
    const quote = text[i];
    let j = i + 1;
    while (j < end) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === quote) { return j + 1; }
        j++;
    }
    return end;
}

function matchClose(text: string, openIdx: number, end: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIdx; i < end; i++) {
        const c = text[i];
        if (c === '"' || c === "'") { i = skipString(text, i, end) - 1; continue; }
        if (c === open) { depth++; }
        else if (c === close) {
            depth--;
            if (depth === 0) { return i; }
        }
    }
    return -1;
}

/** Todas las regiones EL cerradas del texto. */
export function findElRegions(text: string): ElRegion[] {
    const regions: ElRegion[] = [];
    const re = /[#$]\{/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
        const bodyStart = m.index + 2;
        let depth = 1;
        let q: string | null = null;
        let i = bodyStart;
        let closed = false;
        for (; i < text.length; i++) {
            const c = text[i];
            if (q) {
                if (c === '\\') { i++; continue; }
                if (c === q) { q = null; }
                continue;
            }
            if (c === '"' || c === "'") { q = c; continue; }
            if (c === '{') { depth++; }
            else if (c === '}') {
                depth--;
                if (depth === 0) { closed = true; break; }
            }
        }
        if (!closed) {
            re.lastIndex = bodyStart;
            continue;
        }
        regions.push({ open: m.index, bodyStart, bodyEnd: i });
        re.lastIndex = i + 1;
    }
    return regions;
}

/** Extrae las cadenas de identificadores (bean.a.b) dentro de [start, end) del texto. */
export function extractRefs(text: string, start: number, end: number): ElRef[] {
    const refs: ElRef[] = [];
    let i = start;
    while (i < end) {
        const c = text[i];
        if (c === '"' || c === "'") { i = skipString(text, i, end); continue; }
        if (/\d/.test(c)) {
            while (i < end && /[\w.]/.test(text[i])) { i++; }
            continue;
        }
        if (!isIdStart(c)) { i++; continue; }

        let j = i;
        while (j < end && isIdChar(text[j])) { j++; }
        const firstName = text.substring(i, j);

        // función con prefijo: fn:length(...)
        if (text[j] === ':' && isIdStart(text[j + 1])) {
            let k = j + 1;
            while (k < end && isIdChar(text[k])) { k++; }
            if (text[k] === '(') { i = k + 1; continue; }
        }
        if (KEYWORDS.has(firstName)) { i = j; continue; }

        const segments: ElSegment[] = [];
        let segName = firstName;
        let segStart = i;
        let segEnd = j;
        let pos = j;
        for (;;) {
            let call = false;
            let index = false;
            while (pos < end && (text[pos] === '(' || text[pos] === '[')) {
                const open = text[pos];
                const close = open === '(' ? ')' : ']';
                const closeIdx = matchClose(text, pos, end, open, close);
                if (closeIdx < 0) { pos = end; break; }
                if (open === '(') { call = true; } else { index = true; }
                refs.push(...extractRefs(text, pos + 1, closeIdx));
                pos = closeIdx + 1;
            }
            segments.push({ name: segName, start: segStart, end: segEnd, call, index });
            if (pos < end && text[pos] === '.' && isIdStart(text[pos + 1])) {
                let k = pos + 1;
                while (k < end && isIdChar(text[k])) { k++; }
                segName = text.substring(pos + 1, k);
                segStart = pos + 1;
                segEnd = k;
                pos = k;
                continue;
            }
            break;
        }
        refs.push({ segments });
        i = pos;
    }
    return refs;
}

/** Todas las referencias EL del documento, ordenadas por posición. */
export function collectRefs(text: string): ElRef[] {
    const out: ElRef[] = [];
    for (const region of findElRegions(text)) {
        out.push(...extractRefs(text, region.bodyStart, region.bodyEnd));
    }
    out.sort((a, b) => a.segments[0].start - b.segments[0].start);
    return out;
}

/** ¿El final del texto cae dentro de un literal de cadena EL? */
function endsInsideString(expr: string): boolean {
    let q: string | null = null;
    for (let i = 0; i < expr.length; i++) {
        const c = expr[i];
        if (q) {
            if (c === '\\') { i++; continue; }
            if (c === q) { q = null; }
        } else if (c === '"' || c === "'") {
            q = c;
        }
    }
    return q !== null;
}

/**
 * Contexto de completado al final de `textBefore`:
 *   #{|          → root
 *   #{be|        → root (partial = "be")
 *   #{bean.a.|   → member (segments = [bean, a])
 */
export function elContextAt(textBefore: string): ElContext | undefined {
    const idx = openElIndex(textBefore);
    if (idx < 0) { return undefined; }
    const expr = textBefore.substring(idx + 2);
    if (endsInsideString(expr)) { return undefined; }

    const partial = /[\w$]*$/.exec(expr)![0];
    const dotPos = expr.length - partial.length - 1;
    if (dotPos < 0 || expr[dotPos] !== '.') {
        return { kind: 'root', partial };
    }

    const segments: ElSeg[] = [];
    let pos = dotPos;
    while (pos >= 0 && expr[pos] === '.') {
        let j = pos;
        let call = false;
        let index = false;
        while (j > 0 && (expr[j - 1] === ')' || expr[j - 1] === ']')) {
            const close = expr[j - 1];
            const open = close === ')' ? '(' : '[';
            let depth = 0;
            let k = j - 1;
            for (; k >= 0; k--) {
                if (expr[k] === close) { depth++; }
                else if (expr[k] === open) {
                    depth--;
                    if (depth === 0) { break; }
                }
            }
            if (k < 0) { return undefined; }
            if (close === ')') { call = true; } else { index = true; }
            j = k;
        }
        let s = j;
        while (s > 0 && isIdChar(expr[s - 1])) { s--; }
        const name = expr.substring(s, j);
        if (!name || !isIdStart(name[0])) { return undefined; }
        segments.unshift({ name, call, index });
        pos = s - 1;
    }
    return { kind: 'member', segments, partial };
}
