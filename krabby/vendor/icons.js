/**
 * icons.js — Self-hosted Lucide-compatible SVG icon set.
 * Replaces: <script src="https://unpkg.com/lucide@0.263.1/dist/umd/lucide.min.js">
 *
 * Usage: same as Lucide — <i data-lucide="name"></i> then lucide.createIcons()
 * All paths are from Lucide v0.263 (stroke/round/round, viewBox 0 0 24 24).
 */
(function (global) {
  'use strict';

  /* ── SVG path content per icon name ───────────────────────────────────── */
  const ICONS = {
    'activity':         '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
    'alert-triangle':   '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    'arrow-down':       '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    'arrow-up':         '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    'arrow-left':       '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
    'arrow-right':      '<path d="m5 12 14 0"/><path d="m12 5 7 7-7 7"/>',
    'bar-chart-2':      '<line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/>',
    'bot':              '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/>',
    'candlestick-chart':'<path d="M9 5v4"/><rect width="4" height="6" x="7" y="9" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect width="4" height="8" x="15" y="5" rx="1"/><path d="M17 13v3"/><path d="M3 3v18h18"/>',
    'chart-line':       '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
    'check':            '<path d="M20 6 9 17l-5-5"/>',
    'check-circle':     '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    'chevron-down':     '<path d="m6 9 6 6 6-6"/>',
    'chevron-left':     '<path d="m15 18-6-6 6-6"/>',
    'chevron-right':    '<path d="m9 18 6-6-6-6"/>',
    'chevron-up':       '<path d="m18 15-6-6-6 6"/>',
    'clipboard-list':   '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/>',
    'code':             '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
    'cpu':              '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2"/><path d="M15 20v2"/><path d="M2 15h2"/><path d="M2 9h2"/><path d="M20 15h2"/><path d="M20 9h2"/><path d="M9 2v2"/><path d="M9 20v2"/>',
    'download':         '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    'eye':              '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
    'eye-off':          '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
    'file-text':        '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
    'filter':           '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
    'flask-conical':    '<path d="M14 2v6l3 7c.5 1.5-.5 3-2 3H9c-1.5 0-2.5-1.5-2-3l3-7V2"/><path d="M9 2h6"/><path d="M11 10h2"/>',
    'globe':            '<circle cx="12" cy="12" r="10"/><line x1="2" x2="22" y1="12" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    'info':             '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    'layers':           '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
    'layout-dashboard': '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    'line-chart':       '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
    'lock':             '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    'maximize-2':       '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>',
    'menu':             '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    'minimize-2':       '<polyline points="5 15 3 15 3 21 9 21"/><polyline points="19 9 21 9 21 3 15 3"/><line x1="3" x2="10" y1="21" y2="14"/><line x1="21" x2="14" y1="3" y2="10"/>',
    'minus':            '<path d="M5 12h14"/>',
    'moon':             '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    'more-horizontal':  '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    'more-vertical':    '<circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>',
    'play':             '<polygon points="6 3 20 12 6 21 6 3"/>',
    'plug':             '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M6 8H5a4 4 0 0 0 0 8h1"/><line x1="6" x2="18" y1="8" y2="8"/><line x1="6" x2="18" y1="16" y2="16"/>',
    'plus':             '<path d="M5 12h14"/><path d="M12 5v14"/>',
    'refresh-cw':       '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    'save':             '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/>',
    'search':           '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    'settings':         '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
    'settings-2':       '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    'square':           '<rect width="18" height="18" x="3" y="3" rx="2"/>',
    'sun':              '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    'terminal':         '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    'trending-down':    '<polyline points="22 17 13.5 8.5 8.5 13.5 2 7"/><polyline points="16 17 22 17 22 11"/>',
    'trending-up':      '<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
    'wifi':             '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" x2="12.01" y1="20" y2="20"/>',
    'wifi-off':         '<line x1="2" x2="22" y1="2" y2="22"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><line x1="12" x2="12.01" y1="20" y2="20"/>',
    'x':                '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    'x-circle':         '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6"/><path d="m9 9 6 6"/>',
    'zap':              '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
    'area-chart':       '<path d="M3 3v18h18"/><path d="M7 12v5h12V8l-5 5-4-4Z"/>',
    'scatter-chart':    '<circle cx="7.5" cy="7.5" r="1.5"/><circle cx="18.5" cy="5.5" r="1.5"/><circle cx="11.5" cy="11.5" r="1.5"/><circle cx="7.5" cy="16.5" r="1.5"/><path d="M3 3v18h18"/>',
    // ── added to cover all HTML uses ───────────────────────────────────────────
    'book-open':        '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
    'clock':            '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    'plug-2':           '<path d="M9 2v6"/><path d="M15 2v6"/><path d="M12 17v5"/><path d="M5 8h14"/><path d="M6 11V8h12v3a6 6 0 1 1-12 0Z"/>',
    'scan-search':      '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="3"/><path d="m16 16-1.9-1.9"/>',
    'trash-2':          '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    'upload':           '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  };

  /* ── Build one SVG element from icon name ─────────────────────────────── */
  function makeSvg(name, extraClass) {
    const paths = ICONS[name];
    if (!paths) return null;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('width', '24');
    svg.setAttribute('height', '24');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (extraClass) svg.setAttribute('class', extraClass);
    svg.innerHTML = paths;
    return svg;
  }

  /* ── Public API matching Lucide UMD surface ───────────────────────────── */
  const lucide = {
    icons: ICONS,

    /** Replace all <i data-lucide="name"> with inline SVG. */
    createIcons(opts) {
      const root = (opts && opts.nameAttr
        ? document
        : (opts && opts.attrs && opts.attrs['data-lucide']) ? document : document
      );
      root.querySelectorAll('i[data-lucide]').forEach((el) => {
        const name = el.getAttribute('data-lucide');
        const svg = makeSvg(name, el.className || undefined);
        if (!svg) {
          // Fallback: keep the element, add a text marker so we know it's missing
          el.textContent = el.textContent || '•';
          return;
        }
        // Copy inline style
        if (el.style && el.style.cssText) svg.style.cssText = el.style.cssText;
        // Copy data attributes
        for (const attr of el.attributes) {
          if (attr.name !== 'data-lucide' && attr.name !== 'class' && attr.name !== 'style') {
            svg.setAttribute(attr.name, attr.value);
          }
        }
        el.replaceWith(svg);
      });
    },

    /** Create a single SVG icon element programmatically. */
    createElement(name, attrs) {
      const svg = makeSvg(name);
      if (svg && attrs) {
        for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, v);
      }
      return svg;
    },
  };

  /* ── Export ───────────────────────────────────────────────────────────── */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lucide;
  } else {
    global.lucide = lucide;
    global.createIcons = lucide.createIcons.bind(lucide);
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
