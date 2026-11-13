/* carino-pdf.js — window.CarinoPdf — every report's file, as PDF or HTML.
 *
 * Canonical copy: Branding/carino-pdf.js (propagate.sh copies it, with
 * carino-html2canvas.js beside it, to every site that carries it). Never
 * hand-edit a site's copy.
 *
 * Every report preview (carino-ui.css "18b. report preview") offers its file
 * in two formats, picked with the PDF | HTML switch in the column:
 *
 *   PDF   drawn from the report's own HTML, laid out as the browser prints it:
 *         its @media print rules apply and its @media screen rules do not, the
 *         paper and margins come from its @page rule (A4 and 15 mm when it has
 *         none), and pages end where a row, paragraph or section ends. Each
 *         page is a picture (html2canvas, loaded on the first PDF only), so the
 *         PDF looks exactly like the preview in any script, but its text cannot
 *         be searched or copied. Print / Save as PDF in the browser gives text.
 *   HTML  the report as one standalone file: no scripts, its same-origin
 *         stylesheets (with their @imports), the font faces its text uses and
 *         its pictures written into it, so it opens offline.
 *
 * Known limits of the PDF: one paper size per file (named @page rules are
 * not read), and a long table's header row is not repeated on each page.
 *
 * Nothing leaves the device: no outside request is made, the file is saved
 * with a download link.
 *
 *   CarinoPdf.download({ html, name, format, title, page, fonts, producer, base, save })
 *       -> Promise<{ ok, name, error? }>   name with or without its extension;
 *       save(blob, name) replaces the built-in download link
 *   CarinoPdf.pdf(html, opts)             -> Promise<Blob>   (application/pdf)
 *   CarinoPdf.htmlFile(html, opts)        -> Promise<string> (the standalone file)
 *   CarinoPdf.withSheets(html, base)      -> Promise<string> (linked same-origin sheets written in)
 *   CarinoPdf.spellOut(doc), .measure(doc) the PDF's own text fixes and page
 *       measurements, for a preview that draws the same page lines
 *   CarinoPdf.formatSwitch({ onChange })  -> { el, get(), set(v), relabel() }
 *       the switch, for .rpv-side just above .rpv-name; it remembers the
 *       last choice for this site
 *   CarinoPdf.label(format)               'Download PDF' / 'Download HTML', translated
 *   CarinoPdf.fileName(name, format)      name with the format's extension
 *   CarinoPdf.t = fn                      the site's translator (default: window.t)
 *
 * Strings a site translates (English is the key): File, PDF, HTML,
 * Download PDF, Download HTML, Creating the PDF…, Could not create the PDF.
 *
 * The pure half (pageSetup, pageBreaks, asPrinted, fileName) loads under
 * `new Function` in tests; the DOM is touched only from pdf()/htmlFile() on.
 */
(function () {
    'use strict';

    var SCRIPT = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
    var KEY = 'carino-report-format';
    var MM_PX = 96 / 25.4;          // CSS px per mm
    var PX_PT = 0.75;               // PDF points per CSS px
    var SCALE = 2;                  // canvas pixels per CSS px: about 190 dpi on paper
    var MAX_AREA = 16e6;            // canvas pixels per html2canvas pass (Safari's limit is 16.7 M)

    var api = {};

    function tr(k) {
        var f = api.t || (typeof window !== 'undefined' && (window.t || window.T));
        try { var v = typeof f === 'function' ? f(k) : k; return typeof v === 'string' && v ? v : k; }
        catch (e) { return k; }
    }

    /* ---- paper ---------------------------------------------------------- */

    var PAPERS = {
        a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148],
        b4: [250, 353], b5: [176, 250], jis_b4: [257, 364], jis_b5: [182, 257],
        letter: [215.9, 279.4], legal: [215.9, 355.6], ledger: [279.4, 431.8],
    };
    var DEFAULT = { w: 210, h: 297, margin: [15, 15, 15, 15] };

    // A CSS length in mm, or null (percentages and auto are not lengths here).
    function lenMm(v) {
        var m = /^(-?\d*\.?\d+)(mm|cm|in|pt|pc|px|q)?$/i.exec(String(v).trim());
        if (!m) return null;
        var n = +m[1];
        switch ((m[2] || (n === 0 ? 'mm' : '')).toLowerCase()) {
            case 'mm': return n;
            case 'cm': return n * 10;
            case 'in': return n * 25.4;
            case 'pt': return n * 25.4 / 72;
            case 'pc': return n * 25.4 / 6;
            case 'px': return n / MM_PX;
            case 'q': return n / 4;
            default: return null;
        }
    }

    // Paper and margins, in mm, from the document's @page rules (the last
    // size and margin win, as in CSS; :first and other page selectors are
    // left out). { w, h, margin: [top, right, bottom, left] }
    function pageSetup(css, fallback) {
        var base = fallback || DEFAULT;
        var out = { w: base.w, h: base.h, margin: base.margin.slice() };
        var re = /@page\s*\{([^{}]*)\}/gi, m;
        while ((m = re.exec(String(css || '')))) {
            var body = m[1];
            var s = /(?:^|;|\s)size\s*:\s*([^;]+)/i.exec(body);
            if (s) {
                var toks = s[1].replace(/!important/i, '').trim().toLowerCase().split(/\s+/);
                var paper = null, orient = null, lens = [];
                toks.forEach(function (x) {
                    if (PAPERS[x]) paper = PAPERS[x];
                    else if (x === 'portrait' || x === 'landscape') orient = x;
                    else { var l = lenMm(x); if (l !== null && l > 0) lens.push(l); }
                });
                var w = out.w, h = out.h;
                if (lens.length) { w = lens[0]; h = lens.length > 1 ? lens[1] : lens[0]; }
                else if (paper) { w = paper[0]; h = paper[1]; }
                else if (toks[0] === 'auto') { w = base.w; h = base.h; }
                if (orient === 'landscape' && w < h) { var x1 = w; w = h; h = x1; }
                if (orient === 'portrait' && w > h) { var x2 = w; w = h; h = x2; }
                out.w = w; out.h = h;
            }
            var g = /(?:^|;|\s)margin\s*:\s*([^;]+)/i.exec(body);
            if (g) {
                var ms = g[1].replace(/!important/i, '').trim().split(/\s+/).map(lenMm);
                if (ms.length && ms.every(function (v) { return v !== null && v >= 0; })) {
                    var t = ms[0], r = ms[1] !== undefined ? ms[1] : t, b = ms[2] !== undefined ? ms[2] : t,
                        l = ms[3] !== undefined ? ms[3] : r;
                    out.margin = [t, r, b, l];
                }
            }
            ['top', 'right', 'bottom', 'left'].forEach(function (side, i) {
                var one = new RegExp('(?:^|;|\\s)margin-' + side + '\\s*:\\s*([^;]+)', 'i').exec(body);
                var v = one && lenMm(one[1].replace(/!important/i, ''));
                if (v !== null && v !== undefined && v >= 0) out.margin[i] = v;
            });
        }
        // Margins that leave no room for content: keep 1 mm of it.
        if (out.margin[1] + out.margin[3] > out.w - 1) out.margin[1] = out.margin[3] = 0;
        if (out.margin[0] + out.margin[2] > out.h - 1) out.margin[0] = out.margin[2] = 0;
        return out;
    }

    // The document as the printer lays it out: print rules on, screen rules
    // off (in <style> blocks and on <link>/<style media>), no scripts, and no
    // CSP meta (only this copy, which runs nothing, is laid out; the CSP would
    // keep the site's own fonts out of it).
    // One media query list as the printer reads it. Each query is judged on
    // its own: 'screen …' can never match (whatever its features say),
    // 'print …' keeps its features on any medium, 'not print …' never matches,
    // 'not screen …' always does. A query naming no type is left as it is.
    function printedQuery(list) {
        return String(list).split(',').map(function (q) {
            var s = q.trim(), m = /^(only\s+|not\s+)?(screen|print)\b\s*(?:and\b\s*)?([\s\S]*)$/i.exec(s);
            if (!m) return s;
            var not = /^not/i.test(m[1] || ''), print = /^print$/i.test(m[2]), rest = m[3].trim();
            if (not) return print ? 'not all' : 'all';
            if (!print) return 'not all';
            return rest ? 'all and ' + rest : 'all';
        }).join(', ');
    }

    function asPrinted(html) {
        return String(html || '')
            .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
            .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, '')
            .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, function (all, open, css, close) {
                return open + css.replace(/@media\b([^{;]*)\{/gi, function (a, q) { return '@media ' + printedQuery(q) + ' {'; }) + close;
            })
            .replace(/(<(?:link|style)\b[^>]*\bmedia\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi, function (a, pre, d, s, b) {
                return pre + '"' + printedQuery(d !== undefined ? d : s !== undefined ? s : b) + '"';
            });
    }

    // Where the pages end, in CSS px from the top of the document.
    //   ends:   bottoms a page may end after (rows, paragraphs, sections…)
    //   keeps:  [top, bottom] of blocks a page should not cut (break-inside:
    //           avoid, pictures, rows); one taller than a page is cut anyway
    //   forced: tops (and bottoms) where a new page must start (break-before/after: page)
    //   total:  the document's height;  pageH: one page's content height
    // Returns [0, cut, …, total].
    function pageBreaks(ends, keeps, forced, total, pageH) {
        var h = pageH > 0 ? pageH : 1;
        var sorted = (ends || []).filter(isFinite).sort(function (a, b) { return a - b; });
        var hard = (forced || []).filter(isFinite).sort(function (a, b) { return a - b; });
        var avoid = (keeps || []).filter(function (k) { return k && k[1] - k[0] <= h && k[1] > k[0]; });
        var inside = function (y) {
            for (var i = 0; i < avoid.length; i++) if (avoid[i][0] < y - 1 && avoid[i][1] > y + 1) return true;
            return false;
        };
        var breaks = [0], top = 0, guard = 0;
        while (total - top > h + 1 || hard.some(function (f) { return f > top + 1 && f < total - 1; })) {
            if (++guard > 100000) break;
            var limit = top + h + 1;
            var cut = 0;
            for (var j = 0; j < hard.length; j++) {
                if (hard[j] > top + 1 && hard[j] <= limit && hard[j] < total - 1) { cut = hard[j]; break; }
            }
            if (!cut) {
                for (var i = 0; i < sorted.length; i++) {
                    if (sorted[i] > limit) break;
                    if (sorted[i] > top + 1 && !inside(sorted[i])) cut = sorted[i];
                }
            }
            if (!cut) cut = Math.min(top + h, total);
            breaks.push(cut);
            top = cut;
        }
        if (total > top + 0.5 || breaks.length === 1) breaks.push(Math.max(total, top));
        return breaks;
    }

    function fileName(name, format) {
        var ext = format === 'html' ? '.html' : '.pdf';
        var stem = String(name || 'report').replace(/\.(pdf|html?|txt|md)$/i, '');
        return stem + ext;
    }

    api.pageSetup = pageSetup;
    api.pageBreaks = pageBreaks;
    api.asPrinted = asPrinted;
    api.fileName = fileName;
    api.DEFAULT_PAGE = DEFAULT;

    if (typeof document === 'undefined') { if (typeof window !== 'undefined') window.CarinoPdf = api; return; }

    /* ---- the PDF -------------------------------------------------------- */

    var libLoading = null;
    function loadLib() {
        if (typeof window.html2canvas === 'function') return Promise.resolve();
        if (libLoading) return libLoading;
        libLoading = new Promise(function (res, rej) {
            var s = document.createElement('script');
            s.src = SCRIPT ? new URL('carino-html2canvas.js', SCRIPT).href : 'carino-html2canvas.js';
            s.onload = function () { typeof window.html2canvas === 'function' ? res() : rej(new Error('html2canvas did not load')); };
            s.onerror = function () { libLoading = null; rej(new Error('html2canvas did not load')); };
            document.head.appendChild(s);
        });
        return libLoading;
    }

    // Canvas font strings cannot name these: the browser would lay text out in
    // one font and html2canvas draw another at those positions.
    var UNKNOWN_FONT = /(^|,)\s*(ui-monospace|ui-sans-serif|ui-serif|ui-rounded|system-ui|-apple-system|BlinkMacSystemFont)\s*(?=,|$)/gi;

    // html2canvas 1.4 reads rgb(), hsl(), hex and names only; color-mix()
    // computes to color(srgb …), and oklch()/lab() stop the whole PDF. Those
    // are written back as rgba(), read off a one-pixel canvas.
    var COLOUR_PROPS = ['color', 'background-color', 'background-image', 'border-top-color', 'border-right-color',
        'border-bottom-color', 'border-left-color', 'outline-color', 'text-decoration-color', 'column-rule-color',
        'box-shadow', 'text-shadow', 'fill', 'stroke', 'caret-color'];
    var MODERN_COLOUR = /\b(?:color|oklch|oklab|lab|lch|hwb|color-mix)\(/i;
    var MODERN_COLOUR_ALL = /\b(?:color|oklch|oklab|lab|lch|hwb)\([^()]*\)/gi;
    var colourPad = null, colourSeen = {};
    function plainColour(c) {
        if (colourSeen[c]) return colourSeen[c];
        if (!colourPad) { var cv = document.createElement('canvas'); cv.width = cv.height = 1; colourPad = cv.getContext('2d', { willReadFrequently: true }); }
        colourPad.clearRect(0, 0, 1, 1);
        colourPad.fillStyle = '#000';
        colourPad.fillStyle = c;
        colourPad.fillRect(0, 0, 1, 1);
        var p = colourPad.getImageData(0, 0, 1, 1).data;
        return (colourSeen[c] = 'rgba(' + p[0] + ', ' + p[1] + ', ' + p[2] + ', ' + Math.round(p[3] / 255 * 1000) / 1000 + ')');
    }

    // html2canvas fonts, breaks and cases text by its own rules. Spell those
    // out in the copy before it is measured: usable font stacks, capitals
    // typed rather than transformed, and a zero-width space where the browser
    // wrapped inside a long word (a UID, a hash, a URL).
    function spellOut(d) {
        var view = d.defaultView;
        var all = [d.body].concat(Array.prototype.slice.call(d.body.querySelectorAll('*')));
        all.forEach(function (el) {
            var cs = view.getComputedStyle(el);
            var fam = cs.fontFamily;
            var ok = fam.replace(UNKNOWN_FONT, '').replace(/^\s*,\s*/, '');
            if (ok !== fam) el.style.fontFamily = ok || 'sans-serif';
            COLOUR_PROPS.forEach(function (p) {
                var v = cs.getPropertyValue(p);
                if (!v || !MODERN_COLOUR.test(v)) return;
                var flat = v.replace(MODERN_COLOUR_ALL, plainColour);
                if (MODERN_COLOUR.test(flat)) flat = /image|shadow/.test(p) ? 'none' : plainColour(v);
                el.style.setProperty(p, flat, 'important');
            });
        });
        // html2canvas draws each <svg> from its own markup, so a <use> whose
        // target sits in another <svg> (a shared <defs>) would come out blank.
        Array.prototype.forEach.call(d.querySelectorAll('svg use'), function (u) {
            var ref = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
            if (ref.charAt(0) !== '#') return;
            var id = ref.slice(1), svg = u.ownerSVGElement, target = d.getElementById(id);
            if (!svg || !target || svg.querySelector('[id="' + id.replace(/["\\]/g, '\\$&') + '"]')) return;
            var defs = svg.querySelector(':scope > defs[data-carino-pdf]');
            if (!defs) { defs = d.createElementNS('http://www.w3.org/2000/svg', 'defs'); defs.setAttribute('data-carino-pdf', ''); svg.insertBefore(defs, svg.firstChild); }
            defs.appendChild(target.cloneNode(true));
        });
        var walk = d.createTreeWalker(d.body, 4 /* NodeFilter.SHOW_TEXT */);
        var texts = [];
        while (walk.nextNode()) texts.push(walk.currentNode);
        var upper = [];
        texts.forEach(function (node) {
            var el = node.parentElement;
            if (el && view.getComputedStyle(el).textTransform === 'uppercase') { node.data = node.data.toUpperCase(); upper.push(el); }
        });
        upper.forEach(function (el) { el.style.textTransform = 'none'; });
        var range = d.createRange();
        var lineOf = function (node, i) { range.setStart(node, i); range.setEnd(node, i + 1); return range.getBoundingClientRect().top; };
        texts.forEach(function (node) {
            var cuts = [], re = /\S{12,}/g, m;
            while ((m = re.exec(node.data))) {
                var top = lineOf(node, m.index);
                for (var i = m.index + 1; i < m.index + m[0].length; i++) {
                    if ((node.data.charCodeAt(i) & 0xfc00) === 0xdc00) continue;
                    var tp = lineOf(node, i);
                    if (tp > top + 1) { cuts.push(i); top = tp; }
                }
            }
            cuts.reverse().forEach(function (i) { node.data = node.data.slice(0, i) + '​' + node.data.slice(i); });
        });
    }

    var ENDS = 'header, section, article, aside, nav, main, table, thead, tbody, tfoot, tr, p, li, ul, ol, dl, dt, dd, hr, ' +
        'figure, figcaption, img, svg, canvas, pre, blockquote, details, fieldset, form, footer, div';
    var KEEP_ALWAYS = 'tr, img, svg, canvas, figure, pre';
    var HEADINGS = /^(H[1-6]|THEAD|LEGEND|CAPTION|SUMMARY)$/;

    function measure(d) {
        var view = d.defaultView;
        var ends = [], keeps = [], forced = [];
        var sy = view.scrollY || 0;
        var nodes = d.body.querySelectorAll(ENDS + ', h1, h2, h3, h4, h5, h6');
        Array.prototype.forEach.call(nodes, function (el) {
            var r = el.getBoundingClientRect();
            if (!r.height && !r.width) return;
            var top = r.top + sy, bottom = r.bottom + sy;
            var cs = view.getComputedStyle(el);
            if (cs.display === 'none' || cs.position === 'fixed') return;
            if (!HEADINGS.test(el.tagName)) ends.push(bottom);
            var bi = cs.breakInside || cs.pageBreakInside;
            if (/avoid/.test(bi) || el.matches(KEEP_ALWAYS)) keeps.push([top, bottom]);
            // A heading stays with what follows it.
            if (HEADINGS.test(el.tagName) && /^H[1-6]$/.test(el.tagName)) {
                var next = el.nextElementSibling;
                var nb = next ? Math.min(next.getBoundingClientRect().bottom + sy, top + 120) : bottom;
                keeps.push([top, Math.max(bottom, nb)]);
            }
            var bb = cs.breakBefore || cs.pageBreakBefore, ba = cs.breakAfter || cs.pageBreakAfter;
            if (/page|always|left|right|recto|verso/.test(bb)) forced.push(top);
            if (/page|always|left|right|recto|verso/.test(ba)) forced.push(bottom);
        });
        var total = Math.max(d.documentElement.scrollHeight, d.body.scrollHeight);
        return { ends: ends, keeps: keeps, forced: forced, total: total };
    }

    function pageImage(canvas) {
        if (typeof CompressionStream === 'function') {
            var px = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            var rgb = new Uint8Array(px.length / 4 * 3);
            for (var i = 0, j = 0; i < px.length; i += 4) { rgb[j++] = px[i]; rgb[j++] = px[i + 1]; rgb[j++] = px[i + 2]; }
            return new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
                .then(function (z) { return { data: new Uint8Array(z), filter: 'FlateDecode' }; });
        }
        return new Promise(function (res, rej) {
            canvas.toBlob(function (b) { b ? res(b) : rej(new Error('could not encode a page')); }, 'image/jpeg', 0.92);
        }).then(function (b) { return b.arrayBuffer(); }).then(function (a) { return { data: new Uint8Array(a), filter: 'DCTDecode' }; });
    }

    // A PDF 1.4 file, one picture per page, each across the printable area.
    function buildPdf(pages, paper, meta) {
        var enc = new TextEncoder();
        var parts = [], offsets = [], length = 0;
        var put = function (x) { var b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); length += b.length; };
        var obj = function (n, dict, stream) {
            offsets[n] = length;
            put(n + ' 0 obj\n' + dict + '\n');
            if (stream) { put('stream\n'); put(stream); put('\nendstream\n'); }
            put('endobj\n');
        };
        var num = function (v) { return String(Math.round(v * 100) / 100); };
        var text = function (s) {
            var out = '<FEFF';
            Array.from(String(s || '')).forEach(function (c) {
                var u = c.codePointAt(0);
                var units = u > 0xffff ? [0xd800 + ((u - 0x10000) >> 10), 0xdc00 + ((u - 0x10000) & 0x3ff)] : [u];
                units.forEach(function (x) { out += ('000' + x.toString(16)).slice(-4); });
            });
            return out + '>';
        };
        var now = new Date(), p2 = function (v) { return ('0' + v).slice(-2); };
        var created = 'D:' + now.getUTCFullYear() + p2(now.getUTCMonth() + 1) + p2(now.getUTCDate()) +
            p2(now.getUTCHours()) + p2(now.getUTCMinutes()) + p2(now.getUTCSeconds()) + 'Z';
        var W = paper.w / 25.4 * 72, H = paper.h / 25.4 * 72;
        var mt = paper.margin[0] / 25.4 * 72, ml = paper.margin[3] / 25.4 * 72;
        var first = function (i) { return 4 + i * 3; };
        put(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
        obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
        obj(2, '<< /Type /Pages /Count ' + pages.length + ' /Kids [' + pages.map(function (_, i) { return first(i) + ' 0 R'; }).join(' ') + '] >>');
        obj(3, '<< /Title ' + text(meta.title) + ' /Producer ' + text(meta.producer) + ' /CreationDate (' + created + ') >>');
        pages.forEach(function (p, i) {
            var n = first(i), dw = p.cssW * PX_PT, dh = p.cssH * PX_PT;
            var content = enc.encode('q ' + num(dw) + ' 0 0 ' + num(dh) + ' ' + num(ml) + ' ' + num(H - mt - dh) + ' cm /Im0 Do Q');
            obj(n, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + num(W) + ' ' + num(H) + '] /Resources << /XObject << /Im0 ' + (n + 2) + ' 0 R >> >> /Contents ' + (n + 1) + ' 0 R >>');
            obj(n + 1, '<< /Length ' + content.length + ' >>', content);
            obj(n + 2, '<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
                ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /' + p.filter + ' /Length ' + p.data.length + ' >>', p.data);
        });
        var size = first(pages.length), xref = length;
        put('xref\n0 ' + size + '\n0000000000 65535 f \n' +
            offsets.slice(1).map(function (o) { return ('000000000' + o).slice(-10) + ' 00000 n \n'; }).join(''));
        put('trailer\n<< /Size ' + size + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');
        return new Blob(parts, { type: 'application/pdf' });
    }

    function styleText(html) {
        var css = '', re = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi, m;
        while ((m = re.exec(html))) css += m[1] + '\n';
        return css;
    }

    // opts: { title, producer, page: {w,h,margin} (mm, overrides @page),
    //         fonts: stylesheet URL for the site's fonts ('fonts/carino-fonts.css'; false: none) }
    function pdf(html, opts) {
        opts = opts || {};
        // Linked stylesheets are written in first: the frame then has nothing
        // left to load, and their @media print rules switch like the rest.
        return withSheets(String(html || ''), opts.base || document.baseURI).then(function (full) { return drawPdf(full, opts); });
    }

    // html2canvas finds each font's baseline with a 1×1 picture in THIS
    // page; a site whose CSS makes img a block (a reset) would push every
    // line of the PDF down. Undone as soon as the pages are drawn.
    var BASELINE_IMG = 'img[src^="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP"]{display:inline!important;vertical-align:baseline!important;}';

    function drawPdf(html, opts) {
        var printed = asPrinted(html);
        var paper = opts.page ? pageSetup('', { w: opts.page.w, h: opts.page.h, margin: opts.page.margin || DEFAULT.margin })
            : pageSetup(styleText(printed));
        var cssW = (paper.w - paper.margin[1] - paper.margin[3]) * MM_PX;
        var cssH = (paper.h - paper.margin[0] - paper.margin[2]) * MM_PX;
        var ifr = document.createElement('iframe');
        ifr.setAttribute('aria-hidden', 'true');
        ifr.tabIndex = -1;
        ifr.style.cssText = 'position:fixed;left:-' + Math.ceil(cssW + 400) + 'px;top:0;width:' + Math.ceil(cssW) +
            'px;height:' + Math.ceil(cssH) + 'px;border:0;visibility:visible;pointer-events:none;';
        document.body.appendChild(ifr);
        var guard = document.createElement('style');
        guard.textContent = BASELINE_IMG;
        document.head.appendChild(guard);
        var drop = function () { try { ifr.remove(); guard.remove(); } catch (e) { /* gone */ } };
        return loadLib().then(function () {
            var d = ifr.contentDocument;
            d.open(); d.write(printed); d.close();
            var waits = [];
            var fonts = opts.fonts === false ? null : (opts.fonts || 'fonts/carino-fonts.css');
            if (fonts) {
                var link = d.createElement('link');
                link.rel = 'stylesheet';
                link.href = new URL(fonts, document.baseURI).href;
                waits.push(new Promise(function (r) { link.onload = link.onerror = r; (d.head || d.documentElement).appendChild(link); }));
            }
            Array.prototype.forEach.call(d.images, function (img) {
                if (!img.complete) waits.push(new Promise(function (r) { img.onload = img.onerror = r; }));
            });
            Array.prototype.forEach.call(d.querySelectorAll('link[rel~="stylesheet"]'), function (l) {
                if (!l.sheet) waits.push(new Promise(function (r) { l.addEventListener('load', r); l.addEventListener('error', r); setTimeout(r, 5000); }));
            });
            return Promise.all(waits).then(function () {
                if (d.fonts && d.fonts.ready) return Promise.race([d.fonts.ready, new Promise(function (r) { setTimeout(r, 3000); })]);
            }).then(function () {
                if (!d.body) throw new Error('the report has no body');
                d.documentElement.style.background = d.documentElement.style.background || '';
                spellOut(d);
                var mm = measure(d);
                var cuts = pageBreaks(mm.ends, mm.keeps, mm.forced, mm.total, cssH)
                    .map(function (b) { return Math.round(b * SCALE); });
                var per = Math.max(1, Math.floor(MAX_AREA / (cssW * SCALE * cssH * SCALE)));
                var pages = [];
                var i = 0;
                var step = function () {
                    if (i >= cuts.length - 1) return Promise.resolve();
                    var j = Math.min(cuts.length - 1, i + per);
                    return window.html2canvas(d.body, {
                        x: 0, y: cuts[i] / SCALE, width: cssW, height: (cuts[j] - cuts[i]) / SCALE,
                        windowWidth: cssW, windowHeight: cssH, scrollX: 0, scrollY: 0,
                        scale: SCALE, backgroundColor: '#ffffff', logging: false, useCORS: false,
                    }).then(function (chunk) {
                        var seq = Promise.resolve();
                        for (var k = i; k < j; k++) (function (k) {
                            seq = seq.then(function () {
                                var h = cuts[k + 1] - cuts[k];
                                if (h <= 0) return;
                                var page = document.createElement('canvas');
                                page.width = Math.round(cssW * SCALE);
                                page.height = h;
                                var g = page.getContext('2d');
                                g.fillStyle = '#fff';
                                g.fillRect(0, 0, page.width, page.height);
                                g.drawImage(chunk, 0, cuts[k] - cuts[i], page.width, h, 0, 0, page.width, h);
                                return pageImage(page).then(function (img) {
                                    pages.push({ data: img.data, filter: img.filter, w: page.width, h: h, cssW: cssW, cssH: h / SCALE });
                                });
                            });
                        })(k);
                        return seq;
                    }).then(function () { i = j; return step(); });
                };
                return step().then(function () {
                    if (!pages.length) throw new Error('the report is empty');
                    var title = opts.title || (d.title || '').trim() || 'Report';
                    return buildPdf(pages, paper, { title: title, producer: opts.producer || 'Carino Systems' });
                });
            });
        }).then(function (blob) { drop(); return blob; }, function (e) { drop(); throw e; });
    }

    /* ---- the HTML file -------------------------------------------------- */

    function sameOrigin(url) {
        try { return new URL(url, document.baseURI).origin === location.origin; } catch (e) { return false; }
    }
    function asDataUrl(blob) {
        return new Promise(function (res, rej) {
            var fr = new FileReader();
            fr.onload = function () { res(fr.result); };
            fr.onerror = function () { rej(fr.error); };
            fr.readAsDataURL(blob);
        });
    }

    var URL_RE = /url\(\s*(["']?)(?!data:|#|about:)([^"')]+)\1\s*\)/gi;

    // CSS text with its url()s made absolute against `from`.
    function absolute(css, from) {
        return String(css).replace(URL_RE, function (all, q, u) {
            try { return 'url(' + q + new URL(u.trim(), from).href + q + ')'; } catch (e) { return all; }
        });
    }

    // A same-origin stylesheet's text, its @imports written in (a few levels
    // deep) and its url()s absolute. Read from the file, never rebuilt from
    // the CSSOM: Chromium writes some var() shorthands back out empty.
    function sheetText(href, depth) {
        if (!sameOrigin(href)) return Promise.resolve('');
        return fetch(href).then(function (r) { return r.ok ? r.text() : ''; }).catch(function () { return ''; }).then(function (css) {
            var jobs = [], IMPORT = /@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?\s*([^;]*);/gi;
            css = css.replace(IMPORT, function (all, q, u, media) {
                var i = jobs.length, to = new URL(u, href).href;
                jobs.push(depth > 3 ? Promise.resolve('') : sheetText(to, depth + 1).then(function (t) {
                    media = media.trim();
                    return media && !/^all$/i.test(media) ? '@media ' + media + ' {\n' + t + '\n}' : t;
                }));
                return '\u0000import' + i + '\u0000';
            });
            css = absolute(css, href);
            return Promise.all(jobs).then(function (done) {
                return css.replace(/\u0000import(\d+)\u0000/g, function (a, i) { return done[+i]; });
            });
        });
    }

    var hasLinkedSheet = function (html) { return /<link\b[^>]*rel\s*=\s*["']?[^"'>]*stylesheet/i.test(html); };

    // Same-origin <link rel=stylesheet>s replaced by <style>s holding their
    // text; others dropped (nothing outside is fetched). Returns the doc.
    function inlineLinks(doc, base) {
        return Promise.all(Array.prototype.map.call(doc.querySelectorAll('link[rel~="stylesheet"][href]'), function (l) {
            var href = new URL(l.getAttribute('href'), base).href;
            if (!sameOrigin(href)) { l.remove(); return null; }
            return sheetText(href, 0).then(function (css) {
                var s = doc.createElement('style');
                var media = l.getAttribute('media');
                if (media && !/^\s*all\s*$/i.test(media)) s.setAttribute('media', media);
                s.textContent = css;
                l.replaceWith(s);
            });
        })).then(function () { return doc; });
    }

    function serialize(doc) { return '<!DOCTYPE html>\n' + doc.documentElement.outerHTML; }

    // For the PDF: the same document with its stylesheets written in.
    function withSheets(html, base) {
        if (!hasLinkedSheet(html)) return Promise.resolve(html);
        return inlineLinks(new DOMParser().parseFromString(html, 'text/html'), base).then(serialize);
    }

    // unicode-range: [[lo, hi], …]
    function ranges(v) {
        return String(v).split(',').map(function (p) {
            var m = /u\+([0-9a-f?]+)(?:-([0-9a-f]+))?/i.exec(p);
            if (!m) return null;
            return [parseInt(m[1].replace(/\?/g, '0'), 16), parseInt((m[2] || m[1]).replace(/\?/g, 'f'), 16)];
        }).filter(Boolean);
    }

    // Drop @font-face rules the document cannot use: a family no rule names,
    // or a unicode-range none of its characters falls in.
    function usedFaces(css, chars, families) {
        return css.replace(/@font-face\s*\{[^{}]*\}/gi, function (face) {
            var fam = /font-family\s*:\s*(["']?)([^;"'}]+)\1/i.exec(face);
            if (fam && families.indexOf(fam[2].trim().toLowerCase()) < 0) return '';
            var ur = /unicode-range\s*:\s*([^;}]+)/i.exec(face);
            if (!ur) return face;
            var rs = ranges(ur[1]);
            for (var i = 0; i < chars.length; i++) {
                for (var j = 0; j < rs.length; j++) if (chars[i] >= rs[j][0] && chars[i] <= rs[j][1]) return face;
            }
            return '';
        });
    }

    // Every same-origin url() in css written in as data.
    function embedUrls(css, cache) {
        var urls = [];
        css.replace(URL_RE, function (all, q, u) { if (/^(https?:|blob:)/i.test(u) && (sameOrigin(u) || /^blob:/i.test(u)) && urls.indexOf(u) < 0) urls.push(u); return all; });
        return Promise.all(urls.map(function (u) {
            if (!cache[u]) cache[u] = fetch(u).then(function (r) { return r.ok ? r.blob() : null; })
                .then(function (b) { return b ? asDataUrl(b) : null; }).catch(function () { return null; });
            return cache[u];
        })).then(function (datas) {
            return css.replace(URL_RE, function (all, q, u) {
                var i = urls.indexOf(u);
                return i >= 0 && datas[i] ? 'url("' + datas[i] + '")' : all;
            });
        });
    }

    // A variable font listed once per weight with the same file: written in,
    // that file would repeat each time. Faces that differ only in weight
    // become one face covering the weight range.
    function mergeFaces(css) {
        var groups = {}, order = [];
        var out = css.replace(/@font-face\s*\{[^{}]*\}/gi, function (face) {
            var w = /font-weight\s*:\s*(\d+)\s*(?:;|\})/i.exec(face);
            if (!w) return face;
            var key = face.replace(/font-weight\s*:\s*\d+\s*;?/i, '');
            if (!groups[key]) { groups[key] = { face: face, lo: +w[1], hi: +w[1] }; order.push(key); return '\u0000face' + (order.length - 1) + '\u0000'; }
            groups[key].lo = Math.min(groups[key].lo, +w[1]);
            groups[key].hi = Math.max(groups[key].hi, +w[1]);
            return '';
        });
        return out.replace(/\u0000face(\d+)\u0000/g, function (a, i) {
            var g = groups[order[+i]];
            return g.lo === g.hi ? g.face : g.face.replace(/font-weight\s*:\s*\d+/i, 'font-weight: ' + g.lo + ' ' + g.hi);
        });
    }

    // The report as one standalone file. A document that already stands
    // alone (no script, no linked stylesheet, no picture or url() by
    // address) comes back byte for byte; otherwise its scripts and event
    // attributes go (a bare print() button keeps working), and its
    // same-origin stylesheets, fonts (only the faces its text uses) and
    // pictures are written into it.
    var PRINT_ONLY = /^\s*(?:window\.)?print\(\)\s*;?\s*(?:return\s+false\s*;?\s*)?$/;
    function htmlFile(html, opts) {
        html = String(html || '');
        opts = opts || {};
        var needs = /<script\b/i.test(html) || hasLinkedSheet(html) ||
            /<img\b[^>]*\bsrc\s*=\s*["']?(?!data:)[^"'\s>]/i.test(html) || /<[a-z][^>]*\son[a-z]+\s*=/i.test(html) ||
            /url\(\s*["']?(?!data:|#|["')])/i.test(html);
        if (!needs) return Promise.resolve(html);
        var doc = new DOMParser().parseFromString(html, 'text/html');
        Array.prototype.forEach.call(doc.querySelectorAll('script, noscript'), function (n) { n.remove(); });
        Array.prototype.forEach.call(doc.querySelectorAll('*'), function (el) {
            Array.prototype.slice.call(el.attributes).forEach(function (a) {
                if (/^on/i.test(a.name) && !(a.name.toLowerCase() === 'onclick' && PRINT_ONLY.test(a.value))) el.removeAttribute(a.name);
            });
        });
        var base = opts.base || document.baseURI;
        var cache = {};
        return inlineLinks(doc, base).then(function () {
            var styles = Array.prototype.slice.call(doc.querySelectorAll('style'));
            var styled = Array.prototype.slice.call(doc.querySelectorAll('[style]'));
            // What the fonts are judged against: every character, every family named outside @font-face.
            var text = (doc.title || '') + ' ' + (doc.body ? doc.body.textContent : '');
            var chars = [], seen = {};
            for (var ch of text) { var c = ch.codePointAt(0); if (!seen[c]) { seen[c] = 1; chars.push(c); } }
            var named = styles.map(function (s) { return s.textContent.replace(/@font-face\s*\{[^{}]*\}/gi, ''); }).join('\n') +
                styled.map(function (e) { return e.getAttribute('style'); }).join('\n');
            var families = [];
            named.replace(/font(?:-family)?\s*:\s*([^;{}]+)/gi, function (a, list) {
                list.split(',').forEach(function (f) { families.push(f.replace(/["']/g, '').trim().toLowerCase()); });
                return a;
            });
            // A family may be named in a custom property (--font-sans: 'IBM Plex Sans', …).
            named.replace(/--[\w-]+\s*:\s*([^;{}]+)/g, function (a, list) {
                list.split(',').forEach(function (f) { families.push(f.replace(/["']/g, '').trim().toLowerCase()); });
                return a;
            });
            var jobs = styles.map(function (s) {
                return embedUrls(absolute(usedFaces(s.textContent, chars, families), base), cache).then(function (css) { s.textContent = mergeFaces(css); });
            }).concat(styled.map(function (e) {
                return embedUrls(absolute(e.getAttribute('style'), base), cache).then(function (css) { e.setAttribute('style', css); });
            })).concat(Array.prototype.map.call(doc.querySelectorAll('img[src]'), function (img) {
                var src = img.getAttribute('src');
                if (/^data:/i.test(src)) return null;
                var url = new URL(src, base).href;
                if (!sameOrigin(url) && !/^blob:/i.test(url)) return null;
                return fetch(url).then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
                    return b ? asDataUrl(b) : null;
                }).then(function (data) { if (data) img.setAttribute('src', data); }).catch(function () { /* keep the address */ });
            }));
            return Promise.all(jobs);
        }).then(function () {
            if (!doc.querySelector('meta[charset]')) {
                var m = doc.createElement('meta');
                m.setAttribute('charset', 'utf-8');
                doc.head.insertBefore(m, doc.head.firstChild);
            }
            return serialize(doc);
        });
    }

    /* ---- saving --------------------------------------------------------- */

    function save(blob, name) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.rel = 'noopener';
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
    }

    // cfg: { html, name, format: 'pdf' | 'html', title, page, fonts, producer, base }
    function download(cfg) {
        var format = cfg.format === 'html' ? 'html' : 'pdf';
        var name = fileName(cfg.name, format);
        var made = format === 'html'
            ? htmlFile(cfg.html, cfg).then(function (s) { return new Blob([s], { type: 'text/html;charset=utf-8' }); })
            : pdf(cfg.html, cfg);
        return made.then(function (blob) {
            (typeof cfg.save === 'function' ? cfg.save : save)(blob, name);
            return { ok: true, name: name, format: format };
        }, function (e) {
            try { console.error('CarinoPdf:', e); } catch (e2) { /* ignore */ }
            return { ok: false, name: name, format: format, error: (e && e.message) || String(e) };
        });
    }

    /* ---- the PDF | HTML switch ----------------------------------------- */

    function remembered() {
        try { var v = localStorage.getItem(KEY); return v === 'html' || v === 'pdf' ? v : null; } catch (e) { return null; }
    }
    function remember(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode */ } }

    var switches = 0;
    // A radio group drawn as two toggle buttons: arrows move, the choice is
    // remembered for this site. Goes in .rpv-side, just above .rpv-name.
    function formatSwitch(cfg) {
        cfg = cfg || {};
        var id = 'rpvFormat' + (++switches);
        var el = document.createElement('div');
        el.className = 'rpv-format';
        el.setAttribute('role', 'radiogroup');
        el.setAttribute('aria-labelledby', id);
        var lab = document.createElement('span');
        lab.className = 'rpv-format-label';
        lab.id = id;
        el.appendChild(lab);
        var seg = document.createElement('span');
        seg.className = 'rpv-format-seg';
        el.appendChild(seg);
        var value = cfg.value || remembered() || 'pdf';
        var btns = ['pdf', 'html'].map(function (f) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'toggle-btn';
            b.setAttribute('role', 'radio');
            b.setAttribute('data-format', f);
            b.addEventListener('click', function () { set(f, true); });
            b.addEventListener('keydown', function (e) {
                if (!/^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown)$/.test(e.key)) return;
                e.preventDefault();
                var other = f === 'pdf' ? 'html' : 'pdf';
                set(other, true);
                btns[other === 'pdf' ? 0 : 1].focus();
            });
            seg.appendChild(b);
            return b;
        });
        function paint() {
            btns.forEach(function (b) {
                var on = b.getAttribute('data-format') === value;
                b.classList.toggle('active', on);
                b.setAttribute('aria-checked', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
            });
        }
        function relabel() {
            lab.textContent = tr('File');
            btns[0].textContent = tr('PDF');
            btns[1].textContent = tr('HTML');
        }
        function set(v, byUser) {
            v = v === 'html' ? 'html' : 'pdf';
            var changed = v !== value;
            value = v;
            paint();
            if (byUser) remember(v);
            if (changed && typeof cfg.onChange === 'function') cfg.onChange(v);
        }
        relabel();
        paint();
        return { el: el, get: function () { return value; }, set: set, relabel: relabel };
    }

    function label(format) { return tr(format === 'html' ? 'Download HTML' : 'Download PDF'); }

    api.pdf = pdf;
    api.htmlFile = htmlFile;
    api.withSheets = withSheets;
    api.spellOut = spellOut;
    api.measure = measure;
    api.download = download;
    api.save = save;
    api.formatSwitch = formatSwitch;
    api.label = label;
    api.remembered = remembered;
    api.loadLib = loadLib;
    window.CarinoPdf = api;
}());
