import type { Provider } from "@/types";

export interface RemoteModel {
  id: string;
  name: string;
}

const MODEL_LIST_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s]+$/i.test(normalized)) throw new Error("Model Base URL is invalid");
  return normalized;
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<Record<string, any>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { method: "GET", headers, signal: controller.signal });
    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error("The provider returned an unparseable model list");
    }
    if (!response.ok) {
      const detail = isRecord(data) && isRecord(data.error)
        ? data.error.message
        : isRecord(data) ? data.message : text;
      throw new Error(`${response.status}: ${detail || response.statusText}`);
    }
    if (!isRecord(data)) throw new Error("The provider's model list has an invalid format");
    return data;
  } catch (error) {
    if (isRecord(error) && error.name === "AbortError") throw new Error("Timed out while fetching the model list");
    if (error instanceof TypeError) throw new Error("Cannot reach the provider; check your network, Base URL and certificate");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function uniqueModels(models: RemoteModel[]): RemoteModel[] {
  const unique = new Map<string, RemoteModel>();
  for (const model of models) {
    if (model.id.trim()) unique.set(model.id, model);
  }
  return [...unique.values()].sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchProviderModels(provider: Provider, apiKey: string): Promise<RemoteModel[]> {
  if (!apiKey.trim()) throw new Error("The provider has no usable API key");
  const baseUrl = normalizeBaseUrl(provider.baseUrl);
  if (provider.type === "google-genai") {
    const data = await fetchJson(`${baseUrl}/models?pageSize=1000`, { "x-goog-api-key": apiKey });
    const models = Array.isArray(data.models) ? data.models : [];
    return uniqueModels(models.flatMap((item: unknown) => {
      if (!isRecord(item) || typeof item.name !== "string") return [];
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : [];
      if (!methods.includes("generateContent")) return [];
      const id = item.name.replace(/^models\//, "");
      return [{ id, name: typeof item.displayName === "string" ? item.displayName : id }];
    }));
  }
  if (provider.type === "anthropic") {
    const data = await fetchJson(`${baseUrl}/models?limit=1000`, {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    });
    const models = Array.isArray(data.data) ? data.data : [];
    return uniqueModels(models.flatMap((item: unknown) => {
      if (!isRecord(item) || typeof item.id !== "string") return [];
      return [{ id: item.id, name: typeof item.display_name === "string" ? item.display_name : item.id }];
    }));
  }
  const data = await fetchJson(`${baseUrl}/models`, { Authorization: `Bearer ${apiKey}` });
  const models = Array.isArray(data.data) ? data.data : [];
  return uniqueModels(models.flatMap((item: unknown) => {
    if (!isRecord(item) || typeof item.id !== "string") return [];
    return [{ id: item.id, name: typeof item.name === "string" ? item.name : item.id }];
  }));
}
