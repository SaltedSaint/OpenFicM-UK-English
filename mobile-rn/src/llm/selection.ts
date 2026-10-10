import {
  getProviderApiKey,
  getSetting,
  listModels,
  listProviders,
} from "@/data/repositories";
import type { ModelSelection } from "@/types";

export async function resolveModelSelection(modelId?: string | null): Promise<ModelSelection> {
  const [models, providers, activeModelId] = await Promise.all([
    listModels(),
    listProviders(),
    modelId === undefined ? getSetting("activeModelId") : Promise.resolve(modelId),
  ]);
  const normalizedModelId = activeModelId?.trim() || null;
  if (!normalizedModelId) throw new Error("Choose a default model in Settings first");
  const model = models.find((item) => item.id === normalizedModelId);
  if (!model) throw new Error("The selected model no longer exists; choose again");
  const provider = providers.find((item) => item.id === model.providerId);
  if (!provider) throw new Error("The model provider no longer exists; reconfigure it");
  const apiKey = await getProviderApiKey(provider);
  if (!apiKey) throw new Error(`${provider.name} has no usable API key; save it again`);
  return { model, provider, apiKey };
}
