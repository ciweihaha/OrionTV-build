// 电视端内置拼音键盘（搜索界面用）：
// 系统输入法没有中文、且最下面的切换只能在系统输入法和全键盘之间切，
// 所以直接在 app 内做一个拼音键盘：输字母拼拼音 → 出中文候选词 → 选中上屏，
// 并有 中/英 分段开关（“中文”“英文”两段同时可见，v1.7.11）和数字切换。
// 只在 TV 上用（手机/平板有系统中文输入法）。
// 布局按电视 1920x1080 设计：候选行 + 三行字母 + 一行功能键，总高约 310px，
// 不会溢出屏幕；候选行没候选时保留同高空行，避免键盘上下跳动、焦点乱跳。
import React, { useMemo, useState, useCallback } from "react";
import { View, StyleSheet, ScrollView } from "react-native";
import { StyledButton } from "./StyledButton";
import { ThemedText } from "./ThemedText";
import {
  getCandidates,
  appendLetter,
  selectCandidate,
  commitFirstCandidate,
} from "@/utils/pinyinInput";
import { useResponsiveLayout } from "@/hooks/useResponsiveLayout";

interface PinyinKeyboardProps {
  /** 已确定的搜索关键词（中文/英文字符）。 */
  keyword: string;
  onKeywordChange: (keyword: string) => void;
  /** 正在拼的拼音缓冲（未上屏的字母），由父组件展示在输入框里。 */
  buffer: string;
  onBufferChange: (buffer: string) => void;
  /** 按“搜索”时调用，参数是提交缓冲首选字后的完整关键词。 */
  onSearch: (keyword: string) => void;
}

const LETTER_ROWS: string[][] = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const NUMBER_ROWS: string[][] = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  [".", ",", "-", "_", "/", ":", "@", "#", "*", "+"],
];

const MAX_CANDIDATES_SHOWN = 12;

export const PinyinKeyboard: React.FC<PinyinKeyboardProps> = ({
  keyword,
  onKeywordChange,
  buffer,
  onBufferChange,
  onSearch,
}) => {
  const [mode, setMode] = useState<"zh" | "en">("zh");
  const [showNumbers, setShowNumbers] = useState(false);
  const { spacing } = useResponsiveLayout();

  const candidates = useMemo(
    () => (mode === "zh" && !showNumbers ? getCandidates(buffer) : []),
    [buffer, mode, showNumbers],
  );

  // 有合法音节时先把首选字上屏、清空缓冲；没有时什么都不做。
  // 返回是否提交了一个字。
  const commitBufferFirst = useCallback((): boolean => {
    const ch = commitFirstCandidate(buffer);
    if (!ch) return false;
    onKeywordChange(keyword + ch);
    onBufferChange("");
    return true;
  }, [buffer, keyword, onKeywordChange, onBufferChange]);

  const handleLetter = useCallback(
    (letter: string) => {
      // 英文模式或数字模式：字母直接上屏，不拼拼音。
      // 按键显示的是大写（key.toUpperCase()），上屏也要大写，和看到的一致。
      if (mode === "en" || showNumbers) {
        onKeywordChange(keyword + letter.toUpperCase());
        return;
      }
      const { buffer: nextBuffer, commit } = appendLetter(buffer, letter);
      if (commit) onKeywordChange(keyword + commit);
      onBufferChange(nextBuffer);
    },
    [buffer, keyword, mode, onKeywordChange, onBufferChange, showNumbers],
  );

  const handleNumberKey = useCallback(
    (key: string) => {
      onKeywordChange(keyword + key);
    },
    [keyword, onKeywordChange],
  );

  const handleCandidate = useCallback(
    (index: number) => {
      const ch = selectCandidate(buffer, index);
      if (!ch) return;
      onKeywordChange(keyword + ch);
      onBufferChange("");
    },
    [buffer, keyword, onKeywordChange, onBufferChange],
  );

  const handleBackspace = useCallback(() => {
    if (buffer) {
      onBufferChange(buffer.slice(0, -1));
      return;
    }
    if (keyword) onKeywordChange(keyword.slice(0, -1));
  }, [buffer, keyword, onKeywordChange, onBufferChange]);

  const handleSpace = useCallback(() => {
    // 中文模式有合法音节时，空格 = 选首选字（输入法惯例）。
    if (mode === "zh" && !showNumbers && commitBufferFirst()) return;
    onKeywordChange(keyword + " ");
  }, [commitBufferFirst, keyword, mode, onKeywordChange, showNumbers]);

  const handleClear = useCallback(() => {
    onBufferChange("");
    onKeywordChange("");
  }, [onKeywordChange, onBufferChange]);

  const handleSearchPress = useCallback(() => {
    let kw = keyword;
    const ch = commitFirstCandidate(buffer);
    if (ch) {
      kw = keyword + ch;
      onKeywordChange(kw);
      onBufferChange("");
    }
    onSearch(kw);
  }, [buffer, keyword, onKeywordChange, onBufferChange, onSearch]);

  // 中/英切换（v1.7.11 改成分段开关）：原来只有一个按钮、文案显示当前
  // 模式（中文模式显示“中文”），用户当成状态标签、看不出能点、也不知道
  // 还有英文可切。现在“中文”“英文”两个段同时可见，当前模式绿底高亮，
  // 点另一段才切换（并清空拼音缓冲）；点已选中的段什么都不做，不清空缓冲。
  const setModeTo = useCallback(
    (next: "zh" | "en") => {
      setMode((m) => {
        if (m === next) return m;
        onBufferChange("");
        return next;
      });
    },
    [onBufferChange],
  );

  const toggleNumbers = useCallback(() => {
    onBufferChange("");
    setShowNumbers((v) => !v);
  }, [onBufferChange]);

  const styles = useMemo(() => createStyles(spacing), [spacing]);
  const rows = showNumbers ? NUMBER_ROWS : LETTER_ROWS;
  const shownCandidates = candidates.slice(0, MAX_CANDIDATES_SHOWN);

  return (
    <View style={styles.container}>
      {/* 候选词行 */}
      <View style={styles.candidateRow}>
        {shownCandidates.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.candidateList}>
            {shownCandidates.map((ch, i) => (
              <StyledButton
                key={`${buffer}-${i}`}
                text={ch}
                onPress={() => handleCandidate(i)}
                style={styles.candidateButton}
                textStyle={styles.candidateText}
              />
            ))}
          </ScrollView>
        ) : mode === "zh" && !showNumbers && buffer.length > 0 ? (
          <ThemedText style={styles.candidateHint}>无此拼音候选，按删除修改（ü 用 v 代替，如 nv=女）</ThemedText>
        ) : (
          <ThemedText style={styles.candidateHint}>
            {mode === "zh" ? "输入拼音，选字上屏" : "英文模式：字母直接上屏"}
          </ThemedText>
        )}
      </View>

      {/* 字母/数字键区 */}
      {rows.map((row, ri) => (
        <View key={ri} style={styles.keyRow}>
          {row.map((key) => (
            <StyledButton
              key={key}
              text={showNumbers ? key : key.toUpperCase()}
              onPress={() => (showNumbers ? handleNumberKey(key) : handleLetter(key))}
              style={styles.keyButton}
              textStyle={styles.keyText}
            />
          ))}
        </View>
      ))}

      {/* 功能键区 */}
      <View style={styles.keyRow}>
        {/* 中/英分段开关：两段同时可见，当前模式绿底高亮（见上面 setModeTo 的注释） */}
        <View style={styles.langSwitch}>
          <StyledButton
            text="中文"
            onPress={() => setModeTo("zh")}
            isSelected={mode === "zh"}
            style={styles.langButton}
            textStyle={styles.funcText}
          />
          <StyledButton
            text="英文"
            onPress={() => setModeTo("en")}
            isSelected={mode === "en"}
            style={styles.langButton}
            textStyle={styles.funcText}
          />
        </View>
        <StyledButton
          text={showNumbers ? "ABC" : "123"}
          onPress={toggleNumbers}
          style={styles.funcButton}
          textStyle={styles.funcText}
        />
        <StyledButton
          text="空格"
          onPress={handleSpace}
          style={[styles.funcButton, styles.spaceButton]}
          textStyle={styles.funcText}
        />
        <StyledButton
          text="⌫"
          onPress={handleBackspace}
          style={styles.funcButton}
          textStyle={styles.funcText}
        />
        <StyledButton
          text="清空"
          onPress={handleClear}
          style={styles.funcButton}
          textStyle={styles.funcText}
        />
        <StyledButton
          text="搜索"
          variant="primary"
          onPress={handleSearchPress}
          style={styles.funcButton}
          textStyle={styles.funcText}
        />
      </View>
    </View>
  );
};

const createStyles = (spacing: number) =>
  StyleSheet.create({
    container: {
      width: "100%",
      maxWidth: 1600,
      alignSelf: "center",
      paddingHorizontal: spacing,
      paddingBottom: spacing / 2,
    },
    candidateRow: {
      height: 56,
      justifyContent: "center",
      marginBottom: 6,
    },
    candidateList: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    candidateButton: {
      minWidth: 64,
      height: 48,
      paddingHorizontal: 12,
      margin: 0,
    },
    candidateText: {
      fontSize: 24,
    },
    candidateHint: {
      fontSize: 15,
      color: "#888",
    },
    keyRow: {
      flexDirection: "row",
      gap: 8,
      marginBottom: 8,
    },
    keyButton: {
      flex: 1,
      height: 60,
      margin: 0,
      paddingHorizontal: 0,
    },
    keyText: {
      fontSize: 24,
    },
    funcButton: {
      flex: 1,
      height: 60,
      margin: 0,
      paddingHorizontal: 0,
    },
    // 中/英分段开关：占两个按钮位（和空格键一样宽），一眼看到两种模式；
    // 两段各 flex 1，当前模式绿底（StyledButton isSelected）。
    langSwitch: {
      flex: 2,
      flexDirection: "row",
      gap: 8,
    },
    langButton: {
      flex: 1,
      height: 60,
      margin: 0,
      paddingHorizontal: 0,
    },
    spaceButton: {
      flex: 2,
    },
    funcText: {
      fontSize: 20,
    },
  });
