import { describe, expect, it } from "vitest";

import {
  MATH_MARKUP_ALLOWED_ATTRIBUTES,
  MATH_MARKUP_ALLOWED_TAGS,
  sanitizeMathMarkup,
} from "./math-markup";

describe("sanitizeMathMarkup", () => {
  it("keeps the markup MathLive and KaTeX actually produce", () => {
    const markup = [
      '<span class="ML__latex">',
      '<span class="ML__strut" style="height:0.75em"></span>',
      '<span class="ML__strut--bottom" style="height:1em;vertical-align:-0.25em"></span>',
      '<span class="ML__base"><span class="ML__mathit">x</span></span>',
      "</span>",
    ].join("");

    expect(sanitizeMathMarkup(markup)).toEqual({ html: markup, safe: true });
  });

  it("keeps the unquoted attribute values MathLive writes for stretchy SVG arrows", () => {
    // 実測: `\overrightarrow{AB}` は `style=height:0.522em` `width=400em` を**引用符なし**で吐く。
    // 引用符を必須にすると、この形が丸ごとエスケープされて画面に生タグが出る。
    const result = sanitizeMathMarkup(
      '<span class="slice-1-of-1" style=height:0.522em>' +
      '<svg width=400em height=0.522em viewBox="0 0 400000 522" preserveAspectRatio="xMaxYMin slice">' +
      '<path fill="currentcolor" d="M0 241v40h399891z"></path></svg></span>',
    );

    expect(result.safe).toBe(true);
    expect(result.html).toContain('style="height:0.522em"');
    expect(result.html).toContain('width="400em"');
    expect(result.html).toContain('viewBox="0 0 400000 522"');
    expect(result.html).toContain('preserveAspectRatio="xMaxYMin slice"');
    expect(result.html).toContain('d="M0 241v40h399891z"');
  });

  it("escapes raw comparison and ampersand characters in text position", () => {
    // MathLive は math モードでも `a<b` に裸の `<`、`a\&b` に裸の `&` を吐く。
    expect(sanitizeMathMarkup('<span class="ML__cmr">a<b&c>d</span>').html)
      .toBe('<span class="ML__cmr">a&lt;b&amp;c&gt;d</span>');
  });

  it("escapes disallowed tags instead of stripping them", () => {
    for (const tag of ["img", "script", "iframe", "style", "link", "a", "form", "animate", "object"]) {
      const result = sanitizeMathMarkup(`<span class="ML__text"><${tag} src=x onerror=alert(1)></span>`);
      expect(result.html).not.toContain(`<${tag}`);
      expect(result.html).toContain(`&lt;${tag}`);
      expect(result.safe).toBe(true);
    }
  });

  it("drops disallowed attributes but keeps the element", () => {
    const result = sanitizeMathMarkup(
      '<span class="ML__base" onmouseover="alert(1)" id="evil" data-onload="alert(1)" href="javascript:alert(1)" src="x">x</span>',
    );

    expect(result.html).toBe('<span class="ML__base">x</span>');
    expect(result.safe).toBe(true);
  });

  it("drops attribute names that only differ by case from an allowed one", () => {
    expect(sanitizeMathMarkup('<span CLASS="ML__base" ONERROR="alert(1)">x</span>').html)
      .toBe("<span>x</span>");
  });

  it("drops style declarations that can load or execute something", () => {
    for (const style of [
      "background:url(https://evil/x)",
      "background:URL( https://evil/x )",
      "x:expression(alert(1))",
      "background:javascript:alert(1)",
      "@import url(https://evil/)",
      "color:red/*",
      "color:\\72 ed",
      "background:data:text/html;base64,PHNjcmlwdD4=",
    ]) {
      const result = sanitizeMathMarkup(`<span style="${style}">x</span>`);
      expect(result.html, style).toBe("<span>x</span>");
    }
  });

  it("escapes a whole tag whose quoted attribute value carries a raw angle bracket", () => {
    // 属性値の `<` はブラウザのトークナイザでも属性値の内側に留まらないので、タグ文法に
    // 一致しないものとして丸ごとテキストへ落とす (タグを組み立て直さない方が安全)。
    const result = sanitizeMathMarkup('<span style="background:url(x)<script>">x</span>');

    expect(result.html).not.toContain("<span");
    expect(result.html).toContain("&lt;span");
  });

  it("drops style declarations that could cover the screen", () => {
    // スクリプトが実行できなくても、画面を覆えれば偽の UI を出せる (クリックジャッキング /
    // 白画面に見える事故)。教材データはインポート・クラウド共有・AI・MCP から入る。
    for (const style of [
      "position:fixed",
      "position:sticky",
      "position:FIXED",
      "width:100vw",
      "height:100vh",
      "min-width:50vmin",
      "z-index:2147483647",
      "z-index:-1",
      "width:100vi",
      "height:100vb",
      "width:100cqw",
      "width:9999em",
      "height:9999em",
      "height:100%",
      "top:-9999px",
      "inset:0",
      "transform:translate(-500px,-500px)",
      "background-image:none",
      "content:'x'",
      "animation:x 1s",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
    // 覆う宣言だけが落ち、同じ属性の正当な宣言は残る。
    expect(sanitizeMathMarkup('<span style="position:fixed;top:-3em">x</span>').html)
      .toBe("<span>x</span>");
    expect(sanitizeMathMarkup('<span style="position:absolute;top:-3em">x</span>').html)
      .toBe('<span style="position:absolute;top:-3em">x</span>');
  });

  it("reads the magnitude of exponent-notation numbers", () => {
    // `1e5em` is 100000em. The old token regex read `5` as a separate number and rejected it for
    // being preceded by a word character, so only `1` was ever measured against the limit.
    for (const style of [
      "width:1e5em",
      "height:1E5em",
      "width:1e+5em",
      "z-index:1e5",
      "top:-1e3em",
      "width:.5e4em",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("evaluates calc() instead of measuring its tokens one by one", () => {
    // Each token is individually within the limit; the product is not.
    for (const style of [
      "width:calc(99em*99)",
      "height:calc(20em * 500)",
      "width:calc(10em + 10em + 10em + 10em + 10em + 10em + 10em + 10em + 10em + 10em + 10em)",
      "width:calc(1em/0.0001)",
      "height:calc((2em + 3em) * 100)",
      "width:calc(1e3em * 2)",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("drops a calc() it cannot evaluate rather than guessing", () => {
    for (const style of [
      "width:calc(100% - var(--x))",
      "width:calc(1em +)",
      "width:calc(1em / 0)",
      "width:calc((1em)",
      "width:calc()",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("keeps the calc() and var() values MathLive and KaTeX actually emit", () => {
    // MathLive's SSR build writes these for `\enclose` / `\bbox` / `\placeholder`, and KaTeX
    // writes the `100% - <2*skew>em` form for accent skew. Banning `calc(` outright would move
    // the enclosing marks silently, which is why the limit check evaluates it instead.
    for (const style of [
      "left:calc(-1 * 1px - 0.25em)",
      "height:calc( 1.2em + 1px)",
      "width:calc(100% - 2 * 5px)",
      "width:calc(100% - 0.1em)",
      "color:var(--correct-color, var(--ML__correct-color))",
      "top:.5em",
      "width:calc(2em + 3px)",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe(`<span style="${style}">x</span>`);
    }
  });

  it("drops the CSS functions the renderers never emit", () => {
    for (const style of [
      "width:min(100vw,9999em)",
      "width:max(1em,9999em)",
      "width:clamp(1em,50em,99em)",
      "width:attr(data-x)",
      "height:env(safe-area-inset-top)",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("measures lengths in root em rather than by raw digits", () => {
    // 単位を見ずに数値だけを比べていた頃は、これらが全て上限を素通りしていた
    // (実測: Chromium で 6001×6001px / 9600×1920px の不透明な面が描かれた)。
    for (const style of [
      "width:100in",
      "height:20in",
      "width:20cm",
      "width:calc(400em - 399px)",
      "width:calc(199em - 99px)",
      "height:calc(119em - 100%)",
      // 許可された唯一のカスタムプロパティを値の受け渡しに使う経路。
      "--bg-color:19in",
      "height:100%",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("folds vendor-prefixed calc() the same as the standard one", () => {
    // Blink は `-webkit-calc()` を `calc()` の完全な別名として評価する。畳み込みを飛ばすと
    // 式が未評価のまま上限判定に載り、`99` が 2 つに見えて通ってしまう。
    for (const style of [
      "width:-webkit-calc(99em * 99)",
      "height:-WEBKIT-CALC(20em * 20)",
      "width:-moz-calc(99em * 99)",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("drops any CSS function outside the calc/var allow-list", () => {
    // 禁止リストを数え上げる方式だと、ブラウザに新しい数学関数が入るたびに穴が開く。
    for (const style of [
      "width:calc-size(0px, 100em * 100)",
      "width:hypot(99em,99em)",
      "width:abs(calc(100em - 99px))",
      "width:round(99em, 1px)",
      "height:pow(20em, 2)",
      "width:some-future-function(1em)",
    ]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("refuses var() where the value has to be measured", () => {
    // 中身が静的に読めないので、寸法系プロパティでは上限判定が空振りする。
    expect(sanitizeMathMarkup('<span style="width:var(--bg-color)">x</span>').html)
      .toBe("<span>x</span>");
    // 測る必要が無いプロパティでは従来どおり通す (MathLive の `\placeholder` の正誤表示)。
    expect(sanitizeMathMarkup('<span style="color:var(--correct-color, var(--ML__correct-color))">x</span>').html)
      .toBe('<span style="color:var(--correct-color, var(--ML__correct-color))">x</span>');
  });

  it("charges nested font-size against the same length budget", () => {
    // `em` は要素自身の font-size に対して解かれるので、1 宣言ずつ上限を見ていると
    // 入れ子で掛け算になって逃げられる (font-size 19em の中の width 19em = 361em)。
    expect(sanitizeMathMarkup(
      '<span style="font-size:19em"><span style="width:19em;height:19em;position:absolute">x</span></span>',
    ).html).toBe('<span style="font-size:19em"><span>x</span></span>');
    // 閉じタグで倍率が戻ることの確認。兄弟は影響を受けない。
    expect(sanitizeMathMarkup(
      '<span style="font-size:19em">x</span><span style="width:19em">y</span>',
    ).html).toBe('<span style="font-size:19em">x</span><span style="width:19em">y</span>');
  });

  it("bounds the layout box an SVG element can claim", () => {
    // CSS を 1 文字も使わずに不透明な面を描ける経路。幅は MathLive が伸縮矢印に
    // `width=400em` を実出力するので課せない (帯にはなるが覆いにはならない)。
    expect(sanitizeMathMarkup('<svg width="9999" height="9999"><rect width="9999" height="9999"/></svg>').html)
      .toBe('<svg width="9999"><rect/></svg>');
    expect(sanitizeMathMarkup('<svg width="400em" height="0.522em"></svg>').html)
      .toBe('<svg width="400em" height="0.522em"></svg>');
  });

  it("bounds SVG children to the viewBox they are drawn in", () => {
    // `overflow:visible` (伸縮グリフの実出力なので禁止できない) は SVG ビューポートのクリップを
    // 外すので、子要素は svg の箱の外側へ描かれる。`<svg height>` の上限も CSS の寸法上限も
    // これで迂回されるため、子の幾何値は viewBox 範囲に対する倍率で縛る。
    const overflowing = (children: string) => sanitizeMathMarkup(
      `<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1">${children}</svg>`,
    ).html;

    expect(overflowing('<rect x="0" y="0" width="99999" height="99999" fill="#ffffff"/>'))
      .toBe('<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1"><rect x="0" y="0" fill="#ffffff"/></svg>');
    expect(overflowing('<path d="M0 0 L99999 0 L99999 99999 L0 99999 Z" fill="#ffffff"/>'))
      .toBe('<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1"><path fill="#ffffff"/></svg>');
    expect(overflowing('<g transform="scale(99999)"><rect width="10" height="10" fill="#ffffff"/></g>'))
      .toBe('<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1"><g><rect fill="#ffffff"/></g></svg>');
    // 予算の内側は素通し。`viewBox` を持たない svg はユーザー単位が CSS px なので予算が小さい。
    expect(overflowing('<rect width="1.5" height="1.5"/>'))
      .toBe('<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1"><rect width="1.5" height="1.5"/></svg>');
    expect(sanitizeMathMarkup('<svg width="1em" height="1em"><rect width="400" height="400"/></svg>').html)
      .toBe('<svg width="1em" height="1em"><rect/></svg>');
  });

  it("closes every measured route into an oversized SVG box", () => {
    // 実機 Chromium で被覆が確認された payload 群。どれも「幾何値の予算」を別の道で迂回する。
    const leaked = ([
      // 塗りではなく線で面を作る。
      ['<svg style="overflow:visible" width="1em" height="1em" viewBox="0 0 1 1"><rect width="1" height="1" stroke-width="99999"/></svg>', /stroke-width/],
      // 予算の出典が「出力に残った viewBox」でないと、大文字小文字違い・囮の属性名・負の範囲で
      // 「ブラウザが使わない座標系」から予算を作れる。
      ['<svg VIEWBOX="0 0 99999 99999" width="1em" height="1em" style="overflow:visible"><rect width="99999" height="99999"/></svg>', /width="99999"/],
      ['<svg data-viewBox="0 0 100000 100000" viewBox="0 0 1 1" width="1em" height="1em"><rect width="9999" height="9999"/></svg>', /width="9999"/],
      ['<svg viewBox="0 0 -100000 100000" width="1em" height="1em"><rect width="99999" height="99999"/></svg>', /width="99999"/],
      // `<svg>` 自身の `transform` と、入れ子の `<svg>` の幾何 (親のユーザー座標系の値)。
      ['<svg viewBox="0 0 1 1" width="1em" height="1em" transform="scale(99999)"><rect width="1" height="1"/></svg>', /transform/],
      ['<svg viewBox="0 0 0.001 0.001" width="20em" height="20em"><svg width="20" height="20"><rect width="1" height="1"/></svg></svg>', /<svg width="20"/],
      // 単位付き・百分率・`style`: SVG では一度ユーザー単位へ変換されてから viewBox 倍率が掛かる。
      ['<svg viewBox="0 0 1 1" width="1em" height="1em"><rect width="20em" height="20em"/></svg>', /20em/],
      ['<svg viewBox="0 0 1 1" width="400em" height="20em"><rect width="1900%" height="1900%"/></svg>', /1900%/],
      ['<svg viewBox="0 0 1 1" width="1em" height="1em"><rect style="width:20em;height:20em"/></svg>', /style/],
      // 縦横比が極端な viewBox。軸ごとに測らないと縦が幅の予算で通る。
      ['<svg width="400em" height="20em" viewBox="0 0 1000 0.001"><rect x="-1000" y="-1000" width="2000" height="2000"/></svg>', /height="2000"/],
      // 高さ指定が無い svg の高さは、上限の無い `width` と viewBox の縦横比から導かれる。
      ['<svg viewBox="0 0 100 100" width="400em"><rect width="100" height="100"/></svg>', /width="400em"/],
    ] as [string, RegExp][]).filter(([markup, leak]) => leak.test(sanitizeMathMarkup(markup).html));

    expect(leaked.map(([markup]) => markup)).toEqual([]);
  });

  it("keeps the stretchy-arrow geometry MathLive actually emits", () => {
    // 実測の最大比はちょうど 1.0000 (`viewBox` 範囲ぴったり)。予算 2 倍は落とさない。
    const arrow = '<svg width="400em" height="0.522em" viewBox="0 0 400000 522" preserveAspectRatio="xMaxYMin slice">'
      + '<path d="M0 241v40h399891c-47.3 35.3-84 78-110 128"/></svg>';
    expect(sanitizeMathMarkup(arrow).html).toBe(arrow);

    const enclose = '<svg style="position:absolute;overflow:visible;height:1.03em;top:0;left:0;width:100%;z-index:2;"'
      + ' stroke-width="0.06em" stroke="currentColor" stroke-linecap="round" viewBox="0 0 1.17 1.03">'
      + '<line x1="0.35" y1="0.68" x2="0.82" y2="0.35"/></svg>';
    expect(sanitizeMathMarkup(enclose).html).toBe(enclose);
  });

  it("drops a style value that would break out of the attribute", () => {
    // 単引用符で囲まれた値の中の `"` は、値をそのまま二重引用符で囲み直すと属性を閉じる。
    // MathLive は TeX の `\char"22` から生の `"` を合成できるので、入口では防げない。
    expect(sanitizeMathMarkup(`<span style='color:red" onmouseover="alert(1)' >x</span>`).html)
      .toBe("<span>x</span>");
    expect(sanitizeMathMarkup(`<span style='color:red" class="startup-splash'>x</span>`).html)
      .toBe("<span>x</span>");
  });

  it("charges the last font-size, not the first", () => {
    // カスケードで効くのは最後の宣言。囮を前に置いて倍率の追跡を欺けてはいけない。
    expect(sanitizeMathMarkup(
      '<span style="font-size:1em;font-size:19em"><span style="width:19em">x</span></span>',
    ).html).toBe('<span style="font-size:1em;font-size:19em"><span>x</span></span>');
  });

  it("does not inherit the font scale of a style attribute it dropped", () => {
    // 妥当な `font-size` の隣に不正な宣言があると属性ごと落ちる = 描画は継承サイズ。
    // 倍率だけ残すと、小さな font-size で子孫の上限を緩められる。
    expect(sanitizeMathMarkup(
      '<span style="font-size:0.05em;foo:1"><span style="width:400em;height:400em">x</span></span>',
    ).html).toBe("<span><span>x</span></span>");
    // 1 未満へも下げない: 縮小した font-size で上限を緩められないこと。
    expect(sanitizeMathMarkup(
      '<span style="font-size:0.05em"><span style="width:400em">x</span></span>',
    ).html).toBe('<span style="font-size:0.05em"><span>x</span></span>');
  });

  it("refuses keyword font-size values, which compound without a number", () => {
    for (const style of ["font-size:larger", "font-size:xxx-large", "font-size:xx-large"]) {
      expect(sanitizeMathMarkup(`<span style="${style}">x</span>`).html, style)
        .toBe("<span>x</span>");
    }
  });

  it("charges the font scale to an SVG box as well", () => {
    expect(sanitizeMathMarkup('<span style="font-size:19em"><svg height="19em"></svg></span>').html)
      .toBe('<span style="font-size:19em"><svg></svg></span>');
  });

  it("scales every length-valued property, including the ones added later", () => {
    // 長さの一覧を持つ形にすると、許可リストへ足したプロパティが静かに素通りする。
    for (const style of [
      "border-width:19em",
      "border-bottom:19em solid #ffffff",
      "border-left:19em solid #ffffff",
      "padding-bottom:2000%",
      "margin-top:2000%",
    ]) {
      expect(sanitizeMathMarkup(
        `<span style="font-size:19em"><span style="${style}">x</span></span>`,
      ).html, style).toBe('<span style="font-size:19em"><span>x</span></span>');
    }
    // 百分率のパディングは包含ブロックの幅に対して解かれる (font-size を挟まなくても大きい)。
    expect(sanitizeMathMarkup('<span style="padding-bottom:2000%">x</span>').html)
      .toBe("<span>x</span>");
    // `var()` は長さ扱いのプロパティすべてで拒否される。
    expect(sanitizeMathMarkup('<span style="border-bottom:var(--content-width-xl) solid #fff">x</span>').html)
      .toBe("<span>x</span>");
  });

  it("keeps the multi-declaration inline styles MathLive uses for placeholders", () => {
    const style = "position:absolute;z-index:0;display:block;pointer-events:auto;height:1.32em;top:0.6em;left:-0.3em";
    expect(sanitizeMathMarkup(`<span class="ML__prompt" part="prompt" style="${style}"></span>`).html)
      .toBe(`<span class="ML__prompt" part="prompt" style="${style}"></span>`);
    // 末尾セミコロン付き (`min-width:1.6em;`) も落とさない。
    expect(sanitizeMathMarkup('<span style="display:inline-block;min-width:1.6em;"></span>').html)
      .toBe('<span style="display:inline-block;min-width:1.6em;"></span>');
  });

  it("keeps renderer class tokens and drops every other one", () => {
    expect(sanitizeMathMarkup('<span class="ML__vlist-t ML__vlist-t2">x</span>').html)
      .toBe('<span class="ML__vlist-t ML__vlist-t2">x</span>');
    expect(sanitizeMathMarkup('<span class="mord mathnormal reset-size6 size3 slice-2-of-3">x</span>').html)
      .toBe('<span class="mord mathnormal reset-size6 size3 slice-2-of-3">x</span>');
    expect(sanitizeMathMarkup("<span class=a(b)>x</span>").html).toBe("<span>x</span>");
    // 許可外は 1 トークンだけ落ちる。組版のクラスまで巻き添えにしない。
    expect(sanitizeMathMarkup('<span class="ML__base startup-splash">x</span>').html)
      .toBe('<span class="ML__base">x</span>');
  });

  it("refuses to borrow an application CSS class", () => {
    // `globals.css` はグローバルなので、クラス名を名指しするだけで `position:fixed; inset:0;
    // z-index:10000` (`.startup-splash`) を借りてアプリ全体を覆える。文字種だけの検査では防げない。
    for (const token of [
      "startup-splash",
      "ai-task-dock-root",
      "document-tab-main",
      "page-canvas",
      "workspace-list-name-text",
    ]) {
      expect(sanitizeMathMarkup(`<span class="${token}">x</span>`).html, token)
        .toBe("<span>x</span>");
    }
  });

  it("keeps self-closing SVG children and rewrites HTML self-closing to a start tag", () => {
    expect(sanitizeMathMarkup('<svg><path d="M0 0"/><line x1="0" x2="1"/></svg>').html)
      .toBe('<svg><path d="M0 0"/><line x1="0" x2="1"/></svg>');
    // `<span/>` は HTML では開始タグとして読まれるので、そのまま出すと DOM と食い違う。
    expect(sanitizeMathMarkup("<span/>").safe).toBe(false);
  });

  it("reports unbalanced markup instead of silently reshaping the tree", () => {
    expect(sanitizeMathMarkup("<span>x</span></span>").safe).toBe(false);
    expect(sanitizeMathMarkup("<span>x").safe).toBe(false);
    expect(sanitizeMathMarkup("<svg><span>x</svg></span>").safe).toBe(false);
    expect(sanitizeMathMarkup("</span>").safe).toBe(false);
  });

  it("survives inputs that are not markup at all", () => {
    // Electron main / MCP では `convertLatexToMarkup` がスタブで TeX をそのまま返す。
    for (const raw of ["x^2", "\\frac{1}{2}", "a<b", "\\text{<div>}", "", "&", "<", ">", "<<<"]) {
      const result = sanitizeMathMarkup(raw);
      expect(result.html, raw).not.toMatch(/<(?!\/?(?:span|svg|path|line|br|circle|ellipse|g|polygon|polyline|rect)[\s/>])/);
      expect(typeof result.safe, raw).toBe("boolean");
    }
    expect(sanitizeMathMarkup("a<b").html).toBe("a&lt;b");
    expect(sanitizeMathMarkup("\\text{<div>}").html).toBe("\\text{&lt;div&gt;}");
  });

  it("keeps XML predefined and numeric entities but escapes other ampersands", () => {
    // 数値文字参照はテキスト位置で再パースされないので残して安全 (`&#60;img&#62;` はタグにならない)。
    expect(sanitizeMathMarkup("&amp;&lt;&gt;&quot;&apos;&#60;&#x3c;").html)
      .toBe("&amp;&lt;&gt;&quot;&apos;&#60;&#x3c;");
    expect(sanitizeMathMarkup("&nbsp;").html).toBe("&amp;nbsp;");
  });

  it("does not let text-position markup escape its container element", () => {
    // `\text{</span><img …><span>}` の形。閉じタグは残るが `<img>` はテキストになる。
    const result = sanitizeMathMarkup(
      '<span class="ML__text"></span><img src=x onerror=alert(1)><span></span>',
    );

    expect(result.html).not.toContain("<img");
    expect(result.html).toContain("&lt;img");
  });

  it("exposes allow-lists that never contain an execution vector", () => {
    for (const tag of MATH_MARKUP_ALLOWED_TAGS) {
      expect(["a", "animate", "foreignObject", "iframe", "img", "link", "object", "script", "style", "use"])
        .not.toContain(tag);
    }
    for (const attribute of MATH_MARKUP_ALLOWED_ATTRIBUTES) {
      expect(attribute.startsWith("on")).toBe(false);
      expect(attribute.startsWith("data-")).toBe(false);
      expect(["href", "id", "src", "srcdoc", "xlink:href"]).not.toContain(attribute);
    }
  });
});
