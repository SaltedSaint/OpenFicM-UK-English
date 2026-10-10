import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";

import type { RootStackParamList, RootTabParamList } from "@/navigation/types";
import { CharactersScreen } from "@/screens/characters-screen";
import { AssistantScreen } from "@/screens/assistant-screen";
import { ProjectsScreen } from "@/screens/projects-screen";
import { SettingsScreen } from "@/screens/settings-screen";
import { StyleLibraryScreen } from "@/screens/style-library-screen";
import { WritingScreen } from "@/screens/writing-screen";
import { NotesScreen } from "@/screens/notes-screen";
import { WorldInfoScreen } from "@/screens/world-info-screen";
import { colors } from "@/theme";
import { installMissingRuntimeResources, getRuntimeResourceState, type RuntimeResourceState } from "@/settings/remote-resources";
import { warmUpLocalModels } from "@/search/local-models";

const Tab = createBottomTabNavigator<RootTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

function MainTabs() {
  const insets = useSafeAreaInsets();

  return (
    <Tab.Navigator
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarActiveTintColor: colors.primary,
          tabBarInactiveTintColor: colors.textMuted,
          tabBarStyle: {
            backgroundColor: colors.surface,
            borderTopColor: colors.border,
            height: 58 + insets.bottom,
            paddingBottom: Math.max(insets.bottom, 5),
            paddingTop: 4,
          },
          tabBarHideOnKeyboard: true,
          tabBarLabelStyle: { fontSize: 11 },
          tabBarIcon: ({ color, size }) => {
            const icons: Record<keyof RootTabParamList, keyof typeof Ionicons.glyphMap> = {
              Projects: "library-outline",
              Writing: "create-outline",
              Assistant: "sparkles-outline",
              Settings: "settings-outline",
            };
            return <Ionicons name={icons[route.name]} color={color} size={size} />;
          },
        })}
      >
        <Tab.Screen name="Projects" component={ProjectsScreen} options={{ title: "Shelf" }} />
        <Tab.Screen name="Writing" component={WritingScreen} options={{ title: "Writing" }} />
        <Tab.Screen name="Assistant" component={AssistantScreen} options={{ title: "Assistant" }} />
        <Tab.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
    </Tab.Navigator>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <KeyboardProvider preserveEdgeToEdge>
        <RuntimeResourceGate />
      </KeyboardProvider>
    </SafeAreaProvider>
  );
}

function RuntimeResourceGate() {
  const [state, setState] = useState<RuntimeResourceState | null>(null);
  const [warmed, setWarmed] = useState(false);
  const [busy, setBusy] = useState(true);
  const [progress, setProgress] = useState("Checking runtime resources…");
  const [error, setError] = useState<string | null>(null);

  const checkAndWarm = useCallback(async () => {
    setBusy(true);
    setWarmed(false);
    setError(null);
    try {
      const next = await getRuntimeResourceState();
      setState(next);
      if (!next.ready) {
        setProgress("Some runtime resources are not installed yet");
        return;
      }
      setProgress("Warming up the local retrieval models…");
      await warmUpLocalModels();
      setWarmed(true);
      setProgress("Local retrieval models are ready");
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : String(checkError));
      setProgress("Runtime resource check failed");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void checkAndWarm();
  }, [checkAndWarm]);

  const download = async () => {
    setBusy(true);
    setWarmed(false);
    setError(null);
    setProgress("Preparing to fetch runtime resources…");
    try {
      const next = await installMissingRuntimeResources((item) => {
        if (item.totalBytes && item.totalBytes > 0 && item.bytesWritten !== undefined) {
          const percent = Math.min(100, Math.round(item.bytesWritten / item.totalBytes * 100));
          setProgress(`${item.label} · ${percent}%`);
        } else {
          setProgress(item.total > 1 ? `${item.label} · ${item.completed}/${item.total}` : item.label);
        }
      });
      setState(next);
      setProgress("Warming up the local retrieval models…");
      await warmUpLocalModels();
      setWarmed(true);
      setProgress("All runtime resources are ready");
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : String(downloadError));
      setProgress("Resource fetch did not finish; you can continue later");
      const next = await getRuntimeResourceState().catch(() => null);
      if (next) setState(next);
    } finally {
      setBusy(false);
    }
  };

  if (!state?.ready || !warmed) {
    const resourcesReady = state?.ready === true;
    return (
      <View style={styles.resourceGate}>
        <StatusBar style="dark" />
        <Text style={styles.resourceTitle}>{resourcesReady ? "Warm up local retrieval" : "Set up OpenFicM"}</Text>
        <Text style={styles.resourceSubtitle}>{resourcesReady ? "Runtime resources are complete; the embedding and rerank models must be loaded before entering the app." : "First use needs to download the agents, skills and local retrieval models."}</Text>
        <View style={styles.resourceList}>
          {(state?.missing ?? []).map((item) => (
            <View key={item.id} style={styles.resourceRow}>
              <View style={styles.resourceDot} />
              <View style={styles.resourceCopy}>
                <Text style={styles.resourceLabel}>{item.label}</Text>
                <Text style={styles.resourceDetail}>{item.detail}</Text>
              </View>
            </View>
          ))}
        </View>
        <Text style={styles.resourceProgress}>{error ?? progress}</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void (resourcesReady ? checkAndWarm() : download())} style={[styles.downloadButton, busy && styles.downloadButtonDisabled]}>
          {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={styles.downloadButtonText}>{resourcesReady ? "Warm up again" : "Fetch and warm up"}</Text>}
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void checkAndWarm()} style={styles.retryResourceButton}>
          <Text style={styles.retryResourceText}>Check again</Text>
        </Pressable>
      </View>
    );
  }

  if (busy) {
    return <View style={styles.resourceLoading}><StatusBar style="dark" /><ActivityIndicator size="large" color={colors.primary} /><Text style={styles.resourceProgress}>{progress}</Text></View>;
  }

  return (
    <NavigationContainer>
      <StatusBar style="dark" />
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="Main" component={MainTabs} />
        <Stack.Screen name="Characters" component={CharactersScreen} />
        <Stack.Screen name="WorldInfo" component={WorldInfoScreen} />
        <Stack.Screen name="Notes" component={NotesScreen} />
        <Stack.Screen name="StyleLibrary" component={StyleLibraryScreen} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  resourceGate: { flex: 1, justifyContent: "center", padding: 28, backgroundColor: colors.background },
  resourceLoading: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, backgroundColor: colors.background },
  resourceTitle: { color: colors.text, fontSize: 28, fontWeight: "800" },
  resourceSubtitle: { marginTop: 10, color: colors.textMuted, fontSize: 15, lineHeight: 22 },
  resourceList: { marginTop: 28, gap: 14 },
  resourceRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  resourceDot: { width: 9, height: 9, marginTop: 6, borderRadius: 5, backgroundColor: colors.primary },
  resourceCopy: { flex: 1, gap: 2 },
  resourceLabel: { color: colors.text, fontSize: 15, fontWeight: "700" },
  resourceDetail: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },
  resourceProgress: { marginTop: 24, color: colors.textMuted, fontSize: 13, lineHeight: 20 },
  downloadButton: { minHeight: 50, alignItems: "center", justifyContent: "center", marginTop: 20, borderRadius: 8, backgroundColor: colors.primary },
  downloadButtonDisabled: { opacity: 0.55 },
  downloadButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },
  retryResourceButton: { minHeight: 44, alignItems: "center", justifyContent: "center", marginTop: 8 },
  retryResourceText: { color: colors.primary, fontSize: 14, fontWeight: "700" },
});
