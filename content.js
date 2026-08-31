(async () => {
    if (window.themerLoaded) return;
    window.themerLoaded = true;

    let activeTheme = null;
    let observer = null;
    let pendingMutations = new Set();
    let mutationTimeout = null;
    let mutationFallback = null;
    let hasNewIframes = false;
    // Measured once, before we force any colours of our own.
    // Lightness of the page's own base surface; every colour is mapped relative to it.
    let PAGE_BASE_RGB = null;

    // Original computed values live here rather than in data-og-* attributes, so a
    // theme switch can never re-read our own output as the "original" colour.
    const originalStyles = new WeakMap();
    const backdropCache = new WeakMap();
    const parseCache = new Map();
    const mapCache = new Map();

    // Google Docs is fully handled by site-specific CSS — nothing to walk.
    const skipJsProcessing = window.location.hostname === 'docs.google.com' &&
        window.location.pathname.startsWith('/document');

    // Tag names are compared upper-cased: SVG elements report their tagName in the
    // original case ('path', 'clipPath'), so an upper-case-only list silently misses them.
    const SKIP_TAGS = new Set([
        'SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TITLE', 'HEAD', 'BASE', 'TEMPLATE',
        'DEFS', 'SYMBOL', 'MARKER', 'MASK', 'CLIPPATH', 'SOURCE', 'TRACK', 'MAP', 'AREA',
        // Native widgets lose their platform rendering entirely once a colour is forced.
        'PROGRESS', 'METER'
    ]);

    // Replaced content: forcing a background on these shows through transparent images and
    // repaints video letterboxing, but their CSS borders still have to be themed — a white
    // border that was invisible on a white page becomes a glaring outline on a dark one.
    const MEDIA_TAGS = new Set([
        'IMG', 'PICTURE', 'VIDEO', 'AUDIO', 'CANVAS', 'EMBED', 'OBJECT', 'IFRAME'
    ]);

    const SVG_TAGS = new Set([
        'SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'ELLIPSE', 'LINE', 'POLYLINE',
        'G', 'TEXT', 'TSPAN', 'USE', 'STOP'
    ]);

    const SKIP_INPUT_TYPES = new Set(['checkbox', 'radio', 'range', 'color', 'file', 'image']);

    // Text-entry controls are wells, not panels — see the 'field' role in computeMappedColor.
    const FIELD_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

    // Text needs to be readable; a divider needs to be barely there. Borders are capped as
    // well as floored, so a hairline that was subtle on a light page cannot invert into a
    // glaring one. Coloured borders get a looser cap: they are usually deliberate emphasis,
    // but a pale accent still should not end up as the loudest thing on the page.
    const TEXT_MIN_CONTRAST = 4.5;
    const MARK_MIN_CONTRAST = 3;
    const BORDER_MIN_CONTRAST = 1.25;
    const BORDER_VISIBLE_THRESHOLD = 1.08;
    const BORDER_MAX_CONTRAST = 2.6;
    const ACCENT_BORDER_MAX_CONTRAST = 4.5;

    // How far a surface may sit above the theme background before compression kicks in.
    const SURFACE_KNEE_CONTRAST = 2.0;
    const SURFACE_MAX_CONTRAST = 2.8;
    const SURFACE_COMPRESSION = 6;
    const FIELD_MAX_CONTRAST = 1.8;
    const WHITE_RGB = [255, 255, 255];
    const MUTATION_FALLBACK_MS = 250;

    // Everything we may write inline, so a theme switch can hand the page back cleanly.
    const OWNED_PROPS = [
        'background-color', 'background-image', 'color', 'border-radius',
        'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color',
        'border-color', 'fill', 'stroke', 'stop-color'
    ];
    const BORDER_SIDES = [
        ['borderTopColor', 'borderTopWidth', 'borderTopStyle'],
        ['borderRightColor', 'borderRightWidth', 'borderRightStyle'],
        ['borderBottomColor', 'borderBottomWidth', 'borderBottomStyle'],
        ['borderLeftColor', 'borderLeftWidth', 'borderLeftStyle']
    ];
    const PLACEHOLDER_CLASS = 'theme-fix-placeholder';
    const PLACEHOLDER_SELECTOR = `.${PLACEHOLDER_CLASS}`.repeat(10) + '::placeholder';
    const PSEUDO_KEYS = ['before', 'after'];
    const PSEUDO_PARTS = ['bg', 'border', 'text'];

    // Register the listener before any await so messages are never lost.
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'setTheme' && request.themeData) {
            initTheme(request.themeData);
            // Answering lets the popup tell "nobody is listening" apart from "listener ran
            // but never replied" — without it, both look like the same lastError and the
            // popup cannot skip a redundant injection.
            sendResponse({ applied: true });
        }
    });

    // Auto mode injects at document_start, so read the stored theme directly instead of
    // waiting for a message — that round-trip is what made pages flash white first.
    try {
        const stored = await chrome.storage.local.get(['autoMode', 'preferredThemeData']);
        if (stored.autoMode && stored.preferredThemeData && !activeTheme) {
            initTheme(stored.preferredThemeData);
        }
    } catch (e) {
        // Storage unavailable (e.g. orphaned content script) — the popup path still works.
    }

    function initTheme(theme) {
        // Only animate a deliberate theme switch. On first application the tab may be in
        // the background, where a transition sits frozen at currentTime 0 — and a running
        // transition outranks !important, so the page would commit its original light
        // colours and then animate to dark the moment the user switches to the tab.
        const isSwitch = activeTheme !== null;
        activeTheme = theme;
        mapCache.clear();

        // Safe before <body> exists: paints the root dark on the very first frame.
        injectGlobalStyles(theme, isSwitch);
        injectPseudoStyles();
        injectSiteSpecificStyles(theme);
        paintRoot(theme);

        whenBodyReady(() => {
            if (PAGE_BASE_RGB === null) PAGE_BASE_RGB = measureOriginalBase();
            forEachThemedDocument(doc => {
                doc.querySelectorAll('[data-theme-processed]').forEach(resetElement);
            });
            processNode(document.body);
            forceRootBackground(theme);
            processIframes();
            startObserver();
        });
    }

    function whenBodyReady(fn) {
        if (document.body) { fn(); return; }
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
            return;
        }
        fn(); // XML/SVG document with no <body> — fn tolerates it
    }

    function forEachThemedDocument(fn) {
        fn(document);
        document.querySelectorAll('iframe').forEach(iframe => {
            try {
                const doc = iframe.contentDocument;
                if (doc) fn(doc);
            } catch (e) { /* cross-origin */ }
        });
    }

    function resetElement(el) {
        el.removeAttribute('data-theme-processed');
        OWNED_PROPS.forEach(p => el.style.removeProperty(p));
        PSEUDO_KEYS.forEach(key => PSEUDO_PARTS.forEach(part => {
            el.classList.remove(`theme-fix-${key}-${part}`);
            el.style.removeProperty(`--tf-${key}-${part}`);
        }));
        // Left behind by versions that cached originals in the DOM.
        [...el.attributes]
            .filter(a => a.name.startsWith('data-og-'))
            .forEach(a => el.removeAttribute(a.name));
        el.classList.remove('theme-fix-before', 'theme-fix-after');
        el.classList.remove(PLACEHOLDER_CLASS);
        el.style.removeProperty('--tf-placeholder');
    }

    function startObserver() {
        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
            for (const m of mutations) {
                for (const n of m.addedNodes) {
                    if (n.nodeType !== 1) continue;
                    pendingMutations.add(n);
                    if (n.tagName === 'IFRAME' || (n.querySelector && n.querySelector('iframe'))) {
                        hasNewIframes = true;
                    }
                }
            }
            // Schedule once instead of cancel-and-reschedule: cancelling dropped the
            // iframe flag captured by the previous closure, and a page that mutates
            // every frame could starve the flush indefinitely.
            //
            // Paired with a timer, because requestAnimationFrame never fires in a background
            // tab: a page that loads hidden and keeps adding content would stay unthemed
            // until focused, then visibly catch up. Whichever fires first cancels the other.
            if (mutationTimeout === null) {
                mutationTimeout = requestAnimationFrame(flushMutations);
                mutationFallback = setTimeout(flushMutations, MUTATION_FALLBACK_MS);
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    function flushMutations() {
        if (mutationTimeout !== null) cancelAnimationFrame(mutationTimeout);
        if (mutationFallback !== null) clearTimeout(mutationFallback);
        mutationTimeout = null;
        mutationFallback = null;
        const nodes = [...pendingMutations];
        pendingMutations.clear();
        const needIframes = hasNewIframes;
        hasNewIframes = false;

        nodes.forEach(node => { if (node.isConnected) processNode(node); });
        if (needIframes) processIframes();
    }

    function injectGlobalStyles(theme, animate) {
        const old = document.getElementById('theme-global-styles');
        if (old) old.remove();

        const { h, s, l } = theme.neutrals.bg;
        const { h: fh, s: fs, l: fl } = theme.neutrals.fg;
        const trackColor = `hsl(${h}, ${s}%, ${Math.min(l + 4, 100)}%)`;
        const thumbColor = `hsl(${h}, ${s}%, ${Math.min(l + 18, 100)}%)`;
        const thumbHoverColor = `hsl(${h}, ${s}%, ${Math.min(l + 28, 100)}%)`;
        const fgVal = `hsl(${fh}, ${fs}%, ${fl}%)`;
        const mutedFg = `hsl(${fh}, ${fs}%, ${Math.round((fl + l) / 2)}%)`;
        const accent = (theme.accents && theme.accents[0]) || { h: fh, s: 40, l: 60 };
        const selectionBg = `hsl(${accent.h}, ${Math.min(accent.s, 60)}%, 32%)`;

        const style = document.createElement('style');
        style.id = 'theme-global-styles';
        style.textContent = `
            :root {
                /* Fixes native form controls, date pickers and default scrollbars for free. */
                color-scheme: ${theme.type === 'light' ? 'light' : 'dark'} !important;
            }
            ${animate ? `html, body {
                transition: background-color 0.3s ease, color 0.3s ease;
            }` : ''}
            /* Placeholders are mapped per field against that field's own fill — see
               collectPlaceholder(). A single theme-wide placeholder colour is unreadable the
               moment a field's background maps to anything other than the page surface. */
            ${PLACEHOLDER_SELECTOR} {
                color: var(--tf-placeholder) !important;
                opacity: 1 !important;
            }
            input, textarea, select, [contenteditable] {
                /* Follows the field's own mapped text colour rather than a fixed one. */
                caret-color: currentColor !important;
            }
            ::selection {
                background-color: ${selectionBg} !important;
                color: ${fgVal} !important;
            }
            ::-webkit-scrollbar {
                width: 12px;
                height: 12px;
            }
            ::-webkit-scrollbar-track {
                background: ${trackColor};
            }
            ::-webkit-scrollbar-thumb {
                background: ${thumbColor};
                border-radius: 6px;
                border: 2px solid ${trackColor};
            }
            ::-webkit-scrollbar-thumb:hover {
                background: ${thumbHoverColor};
            }
        `;
        (document.head || document.documentElement).appendChild(style);
    }

    function paintRoot(theme) {
        const old = document.getElementById('theme-root-styles');
        if (old) old.remove();

        const { h, s, l } = theme.neutrals.bg;
        const { h: fh, s: fs, l: fl } = theme.neutrals.fg;
        const bgVal = `hsl(${h}, ${s}%, ${l}%)`;

        const style = document.createElement('style');
        style.id = 'theme-root-styles';
        style.textContent = `
            html, body {
                background-color: ${bgVal} !important;
                color: hsl(${fh}, ${fs}%, ${fl}%) !important;
            }
        `;
        (document.head || document.documentElement).appendChild(style);
        document.documentElement.style.setProperty('background-color', bgVal, 'important');
    }

    function isNativeWidget(el) {
        return el.tagName === 'INPUT' && SKIP_INPUT_TYPES.has((el.type || '').toLowerCase());
    }

    function processNode(root) {
        if (skipJsProcessing || !root || !activeTheme) return;
        const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [root];

        // Pass 1 — read only. Interleaving reads with inline-style writes forced a style
        // recalc per element, which is what made large pages crawl.
        const writes = [];
        const classAdds = [];
        const restoreOwnStyles = suspendOwnStyles(root);

        try {
        for (const el of elements) {
            if (!el || el.nodeType !== 1) continue;
            const tag = (el.tagName || '').toUpperCase();
            if (SKIP_TAGS.has(tag) || isNativeWidget(el)) continue;
            if (el.dataset.themeProcessed) continue;
            el.dataset.themeProcessed = 'true';

            const view = el.ownerDocument.defaultView || window;
            const style = view.getComputedStyle(el);

            const queue = (prop, type) => {
                const val = getOriginalStyle(el, style, prop);
                if (!val || val === 'none' || val === 'auto' || val.startsWith('url(')) return;
                const color = parseColor(val);
                if (!color || color.a <= 0) return;
                // Borders and text are seen against the thing they sit on, not against the
                // page. Measured against the page, a red border on a red button looks bold
                // and gets promoted into a bright outline, when in reality it is invisible.
                const backdrop = type === 'bg' ? null : originalBackdrop(el, view, style);
                writes.push([el, toCssProp(prop), mapColorToTheme(color, activeTheme, type, backdrop)]);
            };

            if (SVG_TAGS.has(tag)) {
                // An icon is a foreground mark, not a surface and not a divider. Roling
                // fill as a surface capped a black icon at 2.6:1 and roling stroke as a
                // border did the same, so icons washed out against whatever they sat on.
                queue('fill', 'mark');
                if (parseFloat(style.strokeWidth) !== 0) queue('stroke', 'mark');
                queue('stopColor', 'bg');
            } else {
                // Per-side, because the borderColor shorthand serialises all four values
                // when they differ and would collapse them to whichever came first.
                //
                // Sides that draw nothing are skipped. Colouring an absent border is
                // meaningless on its own, but it is also actively harmful: some sites key
                // off the *text* of the style attribute (`[style*="border-color"]`) to turn
                // border-style on, so writing a colour onto a border-less element makes the
                // page draw a real 3px box around it — an outline around every inline
                // element we touched, with nothing wrong with the colour itself.
                for (const [colorProp, widthProp, styleProp] of BORDER_SIDES) {
                    const width = parseFloat(style[widthProp]) || 0;
                    const lineStyle = style[styleProp];
                    if (width <= 0 || lineStyle === 'none' || lineStyle === 'hidden') continue;
                    queue(colorProp, 'border');
                }
            }
            queue('color', 'text');

            if (tag === 'INPUT' || tag === 'TEXTAREA') {
                collectPlaceholder(el, view, style, writes, classAdds);
            }

            // Replaced content keeps its own fill — see MEDIA_TAGS.
            if (MEDIA_TAGS.has(tag)) continue;

            const surfaceRole = FIELD_TAGS.has(tag) ? 'field' : 'bg';
            const bg = parseColor(getOriginalStyle(el, style, 'backgroundColor'));
            if (bg && bg.a > 0) {
                writes.push([el, 'background-color', mapColorToTheme(bg, activeTheme, surfaceRole)]);
            }

            const bgImg = getOriginalStyle(el, style, 'backgroundImage');
            if (bgImg && bgImg !== 'none') {
                const remapped = remapBackgroundImage(bgImg);
                if (remapped !== bgImg) writes.push([el, 'background-image', remapped]);
            }

            collectPseudo(el, view, 'before', writes, classAdds);
            collectPseudo(el, view, 'after', writes, classAdds);
        }
        } finally {
            restoreOwnStyles();
        }

        // Pass 2 — write only.
        for (const [el, prop, value] of writes) el.style.setProperty(prop, value, 'important');
        for (const [el, cls] of classAdds) el.classList.add(cls);
    }

    // The read pass has to see the page as the page authored it. paintRoot() and
    // forceRootBackground() set colour and background on <html>/<body> before a single
    // element is read, and colour INHERITS — so without this, every element that inherits
    // its colour caches our own foreground as its "original" and gets remapped from our
    // output instead of the page's. Symptom: all text pinned to the contrast floor, and
    // borders measured against the theme background rather than the real page surface.
    // Ancestors are included too, so nodes arriving via a mutation are read correctly.
    function suspendOwnStyles(root) {
        const doc = root.ownerDocument || document;
        const sheet = doc.getElementById('theme-root-styles');
        const wasDisabled = sheet ? sheet.disabled : null;
        if (sheet) sheet.disabled = true;

        const saved = [];
        const strip = (el) => {
            if (!el || el.nodeType !== 1) return;
            const bg = el.style.getPropertyValue('background-color');
            const color = el.style.getPropertyValue('color');
            if (!bg && !color) return;
            saved.push([el, bg, color]);
            el.style.removeProperty('background-color');
            el.style.removeProperty('color');
        };
        strip(doc.documentElement);
        strip(doc.body);
        for (let node = root.parentElement; node; node = node.parentElement) strip(node);

        return () => {
            for (const [el, bg, color] of saved) {
                if (bg) el.style.setProperty('background-color', bg, 'important');
                if (color) el.style.setProperty('color', color, 'important');
            }
            if (sheet) sheet.disabled = wasDisabled;
        };
    }

    function toCssProp(prop) {
        return prop.replace(/([A-Z])/g, '-$1').toLowerCase();
    }

    function getOriginalStyle(el, computedStyle, prop) {
        let cache = originalStyles.get(el);
        if (!cache) { cache = {}; originalStyles.set(el, cache); }
        if (!(prop in cache)) cache[prop] = computedStyle[prop];
        return cache[prop];
    }

    function remapBackgroundImage(originalString) {
        // Mask url()/data: segments first — a bare hex regex happily rewrites the
        // fragment in "sprite.png#a1b2c3" or an escaped %23fff inside an SVG data URI.
        const urls = [];
        let masked = originalString.replace(/url\((?:"[^"]*"|'[^']*'|[^)]*)\)/g, (m) => {
            urls.push(m);
            return `__THEME_URL_${urls.length - 1}__`;
        });

        const remap = (match) => {
            const color = parseColor(match);
            return color ? mapColorToTheme(color, activeTheme, 'bg') : match;
        };
        masked = masked
            .replace(/\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^()]*\)/gi, remap)
            .replace(/#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b/g, remap);

        return masked.replace(/__THEME_URL_(\d+)__/g, (_, i) => urls[+i]);
    }

    // A placeholder sits inside its field, so it is mapped against that field's own fill.
    // Driving it from a single theme-level colour meant that any field whose background did
    // not land on the page surface got light-on-light placeholder text.
    function collectPlaceholder(el, view, style, writes, classAdds) {
        const placeholderStyle = view.getComputedStyle(el, '::placeholder');
        const color = parseColor(placeholderStyle && placeholderStyle.color);
        if (!color || color.a <= 0) return;

        const backdrop = originalBackdrop(el, view, style);
        writes.push([el, '--tf-placeholder', mapColorToTheme(color, activeTheme, 'text', backdrop)]);
        classAdds.push([el, PLACEHOLDER_CLASS]);
    }

    function collectPseudo(el, view, key, writes, classAdds) {
        const style = view.getComputedStyle(el, `::${key}`);
        const content = style.content;
        if (!content || content === 'none' || content === 'normal') return;

        const map = (val, type, backdrop) => {
            const color = parseColor(val);
            return color && color.a > 0 ? mapColorToTheme(color, activeTheme, type, backdrop) : null;
        };

        const bg = map(style.backgroundColor, 'bg');
        if (bg) {
            writes.push([el, `--tf-${key}-bg`, bg]);
            classAdds.push([el, `theme-fix-${key}-bg`]);
        }

        if (parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none') {
            // The pseudo's own fill if it has one, otherwise whatever it sits on.
            const own = parseColor(style.backgroundColor);
            const backdrop = own && own.a > 0.95
                ? [own.r, own.g, own.b]
                : originalBackdrop(el, view);
            const border = map(style.borderTopColor, 'border', backdrop);
            if (border) {
                writes.push([el, `--tf-${key}-border`, border]);
                classAdds.push([el, `theme-fix-${key}-border`]);
            }
        }

        const text = map(style.color, 'text', originalBackdrop(el, view));
        if (text) {
            writes.push([el, `--tf-${key}-text`, text]);
            classAdds.push([el, `theme-fix-${key}-text`]);
        }
    }

    function injectPseudoStyles() {
        const oldStyle = document.getElementById('theme-pseudo-styles');
        if (oldStyle) oldStyle.remove();

        // One class per property. A single blanket rule meant an unset custom property
        // resolved to `unset` — erasing backgrounds we never mapped — and the old
        // `background-image: none` wiped every pseudo-element icon on the page.
        const boost = (cls) => cls.repeat(10);
        const css = PSEUDO_KEYS.map(key => `
            ${boost(`.theme-fix-${key}-bg`)}::${key} {
                background-color: var(--tf-${key}-bg) !important;
            }
            ${boost(`.theme-fix-${key}-border`)}::${key} {
                border-color: var(--tf-${key}-border) !important;
                stroke: var(--tf-${key}-border) !important;
            }
            ${boost(`.theme-fix-${key}-text`)}::${key} {
                color: var(--tf-${key}-text) !important;
                fill: var(--tf-${key}-text) !important;
            }
        `).join('\n');

        const style = document.createElement('style');
        style.id = 'theme-pseudo-styles';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function forceRootBackground(theme, doc) {
        doc = doc || document;
        const { h, s, l } = theme.neutrals.bg;
        const { h: fh, s: fs, l: fl } = theme.neutrals.fg;
        const bgVal = `hsl(${h}, ${s}%, ${l}%)`;
        const fgVal = `hsl(${fh}, ${fs}%, ${fl}%)`;

        [doc.documentElement, doc.body].forEach(el => {
            if (!el) return;
            el.style.setProperty('background-color', bgVal, 'important');
            el.style.setProperty('color', fgVal, 'important');
        });
    }

    function injectSiteSpecificStyles(theme) {
        const old = document.getElementById('theme-site-styles');
        if (old) old.remove();

        const { h, s, l } = theme.neutrals.bg;
        const { h: fh, s: fs, l: fl } = theme.neutrals.fg;
        const host = window.location.hostname;
        const path = window.location.pathname;
        let css = '';

        // Google Docs
        if (host === 'docs.google.com' && path.startsWith('/document')) {
            const bg = `hsl(${h}, ${s}%, ${l}%)`;
            const pageBg = `hsl(${h}, ${s}%, ${Math.min(l + 6, 100)}%)`;
            const surfaceBg = `hsl(${h}, ${s}%, ${Math.min(l + 4, 100)}%)`;
            const fg = `hsl(${fh}, ${fs}%, ${fl}%)`;
            const border = `hsl(${h}, ${s}%, ${Math.min(l + 12, 100)}%)`;

            css += `
                /* === Editor & page area === */
                #docs-editor-container,
                #docs-editor,
                .kix-appview,
                .kix-appview-editor-container {
                    background-color: ${bg} !important;
                }

                /* Invert ALL editor content — works for both canvas and DOM rendering */
                .kix-appview-editor {
                    filter: invert(1) hue-rotate(180deg) !important;
                }

                /* Double-invert media so images/videos look normal */
                .kix-appview-editor img,
                .kix-appview-editor video {
                    filter: invert(1) hue-rotate(180deg) !important;
                }

                /* === Header & titlebar === */
                #docs-header-container,
                #docs-header,
                .docs-titlebar-container,
                #docs-titlebar-container,
                #docs-titlebar,
                .docs-title-outer,
                .docs-title-widget,
                #docs-branding-container {
                    background-color: ${bg} !important;
                    color: ${fg} !important;
                }
                .docs-title-input-label-inner {
                    color: ${fg} !important;
                }
                .docs-title-input {
                    color: transparent !important;
                    caret-color: ${fg} !important;
                }
                .docs-title-input:focus {
                    color: ${fg} !important;
                }
                /* Titlebar right-side buttons (share, comments, meet) */
                .docs-titlebar-buttons,
                .docs-titlebar-buttons * {
                    color: ${fg} !important;
                }

                /* === Menubar === */
                #docs-menubar,
                .docs-menubar {
                    background-color: ${bg} !important;
                    color: ${fg} !important;
                }
                .menu-button,
                .docs-menubar .goog-control {
                    color: ${fg} !important;
                }

                /* === Toolbar === */
                #docs-toolbar-wrapper,
                .docs-main-toolbars,
                #docs-primary-toolbars {
                    background-color: ${surfaceBg} !important;
                }
                #docs-toolbar,
                .goog-toolbar,
                #docs-omnibox-toolbar {
                    background-color: ${surfaceBg} !important;
                    color: ${fg} !important;
                }
                /* Ensure ALL toolbar text inherits light color */
                #docs-toolbar *,
                #docs-omnibox-toolbar * {
                    color: ${fg} !important;
                }

                /* Toolbar buttons */
                .goog-toolbar-button:hover,
                .goog-toolbar-button.goog-toolbar-button-hover {
                    background-color: ${pageBg} !important;
                }

                /* Toolbar inputs (font picker, size) */
                #docs-font-family,
                .goog-toolbar-combo-button,
                .goog-toolbar-menu-button {
                    background-color: ${surfaceBg} !important;
                    border-color: ${border} !important;
                }
                .docs-font-size-widget input {
                    background-color: ${surfaceBg} !important;
                    color: ${fg} !important;
                    border-color: ${border} !important;
                }

                /* Omnibox / search */
                .docs-omnibox-input {
                    background-color: ${surfaceBg} !important;
                    color: ${fg} !important;
                    border-color: ${border} !important;
                }

                /* Icons: soften dark sprites for dark bg */
                .docs-icon-img {
                    filter: invert(0.7) !important;
                }

                /* Ruler */
                .docs-ruler,
                .docs-ruler-inner,
                #kix-horizontal-ruler,
                #kix-vertical-ruler,
                #kix-horizontal-ruler-container,
                #kix-vertical-ruler-container {
                    background-color: ${surfaceBg} !important;
                }
                .docs-ruler-inner {
                    filter: invert(0.7) hue-rotate(180deg) !important;
                }

                /* Misc UI containers */
                #docs-bars,
                .docs-additional-bars,
                .docs-banners,
                .docs-butterbar-container,
                #docs-chrome {
                    background-color: ${bg} !important;
                }

                /* Comments sidebar */
                .docos-sidepanel,
                .docos-stream-view,
                .docos-docoview-tesla-conflict,
                .docos-anchoreddocoview {
                    background-color: ${surfaceBg} !important;
                    color: ${fg} !important;
                }

                /* Dropdowns / menus that appear on click */
                .goog-menu,
                .goog-menuitem,
                .docs-menu-attached-button-above,
                .apps-menu-hide-mnemonics {
                    background-color: ${surfaceBg} !important;
                    color: ${fg} !important;
                }
                .goog-menuitem:hover,
                .goog-menuitem-highlight,
                .goog-option-selected {
                    background-color: ${pageBg} !important;
                }
                .goog-menuseparator {
                    border-color: ${border} !important;
                }
            `;
        }

        // Google Sheets: grid canvas
        if (host === 'docs.google.com' && path.startsWith('/spreadsheets')) {
            css += `
                canvas.waffle-grid-container,
                .grid-container canvas {
                    filter: invert(1) hue-rotate(180deg) !important;
                }
            `;
        }

        if (!css) return;
        const style = document.createElement('style');
        style.id = 'theme-site-styles';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
    }

    function processIframes() {
        document.querySelectorAll('iframe').forEach(iframe => {
            const applyToFrame = () => {
                try {
                    const doc = iframe.contentDocument;
                    if (!doc) return;
                    // Replace rather than skip-if-present, so a theme switch reaches frames.
                    ['theme-global-styles', 'theme-pseudo-styles', 'theme-root-styles', 'theme-site-styles']
                        .forEach(id => {
                            const src = document.getElementById(id);
                            const existing = doc.getElementById(id);
                            if (existing) existing.remove();
                            if (src && doc.head) doc.head.appendChild(src.cloneNode(true));
                        });
                    if (!doc.body) return;
                    processNode(doc.body);
                    forceRootBackground(activeTheme, doc);
                } catch (e) { /* cross-origin — covered by the allFrames injection instead */ }
            };

            if (!iframe.dataset.themeListening) {
                iframe.dataset.themeListening = 'true';
                iframe.addEventListener('load', applyToFrame);
            }
            applyToFrame();
        });
    }

    function mapColorToTheme(rgba, theme, type, backdrop) {
        const key = `${rgba.r},${rgba.g},${rgba.b},${rgba.a}|${type}|${backdrop || ''}`;
        const hit = mapCache.get(key);
        if (hit !== undefined) return hit;
        const out = computeMappedColor(rgba, theme, type, backdrop);
        mapCache.set(key, out);
        return out;
    }

    // The first opaque background at or above this element, taken from the cached originals
    // so it is unaffected by anything we have already written. Memoised, and since a child
    // inherits its parent's answer this stays O(1) per element instead of re-walking the
    // ancestor chain for every one of them.
    function originalBackdrop(el, view, ownStyle) {
        const hit = backdropCache.get(el);
        if (hit) return hit;

        const style = ownStyle || view.getComputedStyle(el);
        const own = parseColor(getOriginalStyle(el, style, 'backgroundColor'));
        let result;
        if (own && own.a > 0.95) {
            result = [own.r, own.g, own.b];
        } else {
            const parent = el.parentElement;
            result = parent ? originalBackdrop(parent, view) : (PAGE_BASE_RGB || WHITE_RGB);
        }
        backdropCache.set(el, result);
        return result;
    }

    function computeMappedColor(rgba, theme, type, backdrop) {
        const hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
        // Judge colourfulness by chroma, not HSL saturation. A cream like #fff8e6 reports
        // 100% saturation while being perceptually near-white, and treating it as an accent
        // turns white-ish cards into visibly tinted boxes.
        const chroma = (Math.max(rgba.r, rgba.g, rgba.b) - Math.min(rgba.r, rgba.g, rgba.b)) / 255 * 100;
        const isNeutral = chroma < 12 || hsl.s < 25;

        const isGlaze = rgba.a < 0.85;
        const isSurface = type === 'bg' || type === 'field';

        let finalH, finalS;
        if (isNeutral) {
            finalH = theme.neutrals.bg.h;
            finalS = theme.neutrals.bg.s;
        } else {
            const matched = findClosestAccent(hsl, theme.accents);
            finalH = matched.h;
            // Colour fills are held down in saturation so text stays readable on top of
            // them; coloured text and borders keep the accent at full strength.
            finalS = isSurface ? Math.min(matched.s, 25) : matched.s;
        }

        // A translucent fill is a glaze composited over content that is already themed, so
        // it keeps its own polarity: a scrim must stay dark to dim, a sheen light to lift.
        // Flipping those turns modal backdrops into pale washes.
        if (isGlaze && isSurface) {
            const range = theme.neutrals.fg.l - theme.neutrals.bg.l;
            const glazeL = theme.neutrals.bg.l + (hsl.l / 100) * range;
            return `rgba(${hslToRgb(finalH, finalS, glazeL).join(',')}, ${rgba.a})`;
        }

        // Everything else is placed by how much it stood out on its OWN page — its contrast
        // against that page's base surface — reproduced as contrast against the theme
        // background. Two properties matter. It is luminance-based, so it cannot be upset by
        // one hue being intrinsically brighter than another at the same lightness (green
        // outranks red at equal HSL lightness, which silently reordered chart series). And it
        // is monotonic, so relative prominence is preserved by construction rather than by
        // arithmetic coincidence. Anchoring to the measured base is also what lets one rule
        // serve a white page, an off-white page, an already-dark page and a light theme,
        // with no need to classify the page's polarity at all.
        const reference = backdrop || PAGE_BASE_RGB || WHITE_RGB;
        const srcContrast = contrastRatio([rgba.r, rgba.g, rgba.b], reference);
        // Both halves must use the same frame of reference. Measuring against the element's
        // own backdrop but solving against the theme background is what left a border that
        // was invisible on its button sitting at 2.3:1 once the button itself was themed.
        const themedRef = backdrop ? themedBackdropRgb(backdrop, theme) : null;

        let target;
        if (type === 'text') {
            target = Math.max(srcContrast, TEXT_MIN_CONTRAST);
        } else if (type === 'mark') {
            // Icons and other painted marks: preserve prominence, with WCAG's 3:1 floor for
            // non-text contrast. Not floored to 4.5 like text, so chart fills and decorative
            // artwork are not over-brightened, and not capped like a surface.
            target = Math.max(srcContrast, MARK_MIN_CONTRAST);
        } else if (type === 'border') {
            if (srcContrast < BORDER_VISIBLE_THRESHOLD && themedRef) {
                // The border matched its own fill — the standard way to reserve space for a
                // hover state. Keep it invisible instead of manufacturing an outline.
                return `rgba(${themedRef.join(',')}, ${rgba.a})`;
            }
            // Capped so a strong hairline on a light page cannot invert into a glaring one.
            const cap = isNeutral ? BORDER_MAX_CONTRAST : ACCENT_BORDER_MAX_CONTRAST;
            target = Math.max(Math.min(srcContrast, cap), BORDER_MIN_CONTRAST);
        } else if (type === 'field') {
            // A text-entry control is a well: distinct enough to read as a field, recessive
            // enough not to fight the text inside it. Dark themes conventionally sit these
            // just above the background, so riding the generic surface curve turned a dark
            // search bar into a bright slab with low-contrast content on top of it.
            target = Math.min(compressSurfaceContrast(srcContrast), FIELD_MAX_CONTRAST);
        } else {
            target = compressSurfaceContrast(srcContrast);
        }

        const finalL = lightnessForContrast(theme, finalH, finalS, target, rgba.a, themedRef);
        return `rgba(${hslToRgb(finalH, finalS, finalL).join(',')}, ${rgba.a})`;
    }

    // What this colour's backdrop will look like once it has been themed too.
    function themedBackdropRgb(backdrop, theme) {
        const mapped = parseColor(mapColorToTheme(
            { r: backdrop[0], g: backdrop[1], b: backdrop[2], a: 1 }, theme, 'bg'));
        return mapped ? [mapped.r, mapped.g, mapped.b] : null;
    }

    // Surfaces keep their original prominence outright below the knee, then compress
    // asymptotically, so a black page section becomes an elevation tier rather than a slab
    // while still ranking above every subtler surface.
    function compressSurfaceContrast(srcContrast) {
        if (srcContrast <= SURFACE_KNEE_CONTRAST) return srcContrast;
        const excess = srcContrast - SURFACE_KNEE_CONTRAST;
        const headroom = SURFACE_MAX_CONTRAST - SURFACE_KNEE_CONTRAST;
        return SURFACE_KNEE_CONTRAST + headroom * (excess / (excess + SURFACE_COMPRESSION));
    }

    // Move away from the theme background until the requested contrast is reached, so the
    // result honours the target regardless of how bright the hue happens to be. Translucent
    // colours are measured as composited, since that is what will actually be seen.
    // Luminance rises monotonically with lightness at fixed hue and saturation, so this
    // bisects rather than scanning — it runs for every distinct colour on the page.
    function lightnessForContrast(theme, h, s, target, alpha, reference) {
        const refRgb = reference || hslToRgb(theme.neutrals.bg.h, theme.neutrals.bg.s, theme.neutrals.bg.l);
        const a = alpha === undefined ? 1 : Math.max(alpha, 0.05);
        const far = theme.neutrals.fg.l > theme.neutrals.bg.l ? 100 : 0;

        const reached = (l) => {
            const rgb = hslToRgb(h, s, l);
            // Composited over what it will actually sit on.
            const seen = a >= 1 ? rgb : rgb.map((c, j) => c * a + refRgb[j] * (1 - a));
            return contrastRatio(seen, refRgb) >= target;
        };

        // Contrast is 1:1 at the reference's own lightness, so start the bracket there.
        let lo = rgbToHsl(refRgb[0], refRgb[1], refRgb[2]).l;
        if (reached(lo)) return lo;       // target already met with no separation at all
        let hi = far;
        if (!reached(hi)) return hi;      // unreachable for this hue — go as far as possible

        for (let i = 0; i < 14 && Math.abs(hi - lo) > 0.25; i++) {
            const mid = (lo + hi) / 2;
            if (reached(mid)) hi = mid; else lo = mid;
        }
        return hi;                        // the closest lightness that still meets the target
    }

    function relativeLuminance(r, g, b) {
        const [rs, gs, bs] = [r, g, b].map(c => {
            c /= 255;
            return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    }

    function contrastRatio(rgb1, rgb2) {
        const l1 = relativeLuminance(...(Array.isArray(rgb1) ? rgb1 : [rgb1.r, rgb1.g, rgb1.b]));
        const l2 = relativeLuminance(...(Array.isArray(rgb2) ? rgb2 : [rgb2.r, rgb2.g, rgb2.b]));
        const lighter = Math.max(l1, l2);
        const darker = Math.min(l1, l2);
        return (lighter + 0.05) / (darker + 0.05);
    }

    function measureOriginalBase() {
        // Our own forced background must not be measured, or every page reports the theme's
        // own base and every colour maps to zero distance from it.
        const restore = suspendOwnStyles(document.body || document.documentElement);
        try {
            return detectPageBase();
        } finally {
            restore();
        }
    }

    function detectPageBase() {
        for (const el of [document.body, document.documentElement]) {
            if (!el) continue;
            const c = parseColor(window.getComputedStyle(el).backgroundColor);
            if (c && c.a > 0) return [c.r, c.g, c.b];
        }
        return [255, 255, 255]; // nothing declared — assume a white page
    }

    function findClosestAccent(sourceHsl, themeAccents) {
        if (!themeAccents || themeAccents.length === 0) return { h: sourceHsl.h, s: 50, l: 60 };
        let closest = themeAccents[0];
        let minDiff = 360;
        themeAccents.forEach(accent => {
            let diff = Math.abs(sourceHsl.h - accent.h);
            if (diff > 180) diff = 360 - diff;
            if (diff < minDiff) { minDiff = diff; closest = accent; }
        });
        return closest;
    }

    // Canvas is the only reliable way to read modern colour syntax: Chrome hands back
    // oklch()/lab()/color() from getComputedStyle verbatim, and a legacy rgb() regex
    // simply misses them — leaving those elements un-themed.
    let normalizeCtx = null;
    function normalizeColor(str) {
        if (!normalizeCtx) {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            normalizeCtx = canvas.getContext('2d', { willReadFrequently: true });
        }
        if (!normalizeCtx) return null;

        normalizeCtx.fillStyle = '#000';
        try { normalizeCtx.fillStyle = str; } catch (e) { return null; }
        const serialized = normalizeCtx.fillStyle;
        if (typeof serialized === 'string' && (serialized.startsWith('#') || serialized.startsWith('rgb'))) {
            return serialized;
        }

        // Wide-gamut function still unresolved — rasterise one pixel and read it back.
        try {
            normalizeCtx.clearRect(0, 0, 1, 1);
            normalizeCtx.fillRect(0, 0, 1, 1);
            const [r, g, b, a] = normalizeCtx.getImageData(0, 0, 1, 1).data;
            return `rgba(${r},${g},${b},${a / 255})`;
        } catch (e) {
            return null;
        }
    }

    function parseColor(str) {
        if (!str) return null;
        const s = String(str).trim();
        if (!s) return null;

        const cached = parseCache.get(s);
        if (cached !== undefined) return cached;

        const result = computeParsedColor(s);
        // Real pages reuse a small palette; the cap is only a runaway guard.
        if (parseCache.size > 5000) parseCache.clear();
        parseCache.set(s, result);
        return result;
    }

    function computeParsedColor(s) {
        if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
        if (s === 'none' || s === 'currentcolor' || s === 'inherit' || s === 'initial') return null;

        const direct = parseCanonicalColor(s);
        if (direct) return direct;

        const normalized = normalizeColor(s);
        return normalized ? parseCanonicalColor(normalized) : null;
    }

    function parseCanonicalColor(s) {
        if (s.startsWith('#')) {
            let hex = s.slice(1);
            if (!/^[0-9a-fA-F]+$/.test(hex)) return null;
            if (hex.length === 3 || hex.length === 4) hex = hex.split('').map(c => c + c).join('');
            if (hex.length === 8) {
                const bi = parseInt(hex.slice(0, 6), 16);
                return { r: (bi >> 16) & 255, g: (bi >> 8) & 255, b: bi & 255, a: parseInt(hex.slice(6), 16) / 255 };
            }
            if (hex.length !== 6) return null;
            const bi = parseInt(hex, 16);
            return { r: (bi >> 16) & 255, g: (bi >> 8) & 255, b: bi & 255, a: 1 };
        }
        const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
        if (!m) return null;
        return {
            r: Math.round(+m[1]),
            g: Math.round(+m[2]),
            b: Math.round(+m[3]),
            a: m[4] !== undefined ? +m[4] : 1
        };
    }

    function rgbToHsl(r, g, b) {
        r /= 255; g /= 255; b /= 255;
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        let h, s, l = (max + min) / 2;
        if (max === min) { h = s = 0; } else {
            const d = max - min;
            s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
            switch (max) {
                case r: h = (g - b) / d + (g < b ? 6 : 0); break;
                case g: h = (b - r) / d + 2; break;
                case b: h = (r - g) / d + 4; break;
            }
            h /= 6;
        }
        return { h: h * 360, s: s * 100, l: l * 100 };
    }

    function hslToRgb(h, s, l) {
        h /= 360; s /= 100; l /= 100;
        let r, g, b;
        if (s === 0) { r = g = b = l; } else {
            const hue2rgb = (p, q, t) => {
                if (t < 0) t += 1; if (t > 1) t -= 1;
                if (t < 1/6) return p + (q - p) * 6 * t;
                if (t < 1/2) return q;
                if (t < 2/3) return p + (q - p) * (2 / 3 - t) * 6;
                return p;
            };
            const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
            const p = 2 * l - q;
            r = hue2rgb(p, q, h + 1/3);
            g = hue2rgb(p, q, h);
            b = hue2rgb(p, q, h - 1/3);
        }
        return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
    }
})();
