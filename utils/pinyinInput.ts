// 电视端内置拼音输入的纯逻辑（与 UI 无关，可单测）：
// 无声调拼音 -> 候选汉字，输入一个音节、选字上屏。
// 词典见 ./pinyinCandidates（由 scripts/gen-pinyin-dict.js 从 pinyin-pro 生成）。
// ü 用 v 表示（nv=女、lv=绿），与常见输入法惯例一致。
import { PINYIN_CANDIDATES } from "./pinyinCandidates";

/** 全部合法无声调音节。 */
const SYLLABLES: ReadonlySet<string> = new Set(Object.keys(PINYIN_CANDIDATES));

/** 合法音节的全部真前缀（用于边打边判断“还能不能继续拼”）。 */
const SYLLABLE_PREFIXES: ReadonlySet<string> = (() => {
  const set = new Set<string>();
  for (const s of SYLLABLES) {
    for (let i = 1; i < s.length; i++) set.add(s.slice(0, i));
  }
  return set;
})();

/** 该拼音的候选字（按常用度排好）；不是合法音节时返回空数组。 */
export function getCandidates(pinyin: string): string[] {
  if (!pinyin) return [];
  return PINYIN_CANDIDATES[pinyin] ?? [];
}

/** 是不是一个完整合法音节（如 zhong、jie）。 */
export function isValidSyllable(pinyin: string): boolean {
  return SYLLABLES.has(pinyin);
}

/** 是不是某个合法音节的前缀（如 zh、zho：还能继续往下拼）。 */
export function isSyllablePrefix(pinyin: string): boolean {
  return SYLLABLE_PREFIXES.has(pinyin);
}

export interface AppendLetterResult {
  /** 拼完后的拼音缓冲。 */
  buffer: string;
  /** 需要立即上屏的字（旧音节的首选字），没有时为 null。 */
  commit: string | null;
}

/**
 * 往拼音缓冲里加一个字母（中文模式）。
 * - 新缓冲是合法音节或合法音节前缀：直接收下。
 * - 新缓冲不合法、但旧缓冲是合法音节：先把旧音节的首选字上屏，再用这个
 *   字母开新音节（连续打 zhongguo 时，g 一来就把“中”上屏，再继续拼 guo）。
 * - 新缓冲不合法、旧缓冲也不合法：丢掉旧缓冲，用这个字母重开（纠正误输）。
 */
export function appendLetter(buffer: string, letter: string): AppendLetterResult {
  const next = buffer + letter;
  if (next.length <= 6 && (isValidSyllable(next) || isSyllablePrefix(next))) {
    return { buffer: next, commit: null };
  }
  if (isValidSyllable(buffer)) {
    return { buffer: letter, commit: getCandidates(buffer)[0] ?? null };
  }
  return { buffer: letter, commit: null };
}

/** 从当前音节的候选里取第 index 个字；没有时返回 null。 */
export function selectCandidate(buffer: string, index: number): string | null {
  return getCandidates(buffer)[index] ?? null;
}

/** 空格键语义：当前是合法音节时返回首选字（上屏），否则返回 null（调用方改为空格）。 */
export function commitFirstCandidate(buffer: string): string | null {
  if (!isValidSyllable(buffer)) return null;
  return getCandidates(buffer)[0] ?? null;
}
