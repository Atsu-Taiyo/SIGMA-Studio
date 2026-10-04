import type { InlineNode, MathInlineNode, TextInlineNode } from "@/features/document";

/**
 * GitHub風の単語単位インライン差分エンジン。React/DOMに依存しない純粋関数だけを置く
 * (electron側の適用済み差分の永続化サマリー生成からも将来呼べるようにするため)。
 *
 * 「行全体が赤/緑になるだけで何が変わったか分からない」という不満に対し、テキストは
 * Intl.Segmenterで単語単位、数式インラインはノード単位でトークン化してからLCS差分を取り、
 * 変化した単語/数式だけを強調できるようにする。
 */

// text/mathInline共通の「見た目に影響する非content属性」。これが変われば同じ単語/数式でも
// 別トークン扱いにする(装飾だけの変更もGitHub風差分では「変更」として拾いたいため)。
interface InlineTokenTextProps {
  marks?: TextInlineNode["marks"];
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: TextInlineNode["boxedVariant"];
  boxedTone?: TextInlineNode["boxedTone"];
}

interface InlineTokenMathProps {
  marks?: MathInlineNode["marks"];
  color?: string;
  backgroundColor?: string;
  fontFamily?: string;
  fontSize?: number;
  boxedPaddingY?: number;
  boxedVariant?: MathInlineNode["boxedVariant"];
  boxedTone?: MathInlineNode["boxedTone"];
  semanticRole?: MathInlineNode["semanticRole"];
  altText?: string;
}

export interface InlineDiffTextToken {
  kind: "text" | "newline";
  text: string;
  props: InlineTokenTextProps;
  /** LCS比較用の等価キー。propsを含むが位置やidは含まない。 */
  key: string;
}

export interface InlineDiffMathToken {
  kind: "math";
  /** 再構築されるノードのid。差分表示専用の一時ノードなので、由来ノードのidをそのまま使う。 */
  id: string;
  tex: string;
  props: InlineTokenMathProps;
  /**
   * LCS比較用の等価キー。texとpropsだけを含み、idは含めない —
   * 同じ数式が新しいidで再送出されても「変わっていない」と判定するため
   * (MCPツールは編集の都度atomのidを振り直すことがある)。
   */
  key: string;
}

export type InlineDiffToken = InlineDiffTextToken | InlineDiffMathToken;

export interface InlineDiffSegment {
  changed: boolean;
  nodes: InlineNode[];
}

export interface InlineDiffResult {
  removed: InlineDiffSegment[];
  added: InlineDiffSegment[];
  changed: boolean;
}

// 250,000 トークン組み合わせ(だいたい500語×500語)を超えるDP比較はブロックせずに諦める —
// 巨大な段落同士の総入れ替えで編集がスタックしないようにするためのフェイルセーフ。
const DIFF_TOKEN_CAP = 250_000;

function stablePropsKey(props: Record<string, unknown>): string {
  return Object.keys(props)
    .sort()
    .flatMap((key) => {
      const value = props[key];
      if (value === undefined) {
        return [];
      }
      if (Array.isArray(value)) {
        return [`${key}=${[...value].sort().join(",")}`];
      }
      return [`${key}=${String(value)}`];
    })
    .join("|");
}

function extractTextProps(node: TextInlineNode): InlineTokenTextProps {
  return {
    marks: node.marks,
    color: node.color,
    backgroundColor: node.backgroundColor,
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    boxedPaddingY: node.boxedPaddingY,
    boxedVariant: node.boxedVariant,
    boxedTone: node.boxedTone,
  };
}

function extractMathProps(node: MathInlineNode): InlineTokenMathProps {
  return {
    marks: node.marks,
    color: node.color,
    backgroundColor: node.backgroundColor,
    fontFamily: node.fontFamily,
    fontSize: node.fontSize,
    boxedPaddingY: node.boxedPaddingY,
    boxedVariant: node.boxedVariant,
    boxedTone: node.boxedTone,
    semanticRole: node.semanticRole,
    altText: node.altText,
  };
}

/**
 * 日本語の分かち書きにIntl.Segmenter(word粒度)を使う。未対応の実行環境向けに、
 * 空白の連続/英数字の連続/それ以外の1文字ずつへ分ける簡易フォールバックを用意する。
 */
function segmentWords(text: string): string[] {
  if (text.length === 0) {
    return [];
  }
  const segmenterCtor = (Intl as { Segmenter?: new (
    locale: string,
    options: { granularity: string },
  ) => { segment(input: string): Iterable<{ segment: string }> } }).Segmenter;
  if (typeof segmenterCtor === "function") {
    try {
      const segmenter = new segmenterCtor("ja", { granularity: "word" });
      return Array.from(segmenter.segment(text), (entry) => entry.segment).filter((segment) => segment.length > 0);
    } catch {
      // ロケール未対応などで構築に失敗した場合はフォールバックへ。
    }
  }
  return fallbackSegmentWords(text);
}

function fallbackSegmentWords(text: string): string[] {
  // 呼び出し元(tokenizeText)は改行で行ごとに分割してから渡すので、この時点でtextに
  // 改行は含まれない — dotAll(s)フラグ(ES2018+)を使わなくても`.`だけで1文字ずつ拾える。
  const matches = text.match(/\s+|[A-Za-z0-9_]+|./gu);
  return matches ? matches.filter((segment) => segment.length > 0) : [];
}

function tokenizeText(node: TextInlineNode): InlineDiffToken[] {
  const props = extractTextProps(node);
  const propsKey = stablePropsKey(props as Record<string, unknown>);
  const tokens: InlineDiffToken[] = [];
  const lines = node.text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (index > 0) {
      tokens.push({ kind: "newline", text: "\n", props, key: `newline:${propsKey}` });
    }
    for (const word of segmentWords(line)) {
      tokens.push({ kind: "text", text: word, props, key: `text:${word}:${propsKey}` });
    }
  });
  return tokens;
}

/** `InlineNode[]`を比較可能なトークン列へ変換する。 */
export function tokenizeInlineNodes(nodes: InlineNode[]): InlineDiffToken[] {
  return nodes.flatMap((node): InlineDiffToken[] => {
    if (node.type === "mathInline") {
      const props = extractMathProps(node);
      const propsKey = stablePropsKey(props as Record<string, unknown>);
      return [{
        kind: "math",
        id: node.id,
        tex: node.tex,
        props,
        key: `math:${node.tex}:${propsKey}`,
      }];
    }
    return tokenizeText(node);
  });
}

export interface DiffOp<T> {
  type: "equal" | "remove" | "add";
  a?: T;
  b?: T;
}

/**
 * 総当たりLCS差分(Wagner–Fischer型の逆順DP)。`a.length * b.length` が `cap` を超える
 * ときはDPを組まず、全削除→全追加にフォールバックする(結果としてまとめて1つの
 * 変更区間として扱われるので、呼び出し側は特別扱いしなくてよい)。
 */
export function diffArrays<T>(
  a: readonly T[],
  b: readonly T[],
  keyOf: (item: T) => string,
  cap: number = DIFF_TOKEN_CAP,
): DiffOp<T>[] {
  const n = a.length;
  const m = b.length;

  if (n * m > cap) {
    return [
      ...a.map((item): DiffOp<T> => ({ type: "remove", a: item })),
      ...b.map((item): DiffOp<T> => ({ type: "add", b: item })),
    ];
  }

  const aKeys = a.map(keyOf);
  const bKeys = b.map(keyOf);
  // dp[i][j] = a[i..n) と b[j..m) のLCS長。
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = aKeys[i] === bKeys[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp<T>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (aKeys[i] === bKeys[j]) {
      ops.push({ type: "equal", a: a[i], b: b[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", a: a[i] });
      i++;
    } else {
      ops.push({ type: "add", b: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", a: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", b: b[j] });
    j++;
  }
  return ops;
}

/** 隣接する同じprops(装飾)のtextトークン/newlineトークンを1つのTextInlineNodeへまとめ直す。 */
function tokensToNodes(tokens: InlineDiffToken[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  let current: { text: string; props: InlineTokenTextProps; propsKey: string } | null = null;

  const flush = () => {
    if (current && current.text.length > 0) {
      nodes.push({ type: "text", text: current.text, ...current.props });
    }
    current = null;
  };

  for (const token of tokens) {
    if (token.kind === "math") {
      flush();
      nodes.push({
        type: "mathInline",
        id: token.id,
        tex: token.tex,
        display: "inline",
        ...token.props,
      });
      continue;
    }
    const propsKey = stablePropsKey(token.props as Record<string, unknown>);
    if (current && current.propsKey === propsKey) {
      current.text += token.text;
    } else {
      flush();
      current = { text: token.text, props: token.props, propsKey };
    }
  }
  flush();
  return nodes;
}

function buildSideSegments(ops: DiffOp<InlineDiffToken>[], side: "removed" | "added"): InlineDiffSegment[] {
  const entries: Array<{ changed: boolean; token: InlineDiffToken }> = [];
  for (const op of ops) {
    if (side === "removed") {
      if (op.type === "add") continue;
      entries.push({ changed: op.type === "remove", token: op.a as InlineDiffToken });
    } else {
      if (op.type === "remove") continue;
      entries.push({ changed: op.type === "add", token: op.b as InlineDiffToken });
    }
  }

  const segments: InlineDiffSegment[] = [];
  let run: { changed: boolean; tokens: InlineDiffToken[] } | null = null;
  for (const entry of entries) {
    if (run && run.changed === entry.changed) {
      run.tokens.push(entry.token);
    } else {
      if (run) {
        segments.push({ changed: run.changed, nodes: tokensToNodes(run.tokens) });
      }
      run = { changed: entry.changed, tokens: [entry.token] };
    }
  }
  if (run) {
    segments.push({ changed: run.changed, nodes: tokensToNodes(run.tokens) });
  }
  return segments;
}

/**
 * 2つのInlineNode列を単語/数式単位で比較する。変わっていなければ元のノード列をそのまま
 * 1つの`changed:false`セグメントとして返す(トークン化→再構築の往復で細部が変わるのを防ぐ)。
 */
export function diffInlineNodes(before: InlineNode[], after: InlineNode[]): InlineDiffResult {
  const beforeTokens = tokenizeInlineNodes(before);
  const afterTokens = tokenizeInlineNodes(after);
  const ops = diffArrays(beforeTokens, afterTokens, (token) => token.key);
  const changed = ops.some((op) => op.type !== "equal");

  if (!changed) {
    return {
      removed: before.length > 0 ? [{ changed: false, nodes: before }] : [],
      added: after.length > 0 ? [{ changed: false, nodes: after }] : [],
      changed: false,
    };
  }

  return {
    removed: buildSideSegments(ops, "removed"),
    added: buildSideSegments(ops, "added"),
    changed: true,
  };
}

/**
 * 変わった範囲。**元のノード列の位置**で表す (`nodes[nodeIndex]` の `text` の `start`〜`end`)。
 * 数式は分けられない 1 個の部品なので `start === end === 0` で「そのノード全体」を指す。
 */
export interface InlineChangeRange {
  nodeIndex: number;
  start: number;
  end: number;
}

export interface InlineDiffChangeRanges {
  changed: boolean;
  removed: InlineChangeRange[];
  added: InlineChangeRange[];
}

interface SourcedInlineToken {
  token: InlineDiffToken;
  range: InlineChangeRange;
}

const LINE_BREAK = /\r?\n/u;

/**
 * トークンに「元のどのノードの何文字目か」を付ける。`tokenizeInlineNodes` と同じ切り方を
 * ノードごとに行い、その文字列を元のテキストの先頭から順に探して位置を決める
 * (改行トークンは `\n` 1 文字だが、元は `\r\n` のことがあるので改行だけは正規表現で測る)。
 */
function tokenizeWithSources(nodes: InlineNode[]): SourcedInlineToken[] {
  return nodes.flatMap((node, nodeIndex): SourcedInlineToken[] => {
    const tokens = tokenizeInlineNodes([node]);
    if (node.type === "mathInline") {
      return tokens.map((token) => ({ token, range: { nodeIndex, start: 0, end: 0 } }));
    }
    let offset = 0;
    return tokens.map((token) => {
      if (token.kind === "math") {
        // 文字のノードからは数式トークンは出ない (型を絞るための枝)。
        return { token, range: { nodeIndex, start: offset, end: offset } };
      }
      let start = offset;
      let length = token.text.length;
      if (token.kind === "newline") {
        const match = LINE_BREAK.exec(node.text.slice(offset));
        start = match ? offset + match.index : offset;
        length = match ? match[0].length : length;
      } else {
        const found = node.text.indexOf(token.text, offset);
        start = found >= 0 ? found : offset;
      }
      offset = start + length;
      return { token, range: { nodeIndex, start, end: offset } };
    });
  });
}

/** 同じノードの中で隣り合う範囲は 1 つにまとめる (数式は 1 ノード 1 範囲)。 */
function mergeAdjacentRanges(ranges: InlineChangeRange[]): InlineChangeRange[] {
  const merged: InlineChangeRange[] = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && last.nodeIndex === range.nodeIndex && last.end === range.start) {
      last.end = range.end;
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
}

/**
 * `diffInlineNodes` と同じ単語/数式単位の比較を行い、変わった範囲を**元のノード列の位置**で返す。
 * 表示側はこの範囲だけに色を塗ったコピーを作れる。`diffInlineNodes` と違ってノードを
 * 組み立て直さないので、リンクや表示形式などトークンに載らない属性を落とさない。
 */
export function diffInlineNodeRanges(before: InlineNode[], after: InlineNode[]): InlineDiffChangeRanges {
  const beforeTokens = tokenizeWithSources(before);
  const afterTokens = tokenizeWithSources(after);
  const ops = diffArrays(beforeTokens, afterTokens, (sourced) => sourced.token.key);
  const removed: InlineChangeRange[] = [];
  const added: InlineChangeRange[] = [];
  for (const op of ops) {
    if (op.type === "remove" && op.a) {
      removed.push(op.a.range);
    } else if (op.type === "add" && op.b) {
      added.push(op.b.range);
    }
  }
  return {
    changed: removed.length > 0 || added.length > 0,
    removed: mergeAdjacentRanges(removed),
    added: mergeAdjacentRanges(added),
  };
}
