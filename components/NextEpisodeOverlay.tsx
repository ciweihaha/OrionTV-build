import React from "react";
import { View, StyleSheet } from "react-native";
import { ThemedText } from "@/components/ThemedText";
import { StyledButton } from "./StyledButton";

interface NextEpisodeOverlayProps {
  visible: boolean;
  /** 下一集标题（如“第 2 集”），用于预告文案 */
  nextTitle?: string;
  onPlayNext: () => void;
  onCancel: () => void;
}

export const NextEpisodeOverlay: React.FC<NextEpisodeOverlayProps> = ({ visible, nextTitle, onPlayNext, onCancel }) => {
  if (!visible) {
    return null;
  }

  return (
    <View style={styles.nextEpisodeOverlay}>
      <View style={styles.nextEpisodeContent}>
        <ThemedText style={styles.nextEpisodeTitle}>
          {nextTitle ? `即将播放：${nextTitle}` : "即将播放下一集..."}
        </ThemedText>
        <View style={styles.nextEpisodeButtons}>
          <StyledButton
            text="立即播放"
            onPress={onPlayNext}
            hasTVPreferredFocus={visible}
            variant="primary"
            style={styles.nextEpisodeButton}
            textStyle={styles.nextEpisodeButtonText}
          />
          <StyledButton
            text="取消"
            onPress={onCancel}
            style={styles.nextEpisodeButton}
            textStyle={styles.nextEpisodeButtonText}
          />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  nextEpisodeOverlay: {
    position: "absolute",
    right: 40,
    bottom: 60,
    backgroundColor: "rgba(0,0,0,0.8)",
    borderRadius: 8,
    padding: 15,
    width: 250,
  },
  nextEpisodeContent: {
    alignItems: "center",
  },
  nextEpisodeTitle: {
    fontSize: 16,
    fontWeight: "bold",
    marginBottom: 10,
  },
  nextEpisodeButtons: {
    flexDirection: "row",
    gap: 10,
  },
  nextEpisodeButton: {
    padding: 8,
    paddingHorizontal: 15,
  },
  nextEpisodeButtonText: {
    fontSize: 14,
  },
});
