import * as Clipboard from "expo-clipboard";
import { Ionicons } from "@expo/vector-icons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "@/theme";

export function MessageActionBar({
  content,
  onRetry,
  retryDisabled = false,
  prominentRetry = false,
}: {
  content: string;
  onRetry: () => void;
  retryDisabled?: boolean;
  prominentRetry?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await Clipboard.setStringAsync(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  };

  return (
    <View style={styles.bar}>
      <Pressable
        accessibilityLabel={copied ? "Copied" : "Copy assistant message"}
        accessibilityRole="button"
        onPress={() => void copy()}
        style={({ pressed }) => [styles.action, pressed && styles.pressed]}
      >
        <Ionicons name={copied ? "checkmark" : "copy-outline"} size={15} color={colors.textMuted} />
        <Text style={styles.actionText}>{copied ? "Copied" : "Copy"}</Text>
      </Pressable>
      <Pressable
        accessibilityLabel="Regenerate assistant message"
        accessibilityRole="button"
        disabled={retryDisabled}
        onPress={onRetry}
        style={({ pressed }) => [
          styles.action,
          prominentRetry && styles.prominentAction,
          retryDisabled && styles.disabled,
          pressed && !retryDisabled && styles.pressed,
        ]}
      >
        <Ionicons name="refresh-outline" size={15} color={prominentRetry ? colors.primary : colors.textMuted} />
        <Text style={[styles.actionText, prominentRetry && styles.prominentText]}>{retryDisabled ? "Working" : "Retry"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: spacing.md, marginTop: spacing.sm },
  action: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: spacing.xs, paddingHorizontal: spacing.xs },
  prominentAction: { paddingHorizontal: spacing.sm, borderWidth: 1, borderColor: colors.danger, borderRadius: 6 },
  actionText: { color: colors.textMuted, fontSize: 12, fontWeight: "600" },
  prominentText: { color: colors.danger },
  disabled: { opacity: 0.5 },
  pressed: { opacity: 0.65 },
});
