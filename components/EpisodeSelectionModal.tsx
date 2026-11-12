import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, Modal, FlatList } from "react-native";
import { StyledButton } from "./StyledButton";
import usePlayerStore from "@/stores/playerStore";

export const EpisodeSelectionModal: React.FC = () => {
  // 按字段订阅：整库订阅会让它跟着每 0.5s 的 status 更新重渲染
  const showEpisodeModal = usePlayerStore((s) => s.showEpisodeModal);
  const episodes = usePlayerStore((s) => s.episodes);
  const currentEpisodeIndex = usePlayerStore((s) => s.currentEpisodeIndex);
  const playEpisode = usePlayerStore((s) => s.playEpisode);
  const setShowEpisodeModal = usePlayerStore((s) => s.setShowEpisodeModal);

  const [episodeGroupSize] = useState(30);
  const [selectedEpisodeGroup, setSelectedEpisodeGroup] = useState(Math.floor(currentEpisodeIndex / episodeGroupSize));

  // 打开弹窗时回到当前集所在的分组：这个 state 只在首次渲染时初始化，
  // 播到后面的集再打开弹窗会停留在旧分组，当前集不在列表里、也没有
  // hasTVPreferredFocus 的焦点，电视上焦点无处安放
  useEffect(() => {
    if (showEpisodeModal) {
      setSelectedEpisodeGroup(Math.floor(currentEpisodeIndex / episodeGroupSize));
    }
  }, [showEpisodeModal, currentEpisodeIndex, episodeGroupSize]);

  // 弹窗开着时换源导致总集数变少（如 100 集→10 集）：分组下标越界，
  // slice 出空列表、当前集不可见。集数变化时把分组钳到合法范围。
  useEffect(() => {
    const maxGroup = Math.max(0, Math.ceil(episodes.length / episodeGroupSize) - 1);
    if (selectedEpisodeGroup > maxGroup) {
      setSelectedEpisodeGroup(maxGroup);
    }
  }, [episodes.length, episodeGroupSize, selectedEpisodeGroup]);

  const onSelectEpisode = (index: number) => {
    playEpisode(index);
    setShowEpisodeModal(false);
  };

  const onClose = () => {
    setShowEpisodeModal(false);
  };

  return (
    <Modal visible={showEpisodeModal} transparent={true} animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalContainer}>
        <View style={styles.modalContent}>
          <Text style={styles.modalTitle}>选择剧集</Text>

          {episodes.length > episodeGroupSize && (
            <View style={styles.episodeGroupContainer}>
              {Array.from({ length: Math.ceil(episodes.length / episodeGroupSize) }, (_, groupIndex) => (
                <StyledButton
                  key={groupIndex}
                  text={`${groupIndex * episodeGroupSize + 1}-${Math.min(
                    (groupIndex + 1) * episodeGroupSize,
                    episodes.length
                  )}`}
                  onPress={() => setSelectedEpisodeGroup(groupIndex)}
                  isSelected={selectedEpisodeGroup === groupIndex}
                  style={styles.episodeGroupButton}
                  textStyle={styles.episodeGroupButtonText}
                />
              ))}
            </View>
          )}
          <FlatList
            data={episodes.slice(
              selectedEpisodeGroup * episodeGroupSize,
              (selectedEpisodeGroup + 1) * episodeGroupSize
            )}
            numColumns={5}
            contentContainerStyle={styles.episodeList}
            keyExtractor={(_, index) => `episode-${selectedEpisodeGroup * episodeGroupSize + index}`}
            renderItem={({ item, index }) => {
              const absoluteIndex = selectedEpisodeGroup * episodeGroupSize + index;
              return (
                <StyledButton
                  text={item.title || `第 ${absoluteIndex + 1} 集`}
                  onPress={() => onSelectEpisode(absoluteIndex)}
                  isSelected={currentEpisodeIndex === absoluteIndex}
                  hasTVPreferredFocus={currentEpisodeIndex === absoluteIndex}
                  style={styles.episodeItem}
                  textStyle={styles.episodeItemText}
                />
              );
            }}
          />
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalContainer: {
    flex: 1,
    flexDirection: "row",
    justifyContent: "flex-end",
    backgroundColor: "transparent",
  },
  modalContent: {
    width: 600,
    maxWidth: "100%",
    height: "100%",
    backgroundColor: "rgba(0, 0, 0, 0.85)",
    padding: 20,
  },
  modalTitle: {
    color: "white",
    marginBottom: 12,
    textAlign: "center",
    fontSize: 18,
    fontWeight: "bold",
  },
  episodeList: {
    justifyContent: "flex-start",
  },
  episodeItem: {
    paddingVertical: 2,
    margin: 4,
    width: "18%",
  },
  episodeItemText: {
    fontSize: 14,
  },
  episodeGroupContainer: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  episodeGroupButton: {
    paddingHorizontal: 6,
    margin: 8,
  },
  episodeGroupButtonText: {
    fontSize: 12,
  },
});
