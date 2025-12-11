(async () => {
    if (window.themerLoaded) return;
    window.themerLoaded = true;

    // --- FETCH THEMES ---
    const themeUrl = chrome.runtime.getURL('themes.json');
    let THEMES = {};
    try {
        const response = await fetch(themeUrl);
        THEMES = await response.json();
    } catch (e) {
        console.error("Failed to load themes.json", e);
    }

    let activeTheme = null;
    let mainThemeBgString = null;
    let observer = null;
    let pendingMutations = new Set();
    let mutationTimeout = null;
    
    // Brightness Check (Run Once)
    const IS_ORIGINALLY_DARK = detectPageBrightness();

    chrome.runtime.onMessage.addListener((request) => {
        if (request.action === "setTheme") {
            if (THEMES[request.theme]) initTheme(THEMES[request.theme]);
        }
    });

    function initTheme(theme) {
        activeTheme = theme;
        
        const { h, s, l } = theme.neutrals.bg;
        mainThemeBgString = `rgba(${hslToRgb(h, s, l).join(',')}, 1)`;

        // Cleanup: Reset flags
        document.querySelectorAll('[data-theme-processed]').forEach(el => {
            el.removeAttribute('data-theme-processed');
            el.style.removeProperty('border-radius');
        });

        injectGlobalStyles();
        injectPseudoStyles();
        forceRootBackground(theme);
        
        processNode(document.body);

        if (observer) observer.disconnect();
        observer = new MutationObserver((mutations) => {
            // DEBOUNCE LOGIC: Batch updates to avoid freezing the browser
            mutations.forEach((m) => {
                m.addedNodes.forEach((n) => {
                    if (n.nodeType === 1) pendingMutations.add(n);
                });
            });

            if (mutationTimeout) cancelAnimationFrame(mutationTimeout);
            mutationTimeout = requestAnimationFrame(() => {
                pendingMutations.forEach(node => processNode(node));
                pendingMutations.clear();
            });
        });
        observer.observe(document.body, { childList: true, subtree: true });
    }

    function injectGlobalStyles() {
        if (document.getElementById('theme-global-styles')) return;
        const style = document.createElement('style');
        style.id = 'theme-global-styles';
        // Add Transitions and Scrollbar styling
        style.textContent = `
            html, body {
                transition: background-color 0.3s ease, color 0.3s ease;
            }
            ::-webkit-scrollbar {
                width: 12px;
                height: 12px;
            }
            ::-webkit-scrollbar-track {
                background: #1a1a1a; 
            }
            ::-webkit-scrollbar-thumb {
                background: #444; 
                border-radius: 6px;
                border: 2px solid #1a1a1a;
            }
            ::-webkit-scrollbar-thumb:hover {
                background: #666; 
            }
        `;
        document.head.appendChild(style);
    }

    function processNode(root) {
        const elements = root.querySelectorAll ? [root, ...root.querySelectorAll('*')] : [root];
        elements.forEach(el => {
            const tag = el.tagName;
            if (['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'DEFS', 'SYMBOL', 'MARKER', 'MASK', 'CLIPPATH'].includes(tag)) return;
            
            if (el.dataset.themeProcessed) return;
            el.dataset.themeProcessed = "true";

            const style = window.getComputedStyle(el);
            
            // --- 1. SVG ---
            if (['SVG', 'PATH', 'CIRCLE', 'RECT', 'POLYGON', 'ELLIPSE', 'LINE', 'POLYLINE', 'G'].includes(tag)) {
                applyProperty(el, style, 'fill', 'bg');
                applyProperty(el, style, 'stroke', 'border');
                applyProperty(el, style, 'stopColor', 'bg');
                
                if (el.hasAttribute('fill') && el.getAttribute('fill') !== 'none') {
                    const attrColor = parseColor(el.getAttribute('fill'));
                    if (attrColor) {
                        const newColor = mapColorToTheme(attrColor, activeTheme, 'bg');
                        el.style.setProperty('fill', newColor, 'important');
                    }
                }
            }

            // --- 2. HTML ---
            applyProperty(el, style, 'color', 'text');
            applyProperty(el, style, 'borderColor', 'border');

            const bgString = getOriginalStyle(el, style, 'backgroundColor');
            const bgParsed = parseColor(bgString);
            
            if (bgParsed && bgParsed.a > 0) {
                const newBg = mapColorToTheme(bgParsed, activeTheme, 'bg');
                el.style.setProperty('background-color', newBg, 'important');

                // Card Logic
                if (['DIV', 'SECTION', 'ARTICLE', 'ASIDE', 'MAIN', 'NAV'].includes(tag)) {
                    if (newBg !== mainThemeBgString) {
                         const rect = el.getBoundingClientRect();
                         const isFullWidth = rect.width >= (window.innerWidth - 20); 
                         const existingRadius = parseInt(style.borderRadius);
                         if (!isFullWidth && (isNaN(existingRadius) || existingRadius < 2)) {
                             el.style.setProperty('border-radius', '6px', 'important');
                         }
                    }
                }
            }

            const bgImg = getOriginalStyle(el, style, 'backgroundImage');
            if (bgImg !== 'none') {
                processBackgroundImage(el, bgImg);
            }

            // --- 3. Pseudo ---
            processPseudo(el, '::before', 'theme-fix-before');
            processPseudo(el, '::after', 'theme-fix-after');
        });
    }

    function getOriginalStyle(el, computedStyle, prop) {
        const attr = 'data-og-' + prop;
        if (el.hasAttribute(attr)) return el.getAttribute(attr);
        const val = computedStyle[prop];
        el.setAttribute(attr, val);
        return val;
    }

    function applyProperty(el, style, prop, type) {
        const val = getOriginalStyle(el, style, prop);
        if (!val || val === 'none' || val === 'auto') return;
        if (val.startsWith('url(')) return; 

        const color = parseColor(val);
        if (color && color.a > 0) {
            const newColor = mapColorToTheme(color, activeTheme, type);
            el.style.setProperty(prop, newColor, 'important');
        }
    }

    function processBackgroundImage(el, originalString) {
        const colorRegex = /rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;
        const newString = originalString.replace(colorRegex, (match) => {
            const color = parseColor(match);
            if (!color) return match; 
            return mapColorToTheme(color, activeTheme, 'bg');
        });
        if (newString !== originalString) {
            el.style.setProperty('background-image', newString, 'important');
        }
    }

    function processPseudo(el, pseudoType, className) {
        const style = window.getComputedStyle(el, pseudoType);
        const content = style.content;
        if (!content || content === 'none' || content === 'normal') return;

        const bg = parseColor(style.backgroundColor);
        if (bg && bg.a > 0) {
            const newBg = mapColorToTheme(bg, activeTheme, 'bg');
            el.style.setProperty(`--${className}-bg`, newBg, 'important');
            el.classList.add(className);
        }

        const border = parseColor(style.borderTopColor || style.borderColor); 
        if (border && border.a > 0) {
            const newBorder = mapColorToTheme(border, activeTheme, 'border');
            el.style.setProperty(`--${className}-border`, newBorder, 'important');
            el.classList.add(className);
        }
        
        const color = parseColor(style.color);
        if (color && color.a > 0) {
            const newColor = mapColorToTheme(color, activeTheme, 'text');
            el.style.setProperty(`--${className}-text`, newColor, 'important');
            el.classList.add(className);
        }
    }

    function injectPseudoStyles() {
        const oldStyle = document.getElementById('theme-pseudo-styles');
        if (oldStyle) oldStyle.remove();

        const c = '.theme-fix-before';
        const selectorBefore = `${c}${c}${c}${c}${c}${c}${c}${c}${c}${c}::before`;
        const cAfter = '.theme-fix-after';
        const selectorAfter = `${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}${cAfter}::after`;

        const style = document.createElement('style');
        style.id = 'theme-pseudo-styles';
        style.textContent = `
            ${selectorBefore} {
                background-color: var(--theme-fix-before-bg) !important;
                border-color: var(--theme-fix-before-border) !important;
                color: var(--theme-fix-before-text) !important;
                fill: var(--theme-fix-before-text) !important;
                stroke: var(--theme-fix-before-border) !important;
                background-image: none !important;
            }
            ${selectorAfter} {
                background-color: var(--theme-fix-after-bg) !important;
                border-color: var(--theme-fix-after-border) !important;
                color: var(--theme-fix-after-text) !important;
                fill: var(--theme-fix-after-text) !important;
                stroke: var(--theme-fix-after-border) !important;
                background-image: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    function forceRootBackground(theme) {
        const { h, s, l } = theme.neutrals.bg;
        const { h: fh, s: fs, l: fl } = theme.neutrals.fg;
        const bgVal = `hsl(${h}, ${s}%, ${l}%)`;
        const fgVal = `hsl(${fh}, ${fs}%, ${fl}%)`;

        [document.documentElement, document.body].forEach(el => {
            el.style.setProperty('background-color', bgVal, 'important');
            el.style.setProperty('color', fgVal, 'important');
        });
    }

    function mapColorToTheme(rgba, theme, type) {
        const hsl = rgbToHsl(rgba.r, rgba.g, rgba.b);
        const isNeutral = hsl.s < 25; 

        let finalH, finalS, finalL;

        if (isNeutral) {
            let relativeL = hsl.l;
            if (!IS_ORIGINALLY_DARK && theme.type === 'dark') relativeL = 100 - hsl.l;
            if (type === 'text' && relativeL < 50) relativeL = 85; 
            if (type === 'bg' && relativeL > 50) relativeL = 15;

            const range = theme.neutrals.fg.l - theme.neutrals.bg.l;
            finalL = theme.neutrals.bg.l + ((relativeL / 100) * range);
            finalH = theme.neutrals.bg.h;
            finalS = theme.neutrals.bg.s; 
        } else {
            const matched = findClosestAccent(hsl, theme.accents);
            finalH = matched.h;
            
            if (type === 'bg') {
                finalS = Math.min(matched.s, 25); 
                finalL = Math.max(12, Math.min(25, hsl.l * 0.3)); 
            } else {
                finalS = matched.s;
                finalL = Math.max(40, Math.min(90, hsl.l));
            }
        }
        return `rgba(${hslToRgb(finalH, finalS, finalL).join(',')}, ${rgba.a})`;
    }

    function detectPageBrightness() {
        let style = window.getComputedStyle(document.body);
        let c = parseColor(style.backgroundColor);
        if (!c || c.a === 0) {
             style = window.getComputedStyle(document.documentElement);
             c = parseColor(style.backgroundColor);
        }
        if (!c || c.a === 0) return false; 
        return ((c.r * 299 + c.g * 587 + c.b * 114) / 1000) < 128;
    }

    function findClosestAccent(sourceHsl, themeAccents) {
        let closest = themeAccents[0];
        let minDiff = 360;
        themeAccents.forEach(accent => {
            let diff = Math.abs(sourceHsl.h - accent.h);
            if (diff > 180) diff = 360 - diff;
            if (diff < minDiff) { minDiff = diff; closest = accent; }
        });
        return closest;
    }

    function parseColor(str) {
        if (!str) return null;
        if (str === 'transparent') return {r:0, g:0, b:0, a:0};
        if (str.startsWith('#')) {
            let hex = str.slice(1);
            if (hex.length === 3) hex = hex.split('').map(c=>c+c).join('');
            const bi = parseInt(hex, 16);
            return { r: (bi >> 16) & 255, g: (bi >> 8) & 255, b: bi & 255, a: 1 };
        }
        const m = str.match(/rgba?\((\d+), \s*(\d+), \s*(\d+)(?:, \s*([\d.]+))?\)/);
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
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