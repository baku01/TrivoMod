"use strict";
// Ícone padrão do TrivoMod: Arara Pirata estilizada (mascote vetorial com chapéu tricórnio,
// bandana com nó/fitas e tapa-olho sobre ondas diagonais fluidas) cujas cores acompanham
// automaticamente o tema ativo. Módulo puro (sem DOM/Node), 100% compatível com CSP.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.__trivomodDefaultIcon = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DEFAULT_PALETTE = {
    wave1: "#0e8f4e",       // onda superior esquerda (verde / secundário)
    wave1Deep: "#086839",   // sub-onda superior esquerda
    wave2: "#f8c91c",       // onda diagonal central (amarelo / destaque)
    wave3: "#0c52c4",       // onda inferior direita (azul / base)
    wave3Deep: "#073486",   // sub-onda inferior direita
    feathers: "#145ee0",    // plumagem principal da arara
    feathersDark: "#092a75",// sombra da plumagem
    featherTip: "#12a150",  // detalhes de pena secundária
    featherGold: "#f8c920", // curva dourada do pescoço/bochecha
    cheek: "#f8fafc",       // rosto claro da arara
    ink: "#09122b",         // contorno interno escuro / bico inferior
    beak: "#162040",        // bico superior
    beakLight: "#2f3e6e",   // brilho do bico
    hat: "#1a1d26",         // chapéu tricórnio pirata
    hatShade: "#0e1017",
    hatTrim: "#e8be5a",     // borda dourada do chapéu
    skull: "#f4ebd4",       // caveira e ossos
    bandana: "#cf2b2b",     // bandana pirata
    bandanaDark: "#8f1919",
    outline: "#ffffff",     // contorno externo tipo sticker
  };

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  function parseColor(raw) {
    if (typeof raw !== "string") return null;
    const s = raw.trim();
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      const h = hex[1].length === 3 ? hex[1].split("").map((c) => c + c).join("") : hex[1];
      const n = parseInt(h, 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    const rgb = /^rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/i.exec(s);
    if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])].map((n) => clamp(Math.round(n), 0, 255));
    return null;
  }

  function toHex([r, g, b]) {
    return "#" + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("");
  }

  function mix(c1, c2, t) {
    const a = parseColor(c1);
    const b = parseColor(c2);
    if (!a || !b) return c1 || c2 || "#000000";
    return toHex([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  }

  function luminance(c) {
    const rgb = parseColor(c);
    if (!rgb) return 0.2;
    return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  }

  function rgbToHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        case b: h = (r - g) / d + 4; break;
      }
      h /= 6;
    }
    return [h * 360, s, l];
  }

  function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360 / 360;
    s = clamp(s, 0, 1);
    l = clamp(l, 0, 1);
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return toHex([r * 255, g * 255, b * 255]);
  }

  function shiftHue(color, deg, satBoost = 0, lightTarget = null) {
    const rgb = parseColor(color);
    if (!rgb) return color;
    const [h, s, l] = rgbToHsl(rgb);
    return hslToHex(h + deg, clamp(s + satBoost, 0.30, 0.92), lightTarget == null ? l : lightTarget);
  }

  function distance(c1, c2) {
    const a = parseColor(c1), b = parseColor(c2);
    if (!a || !b) return 255;
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  /**
   * Deriva uma paleta harmônica para a Arara Pirata a partir das cores do tema ativo.
   * Mantém alto contraste entre as 3 ondas, a plumagem da arara, a bandana e o chapéu.
   */
  function paletteFromTheme(theme) {
    if (!theme || typeof theme !== "object") return { ...DEFAULT_PALETTE };
    const accent = parseColor(theme.accent) ? toHex(parseColor(theme.accent)) : "#145ee0";
    const bg = parseColor(theme.bg) ? toHex(parseColor(theme.bg)) : "#14161a";
    const sidebar = parseColor(theme.sidebar) ? toHex(parseColor(theme.sidebar)) : mix(bg, "#000000", 0.22);
    const green = parseColor(theme.green) ? toHex(parseColor(theme.green)) : null;
    const yellow = parseColor(theme.yellow) ? toHex(parseColor(theme.yellow)) : null;
    const red = parseColor(theme.red) ? toHex(parseColor(theme.red)) : null;
    const isLight = luminance(bg) > 0.62;

    // 3 ondas diagonais sincronizadas com o tema:
    // - wave1 (topo-esquerda): verde do tema (ou análogo frio se verde for muito próximo do acento)
    // - wave2 (faixa central): acento vibrante do tema
    // - wave3 (base-direita): profundidade do tema (sidebar + acento)
    let wave1 = green && distance(green, accent) > 55
      ? mix(green, accent, 0.14)
      : shiftHue(accent, -68, 0.08, isLight ? 0.44 : 0.38);
    const wave1Deep = mix(wave1, "#000000", 0.22);
    const wave2 = accent;
    const wave3 = isLight ? mix(accent, "#0f172a", 0.48) : mix(sidebar, accent, 0.30);
    const wave3Deep = mix(wave3, "#000000", 0.28);

    const feathers = accent;
    const feathersDark = mix(accent, "#070b1a", 0.46);
    const featherTip = green && distance(green, accent) > 55
      ? mix(green, accent, 0.10)
      : shiftHue(accent, -72, 0.10, 0.46);
    const featherGold = yellow && distance(yellow, accent) > 55
      ? mix(yellow, "#ffd43b", 0.22)
      : shiftHue(accent, 44, 0.14, 0.62);

    const hat = isLight ? mix(bg, "#151722", 0.88) : mix(bg, "#0a0c12", 0.52);
    const hatShade = mix(hat, "#000000", 0.38);
    const hatTrim = yellow ? mix(yellow, "#f4c95d", 0.38) : "#ebc25c";
    const bandana = red ? mix(red, "#d62d2d", 0.28) : "#cf2b2b";
    const bandanaDark = mix(bandana, "#180303", 0.40);

    const ink = isLight ? "#0f1629" : "#090e1d";
    const beak = mix(ink, "#1e2742", 0.45);
    const beakLight = mix(beak, accent, 0.26);
    const cheek = isLight ? "#ffffff" : "#f6f8fc";
    const skull = "#f4ebd4";
    const outline = isLight ? "#ffffff" : mix("#ffffff", accent, 0.06);

    return {
      wave1,
      wave1Deep,
      wave2,
      wave3,
      wave3Deep,
      feathers,
      feathersDark,
      featherTip,
      featherGold,
      cheek,
      ink,
      beak,
      beakLight,
      hat,
      hatShade,
      hatTrim,
      skull,
      bandana,
      bandanaDark,
      outline,
    };
  }

  /** Gera o SVG completo (viewBox 0 0 1024 1024) da Arara Pirata com a paleta informada. */
  function buildIconSvg(themeOrPalette) {
    const p = themeOrPalette && themeOrPalette.wave1 ? themeOrPalette : paletteFromTheme(themeOrPalette);
    const w2Hi = mix(p.wave2, "#ffffff", 0.16);
    const hatHi = mix(p.hat, "#ffffff", 0.12);

    // Silhueta composta reutilizada no contorno branco (sticker) para garantir encaixe exato.
    const hatPath =
      "M118,348 C178,292 252,256 322,232 C370,158 438,108 518,86 C618,124 706,198 764,296 C814,316 864,344 904,386 C868,426 814,450 752,456 C658,414 548,376 426,374 C318,372 222,394 148,426 C122,404 108,376 118,348 Z";
    const bandanaTailsPath =
      "M322,418 C242,438 158,486 96,554 C146,544 198,530 244,504 C202,558 176,626 170,698 C236,646 286,574 328,494 Z";
    const bodyPath =
      "M318,424 C252,474 218,540 244,610 C206,622 206,668 240,702 C226,746 254,798 310,822 C338,874 402,906 472,914 C512,944 558,950 584,918 C646,876 688,802 706,722 C734,740 778,742 814,708 C876,650 882,538 820,466 C782,422 716,386 632,374 C512,356 394,376 318,424 Z";

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="tm-w1" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${p.wave1}"/>
      <stop offset="100%" stop-color="${p.wave1Deep}"/>
    </linearGradient>
    <linearGradient id="tm-w2" x1="0.05" y1="0.85" x2="0.95" y2="0.15">
      <stop offset="0%" stop-color="${w2Hi}"/>
      <stop offset="100%" stop-color="${p.wave2}"/>
    </linearGradient>
    <linearGradient id="tm-w3" x1="0.15" y1="0.45" x2="0.95" y2="1">
      <stop offset="0%" stop-color="${p.wave3}"/>
      <stop offset="100%" stop-color="${p.wave3Deep}"/>
    </linearGradient>
    <linearGradient id="tm-beak" x1="0.15" y1="0.05" x2="0.85" y2="0.95">
      <stop offset="0%" stop-color="${p.beakLight}"/>
      <stop offset="55%" stop-color="${p.beak}"/>
      <stop offset="100%" stop-color="${p.ink}"/>
    </linearGradient>
    <linearGradient id="tm-hat" x1="0.2" y1="0" x2="0.8" y2="1">
      <stop offset="0%" stop-color="${hatHi}"/>
      <stop offset="100%" stop-color="${p.hatShade}"/>
    </linearGradient>
    <linearGradient id="tm-feathers" x1="0.2" y1="0.1" x2="0.8" y2="0.95">
      <stop offset="0%" stop-color="${mix(p.feathers, "#ffffff", 0.10)}"/>
      <stop offset="100%" stop-color="${p.feathers}"/>
    </linearGradient>
    <radialGradient id="tm-gloss" cx="0.26" cy="0.14" r="0.78">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.12"/>
    </radialGradient>
    <filter id="tm-drop" x="-12%" y="-12%" width="124%" height="128%">
      <feDropShadow dx="0" dy="18" stdDeviation="16" flood-color="#000000" flood-opacity="0.35"/>
    </filter>
  </defs>

  <!-- Fundo em 3 ondas diagonais com curvas S fluidas (inspirado na referência 1) -->
  <rect width="1024" height="1024" fill="url(#tm-w1)"/>
  <!-- Sub-onda escura no canto superior esquerdo -->
  <path d="M-20,540 C80,310 220,210 385,175 C510,148 605,86 680,-20 L1050,-20 L1050,240 L-20,760 Z" fill="${p.wave1Deep}" opacity="0.52"/>
  <!-- Faixa central em onda S vibrante -->
  <path d="M-20,650 C145,570 250,415 395,310 C535,208 665,245 815,170 C920,118 995,46 1050,-20 L1050,410 C965,580 830,680 650,745 C470,810 355,775 210,855 C115,908 42,975 -20,1048 Z" fill="url(#tm-w2)"/>
  <!-- Onda inferior direita profunda -->
  <path d="M-20,1045 C110,875 265,785 450,745 C635,705 780,660 905,530 C968,464 1015,392 1050,315 L1050,1050 L-20,1050 Z" fill="url(#tm-w3)"/>
  <!-- Sub-onda de profundidade no canto inferior direito -->
  <path d="M355,1050 C495,910 640,860 790,795 C895,748 975,672 1050,575 L1050,1050 Z" fill="${p.wave3Deep}" opacity="0.65"/>
  <rect width="1024" height="1024" fill="url(#tm-gloss)"/>

  <!-- Mascote Arara Pirata -->
  <g filter="url(#tm-drop)" stroke-linejoin="round" stroke-linecap="round">

    <!-- Contorno branco externo estilo sticker -->
    <g fill="${p.outline}" stroke="${p.outline}" stroke-width="46">
      <path d="${bandanaTailsPath}"/>
      <path d="${hatPath}"/>
      <path d="${bodyPath}"/>
    </g>

    <!-- Fitas esvoaçantes da bandana (atrás da plumagem) -->
    <path d="M326,426 C238,440 156,488 98,554 C162,542 226,522 288,478 L336,448 Z" fill="${p.bandana}" stroke="${p.ink}" stroke-width="18"/>
    <path d="M324,452 C248,508 192,590 176,690 C244,636 294,568 338,486 Z" fill="${p.bandanaDark}" stroke="${p.ink}" stroke-width="18"/>
    <!-- Vincos internos das fitas -->
    <path d="M274,472 C226,494 178,516 142,536" fill="none" stroke="${p.ink}" stroke-width="8" opacity="0.55"/>
    <path d="M286,506 C250,556 218,608 202,652" fill="none" stroke="${p.ink}" stroke-width="8" opacity="0.55"/>

    <!-- Plumagem da cabeça e pescoço da arara com tufos pontiagudos dinâmicos -->
    <path d="M332,424 C266,470 232,534 258,600 C220,622 224,672 258,702 C242,746 270,796 324,816 C354,866 416,896 482,904 C518,932 556,936 578,906 C636,866 676,796 694,716 L668,434 C558,366 426,372 332,424 Z" fill="url(#tm-feathers)" stroke="${p.ink}" stroke-width="20"/>

    <!-- Camada de sombra das penas (profundidade azul/acento escuro) -->
    <path d="M278,688 C310,760 378,818 468,854 C412,866 346,834 304,782 C276,748 268,714 278,688 Z" fill="${p.feathersDark}" opacity="0.65"/>
    <path d="M286,544 C316,522 356,508 394,506 C352,542 322,578 302,622 C278,596 274,568 286,544 Z" fill="${p.feathersDark}" opacity="0.45"/>

    <!-- Pena secundária verde/contraste na base do pescoço (como nas referências) -->
    <path d="M440,884 C458,826 500,780 554,768 C572,816 582,862 568,906 C524,914 476,904 440,884 Z" fill="${p.featherTip}" stroke="${p.ink}" stroke-width="15"/>

    <!-- Curva dourada vibrante do pescoço/bochecha -->
    <path d="M424,520 C382,616 404,724 494,786 C552,826 604,846 636,864 C670,816 690,754 696,690 C618,722 522,704 468,640 C440,606 432,562 442,518 Z" fill="${p.featherGold}" stroke="${p.ink}" stroke-width="17"/>

    <!-- Rosto branco característico da arara -->
    <path d="M462,472 C416,540 426,634 492,686 C554,734 640,722 698,668 C736,632 746,568 728,504 C664,438 534,428 462,472 Z" fill="${p.cheek}" stroke="${p.ink}" stroke-width="20"/>

    <!-- Duas listras faciais icônicas da arara sob o olho -->
    <path d="M474,582 C512,600 552,600 594,584" fill="none" stroke="${p.feathers}" stroke-width="15"/>
    <path d="M488,618 C524,636 566,636 606,618" fill="none" stroke="${p.feathers}" stroke-width="12"/>

    <!-- Olho determinado e expressivo -->
    <ellipse cx="556" cy="528" rx="44" ry="42" fill="${p.ink}"/>
    <circle cx="570" cy="512" r="14" fill="#ffffff"/>
    <circle cx="542" cy="542" r="6" fill="#ffffff" opacity="0.75"/>
    <!-- Sobrancelha/pálpebra firme de pirata -->
    <path d="M494,488 C534,480 578,490 614,512" fill="none" stroke="${p.ink}" stroke-width="22"/>

    <!-- Bico inferior -->
    <path d="M618,656 C654,704 718,708 764,674 C746,632 708,610 662,614 Z" fill="${p.ink}" stroke="${p.ink}" stroke-width="18"/>

    <!-- Bico superior curvo e poderoso -->
    <path d="M674,486 C758,472 838,516 854,600 C864,656 832,714 776,736 C780,672 748,624 686,608 C652,598 634,568 638,530 C642,504 654,490 674,486 Z" fill="url(#tm-beak)" stroke="${p.ink}" stroke-width="20"/>
    <!-- Brilho elegante acompanhando a curva do bico -->
    <path d="M768,524 C808,550 824,594 814,646" fill="none" stroke="#ffffff" stroke-opacity="0.28" stroke-width="16"/>
    <!-- Linha de corte/reflexo suave na base do bico -->
    <path d="M686,524 C718,522 744,538 758,562" fill="none" stroke="#ffffff" stroke-opacity="0.16" stroke-width="10"/>

    <!-- Base clara do bico + narina (limpo e expressivo, estilo referência 1) -->
    <path d="M652,506 C678,476 724,474 752,494 C724,522 690,540 650,544 C642,532 644,518 652,506 Z" fill="${p.cheek}" stroke="${p.ink}" stroke-width="16"/>
    <ellipse cx="702" cy="500" rx="13" ry="8" transform="rotate(-16 702 500)" fill="${p.ink}"/>

    <!-- Faixa da bandana bem visível abaixo da aba do chapéu + nó lateral à esquerda -->
    <path d="M306,448 C436,386 594,394 742,462 L762,420 C606,348 430,342 292,408 Z" fill="${p.bandana}" stroke="${p.ink}" stroke-width="18"/>
    <path d="M348,414 C466,378 594,384 722,434" fill="none" stroke="${p.bandanaDark}" stroke-width="9" opacity="0.65"/>
    <!-- Nó da bandana -->
    <ellipse cx="308" cy="434" rx="34" ry="28" transform="rotate(-18 308 434)" fill="${p.bandana}" stroke="${p.ink}" stroke-width="16"/>

    <!-- Chapéu tricórnio pirata (silhueta dramática inclinada como na referência 2) -->
    <path d="${hatPath}" fill="url(#tm-hat)" stroke="${p.ink}" stroke-width="20"/>
    <!-- Borda dourada interna seguindo a aba do tricórnio -->
    <path d="M158,360 C216,316 280,282 344,260 C388,188 446,142 516,120 C602,154 678,220 732,312 C776,328 820,350 858,382" fill="none" stroke="${p.hatTrim}" stroke-width="14"/>
    <path d="M174,394 C264,358 362,344 468,350 C574,356 672,386 756,426" fill="none" stroke="${p.hatTrim}" stroke-width="10" opacity="0.72"/>

    <!-- Caveira e ossos cruzados centralizados na copa inclinada do chapéu -->
    <g transform="translate(520, 248) rotate(9) scale(0.92)">
      <!-- Ossos cruzados -->
      <path d="M-76,42 L76,84 M76,42 L-76,84" stroke="${p.skull}" stroke-width="18"/>
      <circle cx="-80" cy="40" r="10" fill="${p.skull}"/>
      <circle cx="-72" cy="50" r="10" fill="${p.skull}"/>
      <circle cx="80" cy="40" r="10" fill="${p.skull}"/>
      <circle cx="72" cy="50" r="10" fill="${p.skull}"/>
      <circle cx="-80" cy="86" r="10" fill="${p.skull}"/>
      <circle cx="-72" cy="76" r="10" fill="${p.skull}"/>
      <circle cx="80" cy="86" r="10" fill="${p.skull}"/>
      <circle cx="72" cy="76" r="10" fill="${p.skull}"/>
      <!-- Crânio -->
      <path d="M-54,-6 C-56,-54 -28,-80 0,-80 C28,-80 56,-54 54,-6 C52,16 40,28 32,34 L30,54 C14,62 -14,62 -30,54 L-32,34 C-40,28 -52,16 -54,-6 Z" fill="${p.skull}" stroke="${p.hatShade}" stroke-width="10"/>
      <!-- Olhos furiosos da caveira -->
      <path d="M-34,-12 L-8,-4 C-10,10 -28,12 -34,-2 Z" fill="${p.hatShade}"/>
      <path d="M34,-12 L8,-4 C10,10 28,12 34,-2 Z" fill="${p.hatShade}"/>
      <!-- Nariz e dentes -->
      <path d="M0,12 L-8,26 L8,26 Z" fill="${p.hatShade}"/>
      <path d="M-14,40 L-14,56 M0,40 L0,58 M14,40 L14,56" stroke="${p.hatShade}" stroke-width="6"/>
    </g>
  </g>
</svg>`;
  }

  return { DEFAULT_PALETTE, paletteFromTheme, buildIconSvg };
});
