/**
 * TagContext — análisis puro (sin vscode) del contexto del cursor dentro de un XHTML.
 * Recibe el texto desde el inicio (o una ventana) hasta el cursor.
 */
import { openElIndex } from './ElParser';

export interface TagScan {
    /** Offset del '<' del tag abierto en el cursor */
    tagStart: number;
    /** Comilla de valor de atributo abierta (o null) */
    quote: string | null;
    /** Offset de la comilla de apertura (si quote != null) */
    quoteStart: number;
}

export type CursorContext =
    | { kind: 'none' }
    | { kind: 'el' }
    | { kind: 'tagName'; prefix: string; partial: string }
    | { kind: 'attrName'; prefix: string; component: string; used: Set<string> }
    | { kind: 'attrValue'; prefix: string; component: string; attribute: string };

const NONE: CursorContext = { kind: 'none' };

/**
 * Recorre el texto como una máquina de estados (texto / dentro de tag / dentro de comillas)
 * y devuelve el tag abierto al final, si lo hay. Ignora comentarios y '>' dentro de comillas.
 */
export function scanOpenTag(text: string): TagScan | undefined {
    let i = 0;
    const n = text.length;
    let tagStart = -1;
    let quote: string | null = null;
    let quoteStart = -1;

    while (i < n) {
        if (tagStart < 0) {
            if (text.startsWith('<!--', i)) {
                const e = text.indexOf('-->', i + 4);
                if (e < 0) { return undefined; } // cursor dentro de un comentario
                i = e + 3;
                continue;
            }
            if (text[i] === '<') {
                tagStart = i;
                quote = null;
            }
            i++;
            continue;
        }
        const c = text[i];
        if (quote) {
            if (c === quote) { quote = null; }
        } else if (c === '"' || c === "'") {
            quote = c;
            quoteStart = i;
        } else if (c === '>') {
            tagStart = -1;
        }
        i++;
    }
    return tagStart < 0 ? undefined : { tagStart, quote, quoteStart };
}

/** Nombre `prefix:component` del tag abierto en el cursor (sin importar si hay comilla abierta). */
export function enclosingTag(text: string): { prefix: string; component: string } | undefined {
    const scan = scanOpenTag(text);
    if (!scan) { return undefined; }
    const m = /^<([A-Za-z_][\w-]*):([\w.-]+)/.exec(text.substring(scan.tagStart));
    return m ? { prefix: m[1], component: m[2] } : undefined;
}

export function analyze(text: string): CursorContext {
    if (openElIndex(text) >= 0) {
        return { kind: 'el' };
    }
    const scan = scanOpenTag(text);
    if (!scan) { return NONE; }

    const frag = text.substring(scan.tagStart);
    if (frag.startsWith('</') || frag.startsWith('<!') || frag.startsWith('<?')) { return NONE; }

    const tn = /^<([A-Za-z_][\w-]*):([\w.-]*)$/.exec(frag);
    if (tn) {
        return { kind: 'tagName', prefix: tn[1], partial: tn[2] };
    }

    const full = /^<([A-Za-z_][\w-]*):([\w.-]+)(?=[\s/]|$)/.exec(frag);
    if (!full) { return NONE; }
    const prefix = full[1];
    const component = full[2];

    if (scan.quote) {
        const beforeQuote = frag.substring(0, scan.quoteStart - scan.tagStart);
        const am = /([\w:.-]+)\s*=\s*$/.exec(beforeQuote);
        return { kind: 'attrValue', prefix, component, attribute: am ? am[1] : '' };
    }

    const last = frag[frag.length - 1];
    if (!/[\s\w:.-]/.test(last)) { return NONE; }

    const used = new Set<string>();
    const attrRe = /([\w:.-]+)\s*=\s*("[^"]*"|'[^']*')/g;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(frag)) !== null) {
        used.add(m[1]);
    }
    return { kind: 'attrName', prefix, component, used };
}
